import { useEffect, useRef, useState } from 'react'
import type { Card, InfoState, ScoredPlacement, PartialBoard } from '../engine/index'
import type { GameState, PendingRows } from '../game/types'
import { workerClient } from '../worker/client'

export interface CoachResult {
  placements: ScoredPlacement[]   // sorted best first
  isComputing: boolean
  rolloutsDone: number
  totalRollouts: number
  matchIndex: number | null        // index in placements that matches current pending
}

function sameCard(a: Card, b: Card): boolean {
  return a.rank === b.rank && a.suit === b.suit
}

// Compare two unordered card arrays (multisets).
function sameUnordered(a: readonly Card[], b: readonly Card[]): boolean {
  if (a.length !== b.length) return false
  const used = new Array<boolean>(b.length).fill(false)
  for (const c of a) {
    let found = false
    for (let i = 0; i < b.length; i++) {
      if (!used[i] && sameCard(c, b[i]!)) { used[i] = true; found = true; break }
    }
    if (!found) return false
  }
  return true
}

function buildInfoState(state: GameState): InfoState | null {
  if (state.phase !== 'placing') return null

  if (state.context === 'normal') {
    const hand = state.preDealt[0]?.[state.street]
    if (!hand || hand.length === 0) return null
    return {
      board: state.humanBoard,
      hand,
      street: state.street,
      revealedOpponentBoards: state.botBoards,
    }
  }

  // side context (human is in the side game ⇔ no qualifier for human)
  if (state.humanBonusQualifier !== null) return null
  const sideHand = state.sidePreDealt[0]?.[state.sideStreet]
  if (!sideHand || sideHand.length === 0) return null
  // For side game info-set, opponents are the bots that are *also* in the side game.
  // Qualifying bots have already revealed their bonus board (treat as revealed),
  // non-qualifying bots reveal their side board progressively.
  const oppBoards: PartialBoard[] = state.botBonusQualifiers.map((q, i) =>
    q ? state.botBonusBoards[i]! : state.botSideBoards[i]!
  )
  return {
    board: state.humanSideBoard,
    hand: sideHand,
    street: state.sideStreet,
    revealedOpponentBoards: oppBoards,
  }
}

function findMatchIndex(placements: readonly ScoredPlacement[], pending: PendingRows): number | null {
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i]!.placement
    if (
      sameUnordered(p.topAdd, pending.top) &&
      sameUnordered(p.middleAdd, pending.middle) &&
      sameUnordered(p.bottomAdd, pending.bottom)
    ) return i
  }
  return null
}

function infoStateKey(s: InfoState): string {
  const cardKey = (c: Card) => `${c.rank}${c.suit}`
  const rowKey = (cards: readonly Card[]) =>
    [...cards].map(cardKey).sort().join(',')
  const handKey = rowKey(s.hand)
  const boardKey = [rowKey(s.board.top), rowKey(s.board.middle), rowKey(s.board.bottom)].join('|')
  const oppsKey = s.revealedOpponentBoards
    .map(b => [rowKey(b.top), rowKey(b.middle), rowKey(b.bottom)].join('|'))
    .join(';')
  return `s${s.street}|${boardKey}|${handKey}|${oppsKey}`
}

export function useCoach(state: GameState, enabled: boolean, rollouts = 200): CoachResult {
  const [placements, setPlacements] = useState<ScoredPlacement[]>([])
  const [isComputing, setIsComputing] = useState(false)
  const [rolloutsDone, setRolloutsDone] = useState(0)

  const cancelRef = useRef<(() => void) | null>(null)
  const keyRef = useRef<string | null>(null)

  // Build key from state for change detection
  const info = enabled ? buildInfoState(state) : null
  const key = info ? infoStateKey(info) + `|r${rollouts}` : null

  useEffect(() => {
    if (cancelRef.current) {
      cancelRef.current()
      cancelRef.current = null
    }

    if (!key || !info) {
      keyRef.current = null
      // Defer to next tick so we update state without causing cascading sync renders.
      const t = setTimeout(() => {
        setPlacements([])
        setIsComputing(false)
        setRolloutsDone(0)
      }, 0)
      return () => clearTimeout(t)
    }

    keyRef.current = key
    const startT = setTimeout(() => {
      setPlacements([])
      setIsComputing(true)
      setRolloutsDone(0)
    }, 0)

    const seed = (state.seed ^ (state.street * 31 + state.sideStreet * 17 + (state.context === 'side' ? 1 : 0))) | 0
    const localKey = key

    const onProgress = (results: ScoredPlacement[]) => {
      if (keyRef.current !== localKey) return
      const sorted = [...results].sort((a, b) => b.ev - a.ev)
      setPlacements(sorted)
      const n = results[0]?.n ?? 0
      setRolloutsDone(n)
    }
    const onDone = (results: ScoredPlacement[]) => {
      if (keyRef.current !== localKey) return
      const sorted = [...results].sort((a, b) => b.ev - a.ev)
      setPlacements(sorted)
      const n = results[0]?.n ?? rollouts
      setRolloutsDone(n)
      setIsComputing(false)
    }

    const cancel = workerClient.streamMC(
      info,
      { totalRollouts: rollouts, batchSize: Math.max(5, Math.floor(rollouts / 20)) },
      seed,
      onProgress,
      onDone,
    )
    cancelRef.current = cancel

    return () => {
      clearTimeout(startT)
      cancel()
      cancelRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const matchIndex = placements.length > 0 ? findMatchIndex(placements, state.pending) : null

  return {
    placements,
    isComputing,
    rolloutsDone,
    totalRollouts: rollouts,
    matchIndex,
  }
}
