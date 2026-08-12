// A leaner sibling of useCoach.ts for the Live Coach page: that hook is
// tightly coupled to Hiinakas's own single-player GameState reducer
// (buildInfoState(state: GameState)), but here the InfoState is already
// built directly from live Huub data by the caller. This hook keeps the
// same cancel-on-change/key-dedup pattern and the same CoachResult shape
// (so the existing CoachPanel component can render it unmodified), but adds
// the model-loading guarantee AnalyzerPage.tsx now has — useCoach itself
// doesn't force-load the model, relying on the app-wide startup preload
// instead, which is fine for a page you navigate to after the app's been
// open a moment, but this page can be the very first thing you look at.
import { useEffect, useRef, useState } from 'react'
import type { Card, InfoState, ScoredPlacement } from '../engine/index'
import { workerClient, MODEL_URLS } from '../worker/client'
import type { CoachResult } from './useCoach'

function infoStateKey(s: InfoState): string {
  const cardKey = (c: Card) => `${c.rank}${c.suit}`
  const rowKey = (cards: readonly Card[]) => [...cards].map(cardKey).sort().join(',')
  const boardKey = [rowKey(s.board.top), rowKey(s.board.middle), rowKey(s.board.bottom)].join('|')
  const oppsKey = s.revealedOpponentBoards.map(b => [rowKey(b.top), rowKey(b.middle), rowKey(b.bottom)].join('|')).join(';')
  return `s${s.street}|${boardKey}|${rowKey(s.hand)}|${oppsKey}`
}

export function useLiveHuubCoach(info: InfoState | null, rollouts = 2000): CoachResult & { noModel: boolean } {
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

    let cancelled = false
    const localKey = key

    void (async () => {
      const loaded = await workerClient.loadModel(MODEL_URLS.v2)
      if (cancelled || keyRef.current !== localKey) return
      if (!loaded) {
        setNoModel(true)
        setIsComputing(false)
        return
      }

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
        { totalRollouts: rollouts, batchSize: 10 },
        seed,
        onProgress,
        onDone,
        'nn',
        onError,
      )
    })()

    return () => {
      cancelled = true
      cancelRef.current?.()
      cancelRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return { placements, isComputing, rolloutsDone, totalRollouts: rollouts, matchIndex: null, noModel }
}
