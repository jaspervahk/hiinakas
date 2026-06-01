# 02 — Engine, EV, Bot, Coach, Analyzer & Training

## 1. Engine core (pure, deterministic, testable)

Implement as pure TS modules with no UI/Firebase dependencies:

- `Card`, `Deck` (seedable RNG for reproducible tests/self-play).
- `evaluate5(cards) -> HandRank` and `evaluate3(cards) -> HandRank` (top:
  high-card / pair / trips only). Use a fast bitwise/lookup evaluator; precompute
  tables at module load. `HandRank` must be totally ordered and comparable across
  3- and 5-card hands per `01_RULES_AND_SCORING.md` §3.
- `Board { top[3], middle[5], bottom[5] }`, `isFoul(board)`, `royalties(board)`.
- `scorePair(boardA, boardB)` and `scoreTable(boards[])` → per-player net,
  applying scoop, royalties, bust, and both-bust = 0.
- `legalPlacements(board, dealtCards, street)` → all legal ways to place this
  street's cards (street 0: place 5; streets 1–4: choose 2 of 3 to place across
  open slots + 1 discard). Returns canonicalized, de-duplicated placements.
- Bonus round: `bonusDeal(qualifierType)` sizing, `bestBonusBoard(cards)` solver
  (see §5), and `sideGame` reusing the normal street machinery.

All of the above is the shared core used by bot, coach, and analyzer.

## 2. Information & Signaling (treat as a design invariant)

The acting player's **information set** is exactly: their own placed board, their
own cards-in-hand awaiting placement, their own discards, and every opponent's
**revealed** board. Everything else — opponents' current-street cards before
reveal, opponents' discards, opponents' future draws, the undealt stub — is
**unknown** and must never be read by the bot/coach/analyzer.

- The **live (unseen) deck** from the actor's viewpoint = 52 minus all cards the
  actor can see (own cards + revealed opponent boards). Opponents' discards are
  *not* removed (the actor doesn't know them); MC sampling over the unseen pool
  is the correct belief model.
- **Leakage is priced in:** because opponents see your revealed board, your
  placement changes their future best responses. The MC opponent policy
  **conditions on the revealed boards**, so the cost/benefit of "what you give
  away" is reflected in the EV estimate.
- **Disguise / mixing** (deliberately not telegraphing, mixing between
  comparable lines) is an equilibrium property. A naive best-response-to-a-fixed-
  policy bot won't produce it. The phase-6 self-play objective is therefore
  **regret-minimizing / equilibrium-seeking**, not naive best response (see §6).

## 3. EV engine (Monte-Carlo expectimax) — phase 2

For a decision, given the actor's information set:

1. Enumerate candidate placements via `legalPlacements`.
2. For each candidate, run N Monte-Carlo rollouts:
   - Sample the unknown cards (opponents' hidden/future cards + your future
     draws) uniformly from the live deck.
   - Play the rest of the hand out with a **rollout policy** for all seats
     (yours and opponents'), where each seat sees only its own information set
     and opponents' revealed boards.
   - Score the terminal table (`scoreTable`), record the actor's net.
3. Candidate EV = mean actor net over its rollouts; rank candidates by EV.
   Report variance / 95% CI so the UI can show confidence and so the analyzer can
   auto-increase N until separation is significant.

Notes:

- Rollout policy v1 = a fast tuned heuristic (maximize own expected royalties +
  foul-avoidance + draw equity), good enough to make EV meaningful and the bot
  strong. It is swapped for the trained policy/value net in phase 6.
- Run in a **Web Worker**; stream progressive estimates to the UI (show best-so-
  far as N grows). Budget ~1s for live play; allow the analyzer to run longer.
- Variance reduction (do if cheap): common random numbers across candidates,
  antithetic sampling.

## 4. Bot

- The bot plays `argmax EV` from the same engine. Difficulty knob = rollout count
  / search depth / (phase 6) whether the NN evaluator is used.
- Phase 6: optionally sample among near-EV-equal lines per the equilibrium policy
  (controlled mixing) so it is not exploitable/telegraphing.

## 5. EV Coach (UI-facing)

- During play, after you're dealt a street's cards, show a **ranked list of
  legal placements with their EV**, clearly mark **the placement you chose** and
  its **EV gap to the best line**. Update progressively as rollouts accumulate.
- **Undo / redo** of placements before the street is locked; lock is explicit.
- **Live-coach toggle:** play fully blind, or with the ranked list visible.
- **Post-hand review:** replay each street showing your move, the best line, and
  cumulative EV-loss for the hand.
- For **bonus boards**, the coach calls `bestBonusBoard` and shows the best
  arrangement plus your arrangement's gap. `bestBonusBoard` solves the
  combinatorial best legal 3-5-5 from 13–15 cards (prune by suit/rank structure;
  branch-and-bound on royalties with a foul-feasibility check; this is a tractable
  search, not full brute force).

## 6. Custom-position analyzer

- A mode to enter an arbitrary legal state: each player's rows (partial allowed),
  the current street, and the actor's cards-to-place. Dead/live cards are derived
  automatically from what's entered.
- **Validate**: no duplicate cards, correct counts per row/street, board not
  already impossible. Surface clear errors.
- Output: the same ranked-EV list (and `bestBonusBoard` for bonus inputs), run
  with a higher rollout budget and CI reporting.

## 7. Phase-6 training (offline → perfection)

- **Self-play generator** produces games where every seat acts only on its
  information set and opponents react to revealed boards.
- Train a **value network** `V(infostate) → expected net` (and optionally a
  **policy network** over placements) on MC-labeled / bootstrapped targets.
- Use an **equilibrium-seeking objective** (e.g. regret-minimization / fictitious
  self-play over an action abstraction) rather than naive best-response, so the
  resulting policy is robust to being observed and mixes/disguises where +EV —
  directly addressing the signaling point in §2.
- Fold the net back in as the rollout leaf-evaluator + policy to deepen search.
- **Where it runs:** entirely **offline on the user's machine** (TS or Rust game
  gen + PyTorch trainer). Export weights (ONNX or compact binary/JSON), upload to
  **Firebase Storage**; the client loads and runs inference in the Worker
  (ONNX Runtime Web, TF.js, or baked into the Rust→WASM core). **Never** train or
  serve heavy inference from Cloud Functions.
- Game-theory note for the implementer: with hidden-then-revealed simultaneous
  streets this is an imperfect-information, simultaneous-move game, so exact
  optimality can require mixed strategies; full CFR-with-abstraction is an
  optional research track, not required for a very strong bot.
