// Live (no-polling) resolution of "the user's currently live Chinese Poker
// game(s)" on Huub, from the same three independent users/{uid} fields
// Huub's own components/layout/Navbar.tsx checks (handleReturnToGame /
// handleResumeReplayChallenge / handleResumeBotChallenge) — mirrored here
// exactly since Hiinakas can't import Huub's own frontend code (separate
// repo). currentGameId can point at a challenge doc (waiting/started) or
// directly at a game doc; activeReplayChallengeId/activeBotChallengeId
// always point at a challenge doc whose own replayCurrentGameId/
// botCurrentGameId tracks the live hand — those two deliberately never
// touch currentGameId (see Huub's replayBridge.ts / botChallengeServer.ts).
//
// Everything here is a live onSnapshot chain, not a poll: starting a new
// game/challenge updates users/{uid} instantly, and — just as importantly —
// advancing to the next hand *within* an already-active challenge updates
// only the challenge doc's own botCurrentGameId/replayCurrentGameId, not
// users/{uid} at all, so that has to be subscribed live too or a mid-
// challenge hand change would never be detected without a manual refresh.
import { useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { huubDb } from '../services/huubFirebase'

export interface LiveHuubGameCandidate {
  gameId: string
  /** Why this candidate was found — shown in the picker if more than one is live at once. */
  source: 'current' | 'replayChallenge' | 'botChallenge'
}

interface HuubUserDocLite {
  currentGameId?: string | null
  activeReplayChallengeId?: string | null
  activeBotChallengeId?: string | null
}

async function isLiveChinesePoker(gameId: string): Promise<boolean> {
  const { getDoc } = await import('firebase/firestore')
  const gameSnap = await getDoc(doc(huubDb, 'games', gameId))
  if (!gameSnap.exists()) return false
  const data = gameSnap.data() as { status?: string; gameType?: string }
  return data.status === 'active' && data.gameType === 'chinese-poker'
}

/**
 * Subscribes to a single "live game pointer" source and reports the
 * resolved candidate (or null) every time anything along the chain changes.
 * `kind` picks which field on the challenge doc holds the live game id, or
 * 'current' for the special currentGameId dual-purpose resolution.
 */
function subscribeSource(
  source: LiveHuubGameCandidate['source'],
  pointerId: string,
  onChange: (candidate: LiveHuubGameCandidate | null) => void
): () => void {
  const gameIdField = source === 'replayChallenge' ? 'replayCurrentGameId' : 'botCurrentGameId'

  if (source !== 'current') {
    return onSnapshot(doc(huubDb, 'challenges', pointerId), async snap => {
      if (!snap.exists()) { onChange(null); return }
      const gameId = (snap.data() as Record<string, unknown>)[gameIdField]
      if (typeof gameId !== 'string') { onChange(null); return }
      onChange((await isLiveChinesePoker(gameId)) ? { gameId, source } : null)
    })
  }

  // currentGameId: could be a challenge doc (waiting/started) or a game doc
  // directly — try the challenge doc live; if it doesn't exist, fall back to
  // treating pointerId as a game id directly (also live).
  let innerUnsub: (() => void) | null = null
  const outerUnsub = onSnapshot(doc(huubDb, 'challenges', pointerId), snap => {
    innerUnsub?.(); innerUnsub = null
    if (snap.exists()) {
      const gameId = (snap.data() as { gameId?: string }).gameId
      if (!gameId) { onChange(null); return }
      innerUnsub = onSnapshot(doc(huubDb, 'games', gameId), gsnap => {
        if (!gsnap.exists()) { onChange(null); return }
        const data = gsnap.data() as { status?: string; gameType?: string }
        onChange(data.status === 'active' && data.gameType === 'chinese-poker' ? { gameId, source } : null)
      })
      return
    }
    innerUnsub = onSnapshot(doc(huubDb, 'games', pointerId), gsnap => {
      if (!gsnap.exists()) { onChange(null); return }
      const data = gsnap.data() as { status?: string; gameType?: string }
      onChange(data.status === 'active' && data.gameType === 'chinese-poker' ? { gameId: pointerId, source } : null)
    })
  })
  return () => { innerUnsub?.(); outerUnsub() }
}

/** Live list of every currently-live Chinese Poker game the given Huub user is playing — updates automatically, no refresh/polling needed. */
export function useLiveHuubGames(uid: string | null): LiveHuubGameCandidate[] | null {
  const [byUserField, setByUserField] = useState<HuubUserDocLite | null>(null)
  const [results, setResults] = useState<Record<string, LiveHuubGameCandidate | null>>({})

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!uid) { setByUserField(null); return }
    return onSnapshot(doc(huubDb, 'users', uid), snap => {
      setByUserField(snap.exists() ? (snap.data() as HuubUserDocLite) : null)
    })
  }, [uid])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!byUserField) { setResults({}); return }
    const unsubs: (() => void)[] = []
    const nextKeys = new Set<string>()

    const attach = (key: string, source: LiveHuubGameCandidate['source'], pointerId: string) => {
      nextKeys.add(key)
      unsubs.push(subscribeSource(source, pointerId, candidate => {
        setResults(prev => ({ ...prev, [key]: candidate }))
      }))
    }
    if (byUserField.currentGameId) attach('current', 'current', byUserField.currentGameId)
    if (byUserField.activeReplayChallengeId) attach('replayChallenge', 'replayChallenge', byUserField.activeReplayChallengeId)
    if (byUserField.activeBotChallengeId) attach('botChallenge', 'botChallenge', byUserField.activeBotChallengeId)

    setResults(prev => {
      const next: typeof prev = {}
      for (const k of nextKeys) next[k] = prev[k] ?? null
      return next
    })

    return () => { for (const u of unsubs) u() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byUserField?.currentGameId, byUserField?.activeReplayChallengeId, byUserField?.activeBotChallengeId])

  if (!byUserField) return uid ? null : []
  return Object.values(results).filter((c): c is LiveHuubGameCandidate => c !== null)
}
