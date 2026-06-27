// Monte Carlo Tree Search for Pineapple OFC.
//
// Hidden information is handled via determinization: each simulation samples a
// fresh world (assigns hidden cards from the live deck), then runs a
// perfect-information tree search over that world. Averaging across many sampled
// worlds gives an unbiased EV estimate that improves as nSims grows.
//
// Tree nodes are OUR decision points. Between our decisions the transition
// function simulates opponent placements (heuristic or NN) and deals our next
// hand from the sampled world. Leaf nodes are evaluated with V(s) from the
// trained value network — no random rollouts needed.
//
// Selection: UCB1.  Future work: replace with PUCT once a policy head is added.

import type { Card, PartialBoard } from './types'
import { legalPlacements, applyPlacement } from './placement'
import type { Placement } from './placement'
import type { InfoState, RNG, ScoredPlacement } from './mc'
import { buildLiveDeck, fisherYates } from './mc'
import type { MLPWeights } from './mlpInference'
import { nnValue, nnPickPlacement } from './nnPolicy'
import { heuristicPlacement } from './heuristic'

// ── Constants ────────────────────────────────────────────────────────────────

// UCB exploration constant (√2 is the classic default).
const UCB_C = Math.SQRT2

// ── Tree node ─────────────────────────────────────────────────────────────────

interface MCTSNode {
  board: PartialBoard
  hand: readonly Card[]
  street: number
  discards: readonly Card[]
  oppBoards: PartialBoard[]       // revealed boards (updated through transitions)

  placement: Placement | null     // action taken from parent (null = root)
  parent: MCTSNode | null
  children: MCTSNode[]
  untriedPlacements: Placement[]  // not yet expanded; order is arbitrary

  visits: number
  totalValue: number              // sum of V(leaf) over all simulations
}

function makeRoot(state: InfoState): MCTSNode {
  return {
    board: state.board,
    hand: [...state.hand],
    street: state.street,
    discards: [...(state.discards ?? [])],
    oppBoards: state.revealedOpponentBoards.map(b => ({
      top: [...b.top], middle: [...b.middle], bottom: [...b.bottom],
    })),
    placement: null, parent: null,
    children: [],
    untriedPlacements: legalPlacements(state.board, state.hand, state.street),
    visits: 0, totalValue: 0,
  }
}

function makeChild(
  board: PartialBoard,
  hand: Card[],
  street: number,
  discards: Card[],
  oppBoards: PartialBoard[],
  placement: Placement,
  parent: MCTSNode,
): MCTSNode {
  return {
    board, hand, street, discards, oppBoards,
    placement, parent,
    children: [],
    untriedPlacements: legalPlacements(board, hand, street),
    visits: 0, totalValue: 0,
  }
}

// ── UCB1 selection ────────────────────────────────────────────────────────────

function ucbScore(node: MCTSNode, parentVisits: number): number {
  if (node.visits === 0) return Infinity
  return node.totalValue / node.visits + UCB_C * Math.sqrt(Math.log(parentVisits) / node.visits)
}

function selectChild(node: MCTSNode): MCTSNode {
  let best = node.children[0]!
  let bestScore = -Infinity
  for (const child of node.children) {
    const score = ucbScore(child, node.visits)
    if (score > bestScore) { bestScore = score; best = child }
  }
  return best
}

// ── Transition ────────────────────────────────────────────────────────────────
// Apply our placement, advance opponents using the sampled world, deal us the
// next street's cards. Returns the resulting child-node state or null if the
// sampled world runs out of cards (degenerate sample — skip this sim).
//
// `di` is passed by reference (mutable object) so the caller sees the updated
// deck index after we consume cards.

function doTransition(
  node: MCTSNode,
  placement: Placement,
  world: Card[],
  di: { v: number },
  weights: MLPWeights | null,   // null → use heuristic for opponents
): MCTSNode | null {
  const newBoard = applyPlacement(node.board, placement)
  const newDiscards = placement.discard
    ? [...node.discards, placement.discard]
    : [...node.discards]

  const cps = node.street === 0 ? 5 : 3   // cards dealt per player this street

  // Deep-copy opponent boards so we can mutate them.
  const oppBrds: PartialBoard[] = node.oppBoards.map(b => ({
    top: [...b.top], middle: [...b.middle], bottom: [...b.bottom],
  }))

  // Deal each opponent their cards for the current street and apply their policy.
  for (let i = 0; i < oppBrds.length; i++) {
    const oppHand = world.slice(di.v, di.v + cps)
    di.v += cps
    if (oppHand.length < cps) return null
    const visibleToOpp: PartialBoard[] = [newBoard, ...oppBrds.filter((_, j) => j !== i)]
    const pl = weights
      ? nnPickPlacement(weights, oppBrds[i]!, oppHand, node.street, visibleToOpp)
      : heuristicPlacement(oppBrds[i]!, oppHand, node.street)
    oppBrds[i] = applyPlacement(oppBrds[i]!, pl)
  }

  // Deal us the next street's hand.
  const nextStreet = node.street + 1
  const newHand = world.slice(di.v, di.v + 3)
  di.v += 3
  if (newHand.length < 3) return null

  return makeChild(newBoard, newHand, nextStreet, newDiscards, oppBrds, placement, node)
}

// ── Deck index advance (for selection skip) ────────────────────────────────
// When descending into an already-expanded child during selection, we don't
// re-run the transition (the child's board state is stored). We only advance
// the deck index so subsequent expansions consume the correct cards.

function skipTransition(node: MCTSNode, di: { v: number }): void {
  const cps = node.street === 0 ? 5 : 3
  di.v += node.oppBoards.length * cps + 3
}

// ── Public options ────────────────────────────────────────────────────────────

export interface MCTSOptions {
  nSims: number       // total simulations to run
  maxDepth: number    // tree depth (2 = look one street ahead of current; recommended)
  nnOpponents?: boolean  // use NN for opponent moves in transitions (slower but more accurate)
}

// ── Main search ───────────────────────────────────────────────────────────────

function buildTree(
  root: MCTSNode,
  state: InfoState,
  weights: MLPWeights,
  opts: MCTSOptions,
  rng: RNG,
): void {
  const { nSims, maxDepth, nnOpponents = false } = opts
  const oppWeights = nnOpponents ? weights : null

  for (let sim = 0; sim < nSims; sim++) {
    const world = fisherYates(buildLiveDeck(state), rng)
    const di = { v: 0 }

    // 1. Selection: walk UCB-best children until unexpanded or at max depth.
    let node = root
    let depth = 0
    while (node.untriedPlacements.length === 0 && node.children.length > 0 && depth < maxDepth) {
      const child = selectChild(node)
      skipTransition(node, di)
      node = child
      depth++
    }

    // 2. Expansion: try an untried placement and add a child node.
    let evalNode = node
    if (node.untriedPlacements.length > 0 && depth < maxDepth && node.street < 4) {
      // Pick uniformly from untried placements (future: use policy prior here).
      const pIdx = Math.floor(rng() * node.untriedPlacements.length)
      const [placement] = node.untriedPlacements.splice(pIdx, 1) as [Placement]
      const child = doTransition(node, placement, world, di, oppWeights)
      if (child) {
        node.children.push(child)
        evalNode = child
      }
    }

    // 3. Evaluate leaf with V(s) from the trained value network.
    const value = nnValue(
      weights, evalNode.board, evalNode.street, evalNode.oppBoards, evalNode.discards,
    )

    // 4. Backpropagate.
    let n: MCTSNode | null = evalNode
    while (n !== null) {
      n.visits++
      n.totalValue += value
      n = n.parent
    }
  }
}

// Return a single best-placement decision (used by the bot).
export function mctsPickPlacement(
  state: InfoState,
  weights: MLPWeights,
  opts: MCTSOptions,
  rng: RNG,
): Placement {
  const root = makeRoot(state)
  buildTree(root, state, weights, opts, rng)

  if (root.children.length === 0) {
    // No simulations reached a child — fall back to most-visited or first legal.
    return legalPlacements(state.board, state.hand, state.street)[0]!
  }
  // Most visits = robust best action (less sensitive to outlier high values).
  return root.children.reduce((a, b) => a.visits > b.visits ? a : b).placement!
}

// Return scored candidates for all legal placements (used by coach and analysis).
// Placements that were never expanded in the tree get a depth-1 NN estimate so
// the full ranked list is always complete.
export function mctsScoredPlacements(
  state: InfoState,
  weights: MLPWeights,
  opts: MCTSOptions,
  rng: RNG,
): ScoredPlacement[] {
  const root = makeRoot(state)

  // Snapshot all legal placements before buildTree mutates untriedPlacements.
  const allPlacements = legalPlacements(state.board, state.hand, state.street)

  buildTree(root, state, weights, opts, rng)

  // Index explored children by a key derived from the placement.
  function placementKey(p: Placement): string {
    const cards = (cs: readonly Card[]) => cs.map(c => `${c.rank}${c.suit}`).sort().join(',')
    return `T:${cards(p.topAdd)}|M:${cards(p.middleAdd)}|B:${cards(p.bottomAdd)}|D:${p.discard ? `${p.discard.rank}${p.discard.suit}` : '-'}`
  }
  const explored = new Map(root.children.map(c => [placementKey(c.placement!), c]))

  const priorDiscards = state.discards ?? []

  return allPlacements.map(placement => {
    const key = placementKey(placement)
    const node = explored.get(key)
    if (node && node.visits > 0) {
      return { placement, ev: node.totalValue / node.visits, variance: 0, n: node.visits }
    }
    // Unexplored: depth-1 NN fallback so the caller always gets a full ranking.
    const boardAfter = applyPlacement(state.board, placement)
    const allDiscards = placement.discard ? [...priorDiscards, placement.discard] : priorDiscards
    const ev = nnValue(weights, boardAfter, state.street, state.revealedOpponentBoards, allDiscards)
    return { placement, ev, variance: 0, n: 0 }
  }).sort((a, b) => b.ev - a.ev)
}
