import { useEffect, useRef, useState } from 'react'
import type { Card, InfoState, ScoredPlacement, PartialBoard } from '../engine/index'
import type { GameState, PendingRows } from '../game/types'
import { workerClient, royaltyWorkerClient } from '../worker/client'
import type { BotPolicy } from '../worker/client'

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

// Derive the actor's own discards from dealt history vs placed cards.
// On streets 1..upToStreet-1, the one card dealt but not placed is the discard.
function deriveDiscards(dealtPerStreet: Card[][], board: PartialBoard, upToStreet: number): Card[] {
  const placed = new Set([...board.top, ...board.middle, ...board.bottom].map(c => `${c.rank}${c.suit}`))
  const discards: Card[] = []
  for (let s = 1; s < upToStreet; s++) {
    const dealt = dealtPerStreet[s]
    if (!dealt) continue
    for (const c of dealt) {
      if (!placed.has(`${c.rank}${c.suit}`)) {
        discards.push(c)
        break  // exactly 1 discard per street
      }
    }
  }
  return discards
}

function buildInfoState(state: GameState): InfoState | null {
  if (state.phase !== 'placing') return null

  if (state.context === 'normal') {
    const hand = state.preDealt[0]?.[state.street]
    if (!hand || hand.length === 0) return null
    const discards = deriveDiscards(state.preDealt[0]!, state.humanBoard, state.street)
    return {
      board: state.humanBoard,
      hand,
      street: state.street,
      revealedOpponentBoards: state.botBoards,
      discards,
    }
  }

  if (state.humanBonusQualifier !== null) return null
  const sideHand = state.sidePreDealt[0]?.[state.sideStreet]
  if (!sideHand || sideHand.length === 0) return null
  // Bonus players play in complete isolation (they see no opponent boards).
  // Side-game players see each other but never see bonus players' boards.
  // Exclude bonus-qualified bots; include only non-qualifying bots via botSideBoards.
  const oppBoards: PartialBoard[] = state.botBonusQualifiers
    .map((q, i) => q ? null : state.botSideBoards[i]!)
    .filter((b): b is PartialBoard => b !== null)
  const discards = deriveDiscards(state.sidePreDealt[0]!, state.humanSideBoard, state.sideStreet)
  return {
    board: state.humanSideBoard,
    hand: sideHand,
    street: state.sideStreet,
    revealedOpponentBoards: oppBoards,
    discards,
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
  const discardKey = s.discards ? rowKey(s.discards) : ''
  return `s${s.street}|${boardKey}|${handKey}|${oppsKey}|d${discardKey}`
}

// `enabled` only controls the panel's visibility — computation always runs so that
// results are ready instantly when the panel is shown, and are preserved while hidden.
export function useCoach(state: GameState, _enabled: boolean, rollouts = 200, policy: BotPolicy = 'nn', disabled = false): CoachResult {
  const [placements, setPlacements] = useState<ScoredPlacement[]>([])
  const [isComputing, setIsComputing] = useState(false)
  const [rolloutsDone, setRolloutsDone] = useState(0)

  const cancelRef = useRef<(() => void) | null>(null)
  const keyRef = useRef<string | null>(null)

  // Always build info regardless of enabled state so computation runs in the background.
  const info = buildInfoState(state)
  const key = (info && !disabled) ? infoStateKey(info) + `|r${rollouts}|p${policy}` : null

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
    // Mark as computing immediately. Don't clear previous placements yet —
    // the first onProgress will replace them, so there's no blank "loading" flash.
    setIsComputing(true)
    setRolloutsDone(0)

    const seed = (state.seed ^ (state.street * 31 + state.sideStreet * 17 + (state.context === 'side' ? 1 : 0))) | 0
    const localKey = key

    const onProgress = (results: ScoredPlacement[]) => {
      if (keyRef.current !== localKey) return
      setPlacements([...results].sort((a, b) => b.ev - a.ev))
      // Use max n across all results: top-ranked candidate may be an unexplored
      // NN-fallback (n=0) even after MCTS ran, so results[0].n would be misleading.
      setRolloutsDone(results.reduce((m, r) => Math.max(m, r.n), 0))
    }
    const onDone = (results: ScoredPlacement[]) => {
      if (keyRef.current !== localKey) return
      setPlacements([...results].sort((a, b) => b.ev - a.ev))
      setRolloutsDone(results.reduce((m, r) => Math.max(m, r.n), 0))
      setIsComputing(false)
    }

    // Small initial batch so first results appear almost immediately,
    // then larger batches for efficiency.
    const onError = () => { setIsComputing(false) }
    const client = policy === 'royalty' ? royaltyWorkerClient : workerClient
    const cancel = client.streamMC(
      info,
      { totalRollouts: rollouts, batchSize: 10 },
      seed,
      onProgress,
      onDone,
      policy,
      onError,
    )
    cancelRef.current = cancel

    return () => {
      cancel()
      cancelRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const matchIndex = placements.length > 0 ? findMatchIndex(placements, state.pending) : null

  return { placements, isComputing, rolloutsDone, totalRollouts: rollouts, matchIndex }
}
