// A leaner sibling of useCoach.ts for the Live Coach page: that hook is
// tightly coupled to Hiinakas's own single-player GameState reducer
// (buildInfoState(state: GameState)), but here the InfoState is already
// built directly from live Huub data by the caller. This hook keeps the
// same cancel-on-change/key-dedup pattern and the same CoachResult shape
// (so the existing CoachPanel/PlacementTable components can render it
// unmodified), but adds the model-loading guarantee AnalyzerPage.tsx now
// has, uses the same rootTopK candidate pool as Session Analysis
// (botPolicyDefaults.ts — the shared canonical "best policy" parameters,
// same ones the live in-game EV Coach panel uses), and — unlike every other
// caller of streamMC, which asks for one fixed sims budget — never settles:
// as long as this is still the live position (the user hasn't acted yet),
// it keeps re-running MCTS with a growing sims budget and streaming
// progressively refined results, stopping only when the position changes
// (new street, submitted, or navigated away).
import { useEffect, useRef, useState } from 'react'
import type { Card, InfoState, ScoredPlacement } from '../engine/index'
import { workerClient, MODEL_URLS } from '../worker/client'
import type { CoachResult } from './useCoach'
import { DEFAULT_ROOT_TOP_K, DEFAULT_SIMS_FOR } from '../worker/botPolicyDefaults'

// Each round is a fresh MCTS search (the engine has no resumable/incremental
// search to build on), so growing rounds redo earlier work — but arrive at
// deeper, more accurate results each time, matching "unlimited sims."
const SIMS_GROWTH_FACTOR = 1.5

function infoStateKey(s: InfoState): string {
  const cardKey = (c: Card) => `${c.rank}${c.suit}`
  const rowKey = (cards: readonly Card[]) => [...cards].map(cardKey).sort().join(',')
  const boardKey = [rowKey(s.board.top), rowKey(s.board.middle), rowKey(s.board.bottom)].join('|')
  const oppsKey = s.revealedOpponentBoards.map(b => [rowKey(b.top), rowKey(b.middle), rowKey(b.bottom)].join('|')).join(';')
  return `s${s.street}|${boardKey}|${rowKey(s.hand)}|${oppsKey}`
}

export function useLiveHuubCoach(info: InfoState | null): CoachResult & { noModel: boolean } {
  const [placements, setPlacements] = useState<ScoredPlacement[]>([])
  const [isComputing, setIsComputing] = useState(false)
  const [rolloutsDone, setRolloutsDone] = useState(0)
  const [noModel, setNoModel] = useState(false)

  const cancelRef = useRef<(() => void) | null>(null)
  const keyRef = useRef<string | null>(null)
  const key = info ? infoStateKey(info) : null

  useEffect(() => {
    if (cancelRef.current) {
      cancelRef.current()
      cancelRef.current = null
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNoModel(false)

    if (!key || !info) {
      keyRef.current = null
      setPlacements([])
      setIsComputing(false)
      setRolloutsDone(0)
      return
    }

    keyRef.current = key
    setIsComputing(true)
    setRolloutsDone(0)

    let stopped = false
    const localKey = key

    // Runs one MCTS round at `totalRollouts`, then immediately kicks off a
    // larger round — forever, until the position changes or this effect is
    // torn down. isComputing intentionally never goes back to false while
    // this loop is alive: there's always a next, deeper round in flight.
    const runRound = (totalRollouts: number) => {
      if (stopped || keyRef.current !== localKey) return
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
        runRound(Math.round(totalRollouts * SIMS_GROWTH_FACTOR))
      }
      const onError = () => { if (keyRef.current === localKey) setIsComputing(false) }

      cancelRef.current = workerClient.streamMC(
        info,
        { totalRollouts, batchSize: 10 },
        seed,
        onProgress,
        onDone,
        'nn',
        onError,
        DEFAULT_ROOT_TOP_K,
      )
    }

    void (async () => {
      const loaded = await workerClient.loadModel(MODEL_URLS.v2)
      if (stopped || keyRef.current !== localKey) return
      if (!loaded) {
        setNoModel(true)
        setIsComputing(false)
        return
      }
      runRound(DEFAULT_SIMS_FOR.nn)
    })()

    return () => {
      stopped = true
      cancelRef.current?.()
      cancelRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return { placements, isComputing, rolloutsDone, totalRollouts: rolloutsDone, matchIndex: null, noModel }
}
