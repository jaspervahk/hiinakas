import { useEffect, useMemo, useState } from 'react'
import { signInWithPopup, onAuthStateChanged, type User } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import type { AppPage } from '../App'
import type { BonusQualifier, InfoState, PartialBoard } from '../engine/index'
import { bestBonusBoard } from '../engine/index'
import { huubAuth, huubDb, huubGoogleProvider } from '../services/huubFirebase'
import { fromHuubBoard, fromHuubCard } from '../game/huubChallengeDetail'
import type { HuubBoard, HuubCard } from '../firestore/huubBridge'
import { useLiveHuubGames, type LiveHuubGameCandidate } from '../game/liveHuubGame'
import { useLiveHuubCoach } from '../coach/useLiveHuubCoach'
import { PlacementTable } from '../components/CoachPanel'
import { CardView } from '../components/CardView'

interface LiveCoachPageProps {
  onNavigate: (p: AppPage) => void
}

// Minimal slice of Huub's live game/hand doc shapes this page actually reads —
// mirrors src/types/index.ts's ChinesePokerState/GameDoc/PlayerHandDoc from the
// Huub repo (can't import those directly, separate repo/project). Confirmed
// against Huub's own backend (functions/src/chinesePokerServer.ts,
// runStartChinesePokerBonus/runSubmitChinesePokerTurn): entering bonus_play
// resets `boards`/`submissions`/`turn` and repopulates them for the side-game
// cohort only (bonusHandSizes keys are the one-shot-eligible players, kept
// out of `submissions` entirely and tracked via `bonusSubmitted` instead) —
// so the same field-reuse pattern normal_play already relies on carries over
// unchanged, no separate "side" fields needed.
interface HuubGamePlayer { uid: string; username: string; status: string }
interface HuubChinesePokerState {
  turn: number
  segment: 'normal_play' | 'normal_showdown' | 'bonus_play' | 'bonus_showdown' | 'done'
  boards: Record<string, HuubBoard>
  submissions: Record<string, boolean>
  bonusHandSizes?: Record<string, 13 | 14 | 15>
  bonusSubmitted?: Record<string, boolean>
  sideGameParticipantUids?: string[]
}
interface HuubGameDoc {
  players: HuubGamePlayer[]
  status: string
  gameType: string
  chinesePoker?: HuubChinesePokerState | null
}
interface HuubPlayerHandDoc {
  cards: HuubCard[]
}

const TIER_FROM_HAND_SIZE: Record<number, BonusQualifier> = { 13: 'QQ', 14: 'KK', 15: 'AA_OR_TRIPS' }

const SOURCE_LABEL: Record<LiveHuubGameCandidate['source'], string> = {
  current: 'Live game',
  replayChallenge: 'Replay challenge',
  botChallenge: 'Bot challenge',
}

function BoardRows({ board, label }: { board: PartialBoard; label: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-widest text-gray-500">{label}</span>
      {(['top', 'middle', 'bottom'] as const).map(row => (
        <div key={row} className="flex gap-1">
          {board[row].map((c, i) => <CardView key={i} card={c} size="sm" />)}
          {Array.from({ length: (row === 'top' ? 3 : 5) - board[row].length }).map((_, i) => (
            <CardView key={`empty-${i}`} size="sm" />
          ))}
        </div>
      ))}
    </div>
  )
}

export default function LiveCoachPage({ onNavigate }: LiveCoachPageProps) {
  const [user, setUser] = useState<User | null>(huubAuth.currentUser)
  const [signingIn, setSigningIn] = useState(false)
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null)
  const [game, setGame] = useState<HuubGameDoc | null>(null)
  const [playerHand, setPlayerHand] = useState<HuubPlayerHandDoc | null>(null)

  useEffect(() => onAuthStateChanged(huubAuth, setUser), [])

  const handleSignIn = async () => {
    setSigningIn(true)
    try {
      await signInWithPopup(huubAuth, huubGoogleProvider)
    } finally {
      setSigningIn(false)
    }
  }

  // Fully live (no polling): updates the moment a new game/challenge starts
  // on users/{uid}, or the moment an already-active challenge advances to
  // its next hand (that only touches the challenge doc, not users/{uid}).
  const candidates = useLiveHuubGames(user?.uid ?? null)

  useEffect(() => {
    if (!candidates) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (candidates.length === 1) { setSelectedGameId(candidates[0]!.gameId); return }
    if (selectedGameId && !candidates.some(c => c.gameId === selectedGameId)) setSelectedGameId(null)
  }, [candidates, selectedGameId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!selectedGameId) { setGame(null); return }
    const unsub = onSnapshot(doc(huubDb, 'games', selectedGameId), snap => {
      setGame(snap.exists() ? (snap.data() as HuubGameDoc) : null)
    })
    return unsub
  }, [selectedGameId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!selectedGameId || !user) { setPlayerHand(null); return }
    const wantsHand = game?.status === 'active'
      && (game.chinesePoker?.segment === 'normal_play' || game.chinesePoker?.segment === 'bonus_play')
    if (!wantsHand) { setPlayerHand(null); return }
    const unsub = onSnapshot(
      doc(huubDb, 'games', selectedGameId, 'playerHands', user.uid),
      snap => setPlayerHand(snap.exists() ? (snap.data() as HuubPlayerHandDoc) : null),
      () => setPlayerHand(null) // permission-denied is expected once the round ends
    )
    return unsub
  }, [selectedGameId, user, game?.status, game?.chinesePoker?.segment])

  // A bonus-eligible player's own hand size (13/14/15) is ground truth for
  // "am I in the one-shot bonus or the side game" — more robust than trusting
  // sideGameParticipantUids/bonusHandSizes membership lists to be internally
  // consistent with what was actually dealt (session-analysis's own bonus-role
  // derivation hit exactly this class of drift once, see sessionParser.ts).
  const oneShotRecommendation = useMemo(() => {
    if (!user || !game?.chinesePoker || game.chinesePoker.segment !== 'bonus_play' || !playerHand) return null
    const cp = game.chinesePoker
    if (cp.bonusSubmitted?.[user.uid] === true) return null
    const n = playerHand.cards.length
    if (n < 13) return null
    return bestBonusBoard(playerHand.cards.map(fromHuubCard), n - 13)
  }, [user, game, playerHand])

  const info: InfoState | null = useMemo(() => {
    if (!user || !game?.chinesePoker || !playerHand) return null
    const cp = game.chinesePoker

    if (cp.segment === 'normal_play') {
      if (cp.submissions[user.uid] === true) return null // already acted this street — nothing to recommend
      if (playerHand.cards.length === 0) return null
      return {
        board: fromHuubBoard(cp.boards[user.uid] ?? { top: [], middle: [], bottom: [] }),
        hand: playerHand.cards.map(fromHuubCard),
        street: cp.turn,
        revealedOpponentBoards: game.players
          .filter(p => p.uid !== user.uid)
          .map(p => fromHuubBoard(cp.boards[p.uid] ?? { top: [], middle: [], bottom: [] })),
      }
    }

    if (cp.segment === 'bonus_play') {
      const n = playerHand.cards.length
      if (n === 0 || n >= 13) return null // one-shot bonus (or already acted) — handled by oneShotRecommendation
      if (cp.submissions[user.uid] === true) return null // already acted this side-game street
      const sideParticipants = cp.sideGameParticipantUids ?? []
      // Bonus-eligible opponents play invisibly (info-set hygiene — their
      // real-time boards are never revealed to the side game) but still
      // score against this side game at showdown via their known tier.
      const invisibleBonusOpponents: BonusQualifier[] = Object.entries(cp.bonusHandSizes ?? {})
        .filter(([uid]) => uid !== user.uid)
        .map(([, size]) => TIER_FROM_HAND_SIZE[size])
      return {
        board: fromHuubBoard(cp.boards[user.uid] ?? { top: [], middle: [], bottom: [] }),
        hand: playerHand.cards.map(fromHuubCard),
        street: cp.turn,
        revealedOpponentBoards: game.players
          .filter(p => p.uid !== user.uid && sideParticipants.includes(p.uid))
          .map(p => fromHuubBoard(cp.boards[p.uid] ?? { top: [], middle: [], bottom: [] })),
        inBonusRound: true,
        invisibleBonusOpponents,
      }
    }

    return null
  }, [user, game, playerHand])

  const result = useLiveHuubCoach(info)

  const cp = game?.chinesePoker
  const notPlayable = !!cp && cp.segment !== 'normal_play' && cp.segment !== 'bonus_play'

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-800/80">
        <button onClick={() => onNavigate('game')} className="text-gray-500 hover:text-gray-300 text-sm transition-colors">
          ← Back
        </button>
        <span className="text-sm font-semibold text-gray-200">Live Coach</span>
        <span className="w-12" />
      </header>

      <div className="max-w-2xl mx-auto p-4 flex flex-col gap-4">
        {!user ? (
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-6 text-center">
            <p className="text-sm text-gray-400 mb-4">Sign in to Huub to analyze your live games here.</p>
            <button
              onClick={() => void handleSignIn()}
              disabled={signingIn}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
            >
              {signingIn ? 'Signing in…' : 'Sign in to Huub'}
            </button>
          </div>
        ) : candidates === null ? (
          <p className="text-sm text-gray-500">Looking for your live games…</p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-gray-500">No live Chinese Poker game found on Huub right now.</p>
        ) : candidates.length > 1 && !selectedGameId ? (
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
            <p className="text-xs text-gray-500 uppercase tracking-widest mb-2">You have more than one live game — pick one</p>
            <div className="flex flex-col gap-2">
              {candidates.map(c => (
                <button
                  key={c.gameId}
                  onClick={() => setSelectedGameId(c.gameId)}
                  className="text-left px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm text-gray-200"
                >
                  {SOURCE_LABEL[c.source]}
                </button>
              ))}
            </div>
          </div>
        ) : !game ? (
          <p className="text-sm text-gray-500">Loading game…</p>
        ) : (
          <>
            {candidates.length > 1 && (
              <button onClick={() => setSelectedGameId(null)} className="self-start text-xs text-gray-500 hover:text-gray-300">
                ← switch game
              </button>
            )}

            {cp && (
              <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-3 flex flex-wrap gap-6">
                {game.players.map(p => (
                  <BoardRows
                    key={p.uid}
                    label={p.uid === (huubAuth.currentUser?.uid ?? '') ? `${p.username} (you)` : p.username}
                    board={fromHuubBoard(cp.boards[p.uid] ?? { top: [], middle: [], bottom: [] })}
                  />
                ))}
              </div>
            )}

            {notPlayable ? (
              <p className="text-sm text-gray-500">
                No recommendation available for this phase yet ({cp!.segment.replace('_', ' ')}).
              </p>
            ) : oneShotRecommendation ? (
              <div className="rounded-xl border border-gray-700/60 bg-gray-900/70 p-3">
                <span className="text-[10px] uppercase tracking-widest text-gray-500">Recommended bonus board</span>
                <div className="mt-2">
                  <BoardRows board={oneShotRecommendation} label="Solved (max royalties)" />
                </div>
              </div>
            ) : !info ? (
              <p className="text-sm text-gray-500">Waiting for your turn…</p>
            ) : (
              <div className="rounded-xl border border-gray-700/60 bg-gray-900/70 p-3">
                <PlacementTable result={result} matchIndex={null} label="Heuristic" accentColor="text-teal-400" />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
