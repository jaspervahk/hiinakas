// A leaner sibling of useCoach.ts for the Live Coach page: that hook is
// tightly coupled to Hiinakas's own single-player GameState reducer
// (buildInfoState(state: GameState)), but here the InfoState is already
// built directly from live Huub data by the caller. This hook keeps the
// same cancel-on-change/key-dedup pattern and the same CoachResult shape
// (so the existing CoachPanel/PlacementTable components can render it
// unmodified).
//
// Runs the literal 'heuristic' policy (brute-force MC rollout per
// candidate, no NN model) — this is NOT the app's technical default ('nn'),
// it's what the user actually runs Session Analysis with themselves (their
// own selected mode there), which is what "the same [policy] Session
// Analysis uses" turned out to mean. No model to load here, and no
// rootTopK — the heuristic policy has no NN-based candidate narrowing to
// configure, it evaluates every legal candidate.
//
// Unlike every other caller of streamMC, this asks for one large sims
// budget up front rather than a small fixed one, and relies on runMC
// (engine/mc.ts) already being a proper incremental generator — it
// accumulates rollout sums progressively across the *whole* requested
// budget and yields a batch of results every `batchSize` sims, all within
// one continuous computation. An earlier version of this hook instead
// looped, re-requesting a bigger-but-fresh computation each time a round
// finished — that matches how the NN/MCTS policy has to work (a single-shot
// search with no incremental resume), but for the heuristic policy it was
// actively harmful: every new round discarded all the sims already
// accumulated and restarted counting from zero, so most of the "unlimited
// sims" time was spent redoing already-finished work instead of making
// forward progress. That was the actual cause of it feeling slow.
//
// LARGE_ROLLOUT_BUDGET is generous rather than literally infinite: the
// worker's heuristic loop (engine.worker.ts) runs runMC's generator
// synchronously to completion once started — cancelling client-side only
// stops the UI from listening, it can't interrupt the worker mid-loop — so
// an unbounded budget left running after the user acts would sit blocking
// the next real position's analysis behind it.
import { useEffect, useRef, useState } from 'react'
import type { Card, InfoState, ScoredPlacement } from '../engine/index'
import { workerClient } from '../worker/client'
import type { CoachResult } from './useCoach'

const LARGE_ROLLOUT_BUDGET = 2000

function infoStateKey(s: InfoState): string {
  const cardKey = (c: Card) => `${c.rank}${c.suit}`
  const rowKey = (cards: readonly Card[]) => [...cards].map(cardKey).sort().join(',')
  const boardKey = [rowKey(s.board.top), rowKey(s.board.middle), rowKey(s.board.bottom)].join('|')
  const oppsKey = s.revealedOpponentBoards.map(b => [rowKey(b.top), rowKey(b.middle), rowKey(b.bottom)].join('|')).join(';')
  return `s${s.street}|${boardKey}|${rowKey(s.hand)}|${oppsKey}`
}

export function useLiveHuubCoach(info: InfoState | null): CoachResult {
  const [placements, setPlacements] = useState<ScoredPlacement[]>([])
  const [isComputing, setIsComputing] = useState(false)
  const [rolloutsDone, setRolloutsDone] = useState(0)

  const cancelRef = useRef<(() => void) | null>(null)
  const keyRef = useRef<string | null>(null)
  const key = info ? infoStateKey(info) : null

  useEffect(() => {
    if (cancelRef.current) {
      cancelRef.current()
      cancelRef.current = null
    }

    if (!key || !info) {
      keyRef.current = null
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPlacements([])
      setIsComputing(false)
      setRolloutsDone(0)
      return
    }

    keyRef.current = key
    setIsComputing(true)
    setRolloutsDone(0)

    const localKey = key
    const seed = Date.now() & 0xffffffff

    const onProgress = (results: ScoredPlacement[]) => {
      if (keyRef.current !== localKey) return
      setPlacements([...results].sort((a, b) => b.ev - a.ev))
      setRolloutsDone(results.reduce((m, r) => Math.max(m, r.n), 0))
    }
    const onDone = (results: ScoredPlacement[]) => {
      if (keyRef.current !== localKey) return
      setPlacements([...results].sort((a, b) => b.ev - a.ev))
      setRolloutsDone(results.reduce((m, r) => Math.max(m, r.n), 0))
      setIsComputing(false)
    }
    const onError = () => { if (keyRef.current === localKey) setIsComputing(false) }

    cancelRef.current = workerClient.streamMC(
      info,
      { totalRollouts: LARGE_ROLLOUT_BUDGET, batchSize: 10 },
      seed,
      onProgress,
      onDone,
      'heuristic',
      onError,
    )

    return () => {
      cancelRef.current?.()
      cancelRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return { placements, isComputing, rolloutsDone, totalRollouts: rolloutsDone, matchIndex: null }
}
