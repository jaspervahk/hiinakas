// Resolves "the user's currently live Chinese Poker game(s)" on Huub, from
// the same three independent users/{uid} fields Huub's own
// components/layout/Navbar.tsx checks (handleReturnToGame /
// handleResumeReplayChallenge / handleResumeBotChallenge) — mirrored here
// exactly since Hiinakas can't import Huub's own frontend code (separate
// repo). currentGameId can point at a challenge doc (waiting/started) or
// directly at a game doc; activeReplayChallengeId/activeBotChallengeId
// always point at a challenge doc whose own replayCurrentGameId/
// botCurrentGameId tracks the live hand — those two deliberately never
// touch currentGameId (see Huub's replayBridge.ts / botChallengeServer.ts).
import { doc, getDoc } from 'firebase/firestore'
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

async function resolveFromCurrentGameId(currentGameId: string): Promise<string | null> {
  const challengeSnap = await getDoc(doc(huubDb, 'challenges', currentGameId))
  if (challengeSnap.exists()) {
    const data = challengeSnap.data() as { gameId?: string }
    return data.gameId ?? null // no gameId yet (still 'waiting') — nothing live to coach
  }
  // No challenge doc with this id — currentGameId points at a game doc directly.
  return currentGameId
}

async function resolveFromChallenge(challengeId: string, gameIdField: 'replayCurrentGameId' | 'botCurrentGameId'): Promise<string | null> {
  const challengeSnap = await getDoc(doc(huubDb, 'challenges', challengeId))
  if (!challengeSnap.exists()) return null
  const data = challengeSnap.data() as Record<string, unknown>
  const gameId = data[gameIdField]
  return typeof gameId === 'string' ? gameId : null
}

async function isLiveChinesePoker(gameId: string): Promise<boolean> {
  const gameSnap = await getDoc(doc(huubDb, 'games', gameId))
  if (!gameSnap.exists()) return false
  const data = gameSnap.data() as { status?: string; gameType?: string }
  return data.status === 'active' && data.gameType === 'chinese-poker'
}

/** Returns every currently-live Chinese Poker game the signed-in Huub user is playing. */
export async function findLiveHuubGames(uid: string): Promise<LiveHuubGameCandidate[]> {
  const userSnap = await getDoc(doc(huubDb, 'users', uid))
  if (!userSnap.exists()) return []
  const user = userSnap.data() as HuubUserDocLite

  const attempts: { source: LiveHuubGameCandidate['source']; resolve: () => Promise<string | null> }[] = []
  if (user.currentGameId) {
    attempts.push({ source: 'current', resolve: () => resolveFromCurrentGameId(user.currentGameId!) })
  }
  if (user.activeReplayChallengeId) {
    attempts.push({
      source: 'replayChallenge',
      resolve: () => resolveFromChallenge(user.activeReplayChallengeId!, 'replayCurrentGameId'),
    })
  }
  if (user.activeBotChallengeId) {
    attempts.push({
      source: 'botChallenge',
      resolve: () => resolveFromChallenge(user.activeBotChallengeId!, 'botCurrentGameId'),
    })
  }

  const resolved = await Promise.all(
    attempts.map(async a => ({ source: a.source, gameId: await a.resolve() }))
  )

  const candidates: LiveHuubGameCandidate[] = []
  for (const r of resolved) {
    if (!r.gameId) continue
    if (await isLiveChinesePoker(r.gameId)) {
      candidates.push({ gameId: r.gameId, source: r.source })
    }
  }
  return candidates
}
