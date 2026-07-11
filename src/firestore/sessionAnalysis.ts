// Saved Session Analysis persistence — lets a computed session analysis
// (raw decisions + EV results) be saved as a named Firestore entry and
// reopened later with no re-upload and no recompute. Kept fully separate
// from the localStorage cache in SessionTab.tsx: that cache is a cheap,
// disposable, same-browser recompute-avoidance optimization; this is an
// explicit, durable, user-managed document the user consciously saves,
// browses, and deletes.
//
// A saved analysis is chunked across multiple documents to stay well under
// Firestore's 1 MiB per-document limit (~4,000 decisions/session would
// otherwise produce a single ~16-22MB document): one small metadata doc plus
// several decisionChunks/bonusChunks docs, each holding DECISIONS_PER_CHUNK
// entries (~385KB/chunk, ~37% of the limit).
//
// Write ordering avoids needing a true multi-doc transaction: all chunk docs
// are written first, the metadata doc last. listSavedAnalyses() only reads
// metadata docs, so a failure mid-save just leaves invisible orphaned chunk
// docs (negligible cost for a solo hobby app) rather than a half-visible,
// inconsistent analysis. Delete does the reverse (metadata first) so a
// saved analysis disappears from the list immediately.

import {
  doc, setDoc, getDoc, getDocs, deleteDoc, collection, query, orderBy, writeBatch, Timestamp,
} from 'firebase/firestore'
import { db, auth } from '../firebase'
import type { GameSummary } from '../game/sessionParser'
import type { ReviewDecision, PersistedBonusDecision, SavedAnalysisMeta } from '../game/sessionAnalysisTypes'
import type { BotPolicy } from '../worker/client'

export const DECISIONS_PER_CHUNK = 175
// Batched writes cap at 500 ops; keep well under that (and any single-batch
// byte-size comfort zone) by splitting chunk writes into groups this size.
const CHUNKS_PER_BATCH = 12

function uid(): string | null {
  return auth.currentUser?.uid ?? null
}

export function chunkArray<T>(arr: readonly T[], size: number): T[][] {
  if (arr.length === 0) return []
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

interface SaveInput {
  name: string
  summaries: GameSummary[]
  decisions: ReviewDecision[]
  bonusDecisions: PersistedBonusDecision[]
  playerNames: string[]
  analysisMode: BotPolicy
  sims: number
  rootTopK: number
}

export async function saveSessionAnalysis(input: SaveInput): Promise<string | null> {
  const u = uid()
  if (!u) return null
  try {
    const analysisId = crypto.randomUUID()
    const analysisRef = doc(db, 'users', u, 'savedAnalyses', analysisId)

    const decisionChunks = chunkArray(input.decisions, DECISIONS_PER_CHUNK)
    const bonusChunks = chunkArray(input.bonusDecisions, DECISIONS_PER_CHUNK)

    const decisionChunkDocs = decisionChunks.map((decisions, chunkIndex) => ({
      ref: doc(collection(analysisRef, 'decisionChunks'), String(chunkIndex)),
      data: { chunkIndex, decisions },
    }))
    const bonusChunkDocs = bonusChunks.map((bonusDecisions, chunkIndex) => ({
      ref: doc(collection(analysisRef, 'bonusChunks'), String(chunkIndex)),
      data: { chunkIndex, bonusDecisions },
    }))

    const allChunkDocs = [...decisionChunkDocs, ...bonusChunkDocs]
    for (const group of chunkArray(allChunkDocs, CHUNKS_PER_BATCH)) {
      const batch = writeBatch(db)
      for (const { ref, data } of group) batch.set(ref, data)
      await batch.commit()
    }

    const dateRangeStart = input.summaries[0]?.gameTime ?? ''
    const dateRangeEnd = input.summaries.at(-1)?.gameTime ?? ''
    const meta: Omit<SavedAnalysisMeta, 'createdAt'> & { createdAt: Timestamp } = {
      id: analysisId,
      schemaVersion: 1,
      name: input.name,
      createdAt: Timestamp.now(),
      playerNames: input.playerNames,
      gameCount: input.summaries.length,
      decisionCount: input.decisions.length,
      bonusDecisionCount: input.bonusDecisions.length,
      dateRangeStart,
      dateRangeEnd,
      analysisMode: input.analysisMode,
      sims: input.sims,
      rootTopK: input.rootTopK,
      decisionChunkCount: decisionChunks.length,
      bonusChunkCount: bonusChunks.length,
      summaries: input.summaries,
    }
    await setDoc(analysisRef, meta)

    return analysisId
  } catch (e) {
    console.error('saveSessionAnalysis failed', e)
    return null
  }
}

export async function listSavedAnalyses(): Promise<SavedAnalysisMeta[]> {
  const u = uid()
  if (!u) return []
  try {
    const col = collection(db, 'users', u, 'savedAnalyses')
    const q = query(col, orderBy('createdAt', 'desc'))
    const snap = await getDocs(q)
    const out: SavedAnalysisMeta[] = []
    snap.forEach(d => {
      const data = d.data()
      out.push({
        ...data,
        createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toMillis() : Date.now(),
      } as SavedAnalysisMeta)
    })
    return out
  } catch (e) {
    console.error('listSavedAnalyses failed', e)
    return []
  }
}

export async function loadSessionAnalysis(analysisId: string): Promise<{
  meta: SavedAnalysisMeta
  decisions: ReviewDecision[]
  bonusDecisions: PersistedBonusDecision[]
} | null> {
  const u = uid()
  if (!u) return null
  try {
    const analysisRef = doc(db, 'users', u, 'savedAnalyses', analysisId)
    const metaSnap = await getDoc(analysisRef)
    if (!metaSnap.exists()) return null
    const metaData = metaSnap.data()
    const meta: SavedAnalysisMeta = {
      ...metaData,
      createdAt: metaData.createdAt instanceof Timestamp ? metaData.createdAt.toMillis() : Date.now(),
    } as SavedAnalysisMeta

    const decisionChunkSnaps = await getDocs(collection(analysisRef, 'decisionChunks'))
    const decisionChunksByIndex = new Map<number, ReviewDecision[]>()
    decisionChunkSnaps.forEach(d => {
      const data = d.data() as { chunkIndex: number; decisions: ReviewDecision[] }
      decisionChunksByIndex.set(data.chunkIndex, data.decisions)
    })
    const decisions = [...decisionChunksByIndex.keys()].sort((a, b) => a - b)
      .flatMap(idx => decisionChunksByIndex.get(idx)!)

    const bonusChunkSnaps = await getDocs(collection(analysisRef, 'bonusChunks'))
    const bonusChunksByIndex = new Map<number, PersistedBonusDecision[]>()
    bonusChunkSnaps.forEach(d => {
      const data = d.data() as { chunkIndex: number; bonusDecisions: PersistedBonusDecision[] }
      bonusChunksByIndex.set(data.chunkIndex, data.bonusDecisions)
    })
    const bonusDecisions = [...bonusChunksByIndex.keys()].sort((a, b) => a - b)
      .flatMap(idx => bonusChunksByIndex.get(idx)!)

    return { meta, decisions, bonusDecisions }
  } catch (e) {
    console.error('loadSessionAnalysis failed', e)
    return null
  }
}

export async function deleteSessionAnalysis(analysisId: string): Promise<void> {
  const u = uid()
  if (!u) return
  try {
    const analysisRef = doc(db, 'users', u, 'savedAnalyses', analysisId)
    // Metadata first so it disappears from listSavedAnalyses() immediately,
    // even if a chunk delete below fails partway through.
    await deleteDoc(analysisRef)

    const decisionChunkSnaps = await getDocs(collection(analysisRef, 'decisionChunks'))
    const bonusChunkSnaps = await getDocs(collection(analysisRef, 'bonusChunks'))
    const allRefs = [...decisionChunkSnaps.docs, ...bonusChunkSnaps.docs].map(d => d.ref)
    for (const group of chunkArray(allRefs, CHUNKS_PER_BATCH)) {
      const batch = writeBatch(db)
      for (const ref of group) batch.delete(ref)
      await batch.commit()
    }
  } catch (e) {
    console.error('deleteSessionAnalysis failed', e)
  }
}

export async function renameSessionAnalysis(analysisId: string, name: string): Promise<void> {
  const u = uid()
  if (!u) return
  try {
    const analysisRef = doc(db, 'users', u, 'savedAnalyses', analysisId)
    await setDoc(analysisRef, { name }, { merge: true })
  } catch (e) {
    console.error('renameSessionAnalysis failed', e)
  }
}
