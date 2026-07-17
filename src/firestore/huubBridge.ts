import { httpsCallable } from 'firebase/functions'
import { collection, getDocs, orderBy, query, Timestamp } from 'firebase/firestore'
import { db, functions, auth } from '../firebase'
import type { ChallengeHandInput } from '../game/huubBridge'

export interface SentChallenge {
  id: string
  huubChallengeId: string
  huubUsername: string
  sessionName: string
  createdAt: number
  sourceGameIds: string[]
}

export interface HuubReplayHandStatus {
  index: number
  historicalTotal: number
  resultGameId: string | null
  resultCumulativePoints: number | null
  resultCompletedAt: number | null
}

export interface HuubChallengeStatus {
  status: 'pending_join' | 'in_progress' | 'finished'
  currentIndex: number
  totalHands: number
  currentGameId: string | null
  targetUsername: string
  hands: HuubReplayHandStatus[]
}

interface CreateResponse { id: string; huubChallengeId: string }

export async function createHuubChallenge(
  targetUsername: string,
  sessionName: string,
  hands: ChallengeHandInput[],
): Promise<CreateResponse> {
  const fn = httpsCallable<
    { targetUsername: string; sessionName: string; hands: ChallengeHandInput[] },
    CreateResponse
  >(functions, 'createHuubReplayChallenge')
  const res = await fn({ targetUsername, sessionName, hands })
  return res.data
}

export async function getHuubChallengeStatus(huubChallengeId: string): Promise<HuubChallengeStatus> {
  const fn = httpsCallable<{ huubChallengeId: string }, HuubChallengeStatus>(
    functions, 'getHuubReplayChallengeStatus',
  )
  const res = await fn({ huubChallengeId })
  return res.data
}

export async function listSentChallenges(): Promise<SentChallenge[]> {
  if (!auth.currentUser) return []
  try {
    const col = collection(db, 'replayChallenges')
    const q = query(col, orderBy('createdAt', 'desc'))
    const snap = await getDocs(q)
    return snap.docs.map(d => {
      const data = d.data()
      return {
        id: d.id,
        huubChallengeId: data.huubChallengeId as string,
        huubUsername: data.huubUsername as string,
        sessionName: (data.sessionName as string | undefined) ?? '',
        createdAt: (data.createdAt as Timestamp | undefined)?.toMillis() ?? 0,
        sourceGameIds: (data.sourceGameIds as string[] | undefined) ?? [],
      }
    })
  } catch (e) {
    console.error('listSentChallenges failed', e)
    return []
  }
}
