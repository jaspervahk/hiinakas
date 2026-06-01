# 03 — Architecture, Firebase & Roadmap

## 1. Stack & principles

- **Frontend:** React + TypeScript + Vite + Tailwind. Responsive (mobile +
  desktop). Comfortable, clean UX; clear card/board layout; the EV coach panel
  collapses cleanly on mobile.
- **Compute:** entirely client-side. The engine (rules + MC EV + bot) runs in a
  **Web Worker** so rollouts never block the UI; stream progressive results.
- **Firebase used only for** hosting, auth, and persistence — **no Cloud
  Functions** (single-user app: client compute is faster, free of cold starts,
  and avoids the 9-min/runtime limits that training would break anyway).
- **Engine boundary:** all engine entry points behind one `Engine` interface +
  a worker RPC layer, so a Rust→WASM core + NN evaluator can replace the TS
  implementation in Phase 6 with zero UI changes.

## 2. Firebase

- **Hosting:** Firebase Hosting for the built SPA.
- **Auth:** Firebase Auth with **Google sign-in**, restricted to a single
  allowlisted UID. Gate both the app shell and the security rules; reject all
  other users.
- **Firestore:** persistence (schema §3). Security rules: read/write only if
  `request.auth.uid == <ALLOWLISTED_UID>`. Deny everything else.
- **Storage:** phase-6 model artifacts (`/models/...`), same single-UID rule.
- Keep config in env (`.env.local`), never commit secrets; document the manual
  Firebase Console steps (create project, enable Google auth, set rules,
  `firebase init hosting`).

## 3. Firestore data model

- `users/{uid}/hands/{handId}`: full move log per street (dealt cards, chosen
  placement, discard, the engine's ranked EV list + chosen-move EV + gap), final
  boards, per-pairing and total scores, bonus-round detail, timestamps, seed.
- `users/{uid}/sessions/{sessionId}`: aggregates — net score over time, **EV-loss
  vs optimal**, foul rate, royalty rate, scoop rate, hands played, 2p vs 3p.
- `users/{uid}/settings`: coach on/off default, difficulty, table size,
  `allowBonusRecursion` (default false).
- Persist seeds so any hand can be replayed deterministically.

## 4. Roadmap (build in order; test + show me after each phase)

- **P0 — Scaffold:** Vite+React+TS+Tailwind app, Firebase project wired, Google
  auth gated to one UID, deployable empty shell. *Stop and show me.*
- **P1 — Rules engine:** cards, deck (seeded), `evaluate3`/`evaluate5`, foul,
  royalties, pairwise + table scoring, bonus-round + side-game scoring. Unit
  tests pass all vectors in `01_RULES_AND_SCORING.md` §9. No UI yet.
- **P2 — EV engine + bot:** `legalPlacements`, MC expectimax with progressive
  estimates + CI, heuristic rollout policy, `argmax` bot, Web Worker RPC.
  Headless sanity: bot-vs-bot runs, EV monotonicity checks, strict info-set
  hygiene asserted in tests.
- **P3 — Play UI:** 2- and 3-player tables; simultaneous-street flow with reveal;
  drag/tap placement; undo/redo; explicit street lock; live foul/royalty
  readouts; full bonus-round + parallel side-game flow.
- **P4 — Coach + persistence:** ranked-EV list with your-move marker and gap,
  live-coach toggle, post-hand review with cumulative EV-loss; write hands +
  session stats + a stats dashboard to Firestore.
- **P5 — Analyzer:** custom-position entry, validation, ranked-EV output, and
  `bestBonusBoard` solving; higher rollout budget.
- **P6 — Perfection:** introduce the Rust→WASM core behind the `Engine`
  interface; offline self-play + equilibrium-seeking NN trainer; export weights →
  Storage → load in Worker; difficulty tiers; optional controlled mixing in the
  bot.
- **Later flag:** enable `allowBonusRecursion` for the "infinite" chaining mode
  (side games / bonus boards can trigger further bonus rounds, scores accumulate).

## 5. Testing & quality bar

- Engine: exhaustive unit tests on the §9 vectors plus property tests
  (scoring is zero-sum across the table; royalties never granted to a bust
  board; foul detection symmetric).
- Info-set hygiene: a test that the bot/coach, given a state, produce identical
  output whether or not hidden cards are present in the full game object (i.e.
  they provably don't read hidden info).
- Determinism: same seed → same deal → same engine output.
