import {
  doc, setDoc, getDoc, collection, query, orderBy, limit as fbLimit, getDocs,
  increment, Timestamp,
} from 'firebase/firestore'
import { db, auth } from '../firebase'
import type { HandLog, AppSettings } from '../game/types'

export interface SessionStats {
  handsPlayed: number
  netScore: number
  totalEvLoss: number
  foulCount: number
  royaltyEarned: number
  scoopCount: number
  avgEvLoss?: number
}

function uid(): string | null {
  return auth.currentUser?.uid ?? null
}

function isScoop(score: number): boolean { return score >= 6 }

export async function saveHand(log: HandLog): Promise<void> {
  const u = uid()
  if (!u) return
  try {
    const handDoc = doc(db, 'users', u, 'hands', log.id)
    await setDoc(handDoc, {
      ...log,
      savedAt: Timestamp.now(),
    })

    const sessionRef = doc(db, 'users', u, 'sessions', 'current')
    const humanNet = log.totalScores[0] ?? 0
    const humanNormal = log.normalScores[0] ?? 0
    await setDoc(sessionRef, {
      handsPlayed: increment(1),
      netScore: increment(humanNet),
      totalEvLoss: increment(log.cumEvLoss),
      foulCount: increment(log.humanFouled ? 1 : 0),
      royaltyEarned: increment(log.humanRoyalties),
      scoopCount: increment(isScoop(humanNormal) ? 1 : 0),
      updatedAt: Timestamp.now(),
    }, { merge: true })
  } catch (e) {
    console.error('saveHand failed', e)
  }
}

export async function getRecentHands(maxN = 10): Promise<HandLog[]> {
  const u = uid()
  if (!u) return []
  try {
    const handsCol = collection(db, 'users', u, 'hands')
    const q = query(handsCol, orderBy('timestamp', 'desc'), fbLimit(maxN))
    const snap = await getDocs(q)
    const out: HandLog[] = []
    snap.forEach(d => {
      const data = d.data() as HandLog
      out.push(data)
    })
    return out
  } catch (e) {
    console.error('getRecentHands failed', e)
    return []
  }
}

export async function getSessionStats(): Promise<SessionStats | null> {
  const u = uid()
  if (!u) return null
  try {
    const sessionRef = doc(db, 'users', u, 'sessions', 'current')
    const snap = await getDoc(sessionRef)
    if (!snap.exists()) return null
    const data = snap.data() as Partial<SessionStats>
    const handsPlayed = data.handsPlayed ?? 0
    const totalEvLoss = data.totalEvLoss ?? 0
    return {
      handsPlayed,
      netScore: data.netScore ?? 0,
      totalEvLoss,
      foulCount: data.foulCount ?? 0,
      royaltyEarned: data.royaltyEarned ?? 0,
      scoopCount: data.scoopCount ?? 0,
      avgEvLoss: handsPlayed > 0 ? totalEvLoss / handsPlayed : 0,
    }
  } catch (e) {
    console.error('getSessionStats failed', e)
    return null
  }
}

export async function saveSettings(s: AppSettings): Promise<void> {
  const u = uid()
  if (!u) return
  try {
    const ref = doc(db, 'users', u, 'settings', 'prefs')
    await setDoc(ref, { ...s, updatedAt: Timestamp.now() }, { merge: true })
  } catch (e) {
    console.error('saveSettings failed', e)
  }
}

export async function loadSettings(): Promise<AppSettings | null> {
  const u = uid()
  if (!u) return null
  try {
    const ref = doc(db, 'users', u, 'settings', 'prefs')
    const snap = await getDoc(ref)
    if (!snap.exists()) return null
    const data = snap.data() as Partial<AppSettings>
    if (
      typeof data.coachEnabled === 'boolean' &&
      (data.playerCount === 2 || data.playerCount === 3)
    ) {
      return {
        coachEnabled: data.coachEnabled,
        playerCount: data.playerCount,
        botPolicy: data.botPolicy ?? 'nn',
        coachMode: data.coachMode ?? 'nn',
      }
    }
    return null
  } catch (e) {
    console.error('loadSettings failed', e)
    return null
  }
}
