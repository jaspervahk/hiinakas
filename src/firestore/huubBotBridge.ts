import { httpsCallable } from 'firebase/functions'
import { collection, getDocs, orderBy, query, Timestamp } from 'firebase/firestore'
import { db, functions, auth } from '../firebase'

export interface SentBotChallenge {
  id: string
  huubChallengeId: string
  huubUsername: string
  sims: number
  totalHands: number
  createdAt: number
}

export interface BotChallengeHandResult {
  index: number
  resultGameId: string | null
  points: number
  completedAt: number | null
}

export interface BotChallengeStatus {
  status: 'pending_join' | 'in_progress' | 'finished' | 'cancelled'
  currentIndex: number
  totalHands: number
  currentGameId: string | null
  targetUsername: string
  sims: number
  handResults: BotChallengeHandResult[]
}

interface CreateResponse { id: string; huubChallengeId: string }

export async function createHuubBotChallenge(
  targetUsername: string,
  sims: number,
  totalHands: number,
): Promise<CreateResponse> {
  const fn = httpsCallable<
    { targetUsername: string; sims: number; totalHands: number },
    CreateResponse
  >(functions, 'createHuubBotChallenge')
  const res = await fn({ targetUsername, sims, totalHands })
  return res.data
}

export async function getHuubBotChallengeStatus(huubChallengeId: string): Promise<BotChallengeStatus> {
  const fn = httpsCallable<{ huubChallengeId: string }, BotChallengeStatus>(
    functions, 'getHuubBotChallengeStatus',
  )
  const res = await fn({ huubChallengeId })
  return res.data
}

export async function cancelHuubBotChallenge(id: string): Promise<void> {
  const fn = httpsCallable<{ id: string }, { success: boolean }>(functions, 'cancelHuubBotChallenge')
  await fn({ id })
}

export async function listSentBotChallenges(): Promise<SentBotChallenge[]> {
  if (!auth.currentUser) return []
  try {
    const col = collection(db, 'botChallenges')
    const q = query(col, orderBy('createdAt', 'desc'))
    const snap = await getDocs(q)
    return snap.docs.map(d => {
      const data = d.data()
      return {
        id: d.id,
        huubChallengeId: data.huubChallengeId as string,
        huubUsername: data.huubUsername as string,
        sims: (data.sims as number | undefined) ?? 0,
        totalHands: (data.totalHands as number | undefined) ?? 0,
        createdAt: (data.createdAt as Timestamp | undefined)?.toMillis() ?? 0,
      }
    })
  } catch (e) {
    console.error('listSentBotChallenges failed', e)
    return []
  }
}
