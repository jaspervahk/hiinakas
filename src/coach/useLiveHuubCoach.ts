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
// Unlike every other caller of streamMC, which asks for one fixed sims
// budget, this never settles: as long as this is still the live position
// (the user hasn't acted yet), it keeps re-running with a growing sims
// budget and streaming progressively refined results, stopping only when
// the position changes (new street, submitted, or navigated away).
import { useEffect, useRef, useState } from 'react'
import type { Card, InfoState, ScoredPlacement } from '../engine/index'
import { workerClient } from '../worker/client'
import type { CoachResult } from './useCoach'
import { DEFAULT_SIMS_FOR } from '../worker/botPolicyDefaults'

// Each round redoes the full brute-force search from scratch (no resumable/
// incremental rollout to build on) — but at a growing sims budget, so later
// rounds arrive at deeper, more accurate results, matching "unlimited sims."
const SIMS_GROWTH_FACTOR = 1.5

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
  // Tracks the best (highest) rollout count actually displayed for the
  // current key, so a later round's progress never regresses what's shown.
  const bestRolloutsRef = useRef(0)
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
    bestRolloutsRef.current = -1
    setIsComputing(true)
    setRolloutsDone(0)

    let stopped = false
    const localKey = key

    const applyIfNotRegressing = (results: ScoredPlacement[]) => {
      const n = results.reduce((m, r) => Math.max(m, r.n), 0)
      if (n < bestRolloutsRef.current) return
      bestRolloutsRef.current = n
      setPlacements([...results].sort((a, b) => b.ev - a.ev))
      setRolloutsDone(n)
    }

    // Runs one round at `totalRollouts`, then immediately kicks off a
    // larger round — forever, until the position changes or this effect is
    // torn down. isComputing intentionally never goes back to false while
    // this loop is alive: there's always a next, deeper round in flight.
    const runRound = (totalRollouts: number) => {
      if (stopped || keyRef.current !== localKey) return
      const seed = Date.now() & 0xffffffff

      const onProgress = (results: ScoredPlacement[]) => {
        if (keyRef.current !== localKey) return
        applyIfNotRegressing(results)
      }
      const onDone = (results: ScoredPlacement[]) => {
        if (keyRef.current !== localKey) return
        applyIfNotRegressing(results)
        runRound(Math.round(totalRollouts * SIMS_GROWTH_FACTOR))
      }
      const onError = () => { if (keyRef.current === localKey) setIsComputing(false) }

      cancelRef.current = workerClient.streamMC(
        info,
        { totalRollouts, batchSize: 10 },
        seed,
        onProgress,
        onDone,
        'heuristic',
        onError,
      )
    }

    runRound(DEFAULT_SIMS_FOR.heuristic)

    return () => {
      stopped = true
      cancelRef.current?.()
      cancelRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return { placements, isComputing, rolloutsDone, totalRollouts: rolloutsDone, matchIndex: null }
}
