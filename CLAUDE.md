# CLAUDE.md

Persistent instructions for Claude Code on this repo. Read this every session.

## What this is

A single-user web app: a Pineapple Open-Face Chinese Poker (OFC) trainer with a
strong bot, a per-decision Monte-Carlo EV coach, and a custom-position analyzer.
2- and 3-player. Human + bots only.

## Source of truth

`docs/01_RULES_AND_SCORING.md`, `docs/02_ENGINE_EV_AND_BOT.md`,
`docs/03_ARCHITECTURE_AND_ROADMAP.md` are authoritative. **Read the relevant
doc before editing related code.** If code and a doc disagree, the doc wins —
or stop and ask. Do not invent rules; every `[DECISION]` in the rules doc is
deliberate.

## Stack

React + TypeScript (strict) + Vite + Tailwind. Firebase Hosting + Auth (Google,
single allowlisted UID) + Firestore + Storage. **No Cloud Functions.** All
game/bot/EV compute runs client-side in a **Web Worker**.

## Non-negotiable invariants

1. **One engine, three consumers.** Bot, coach, and analyzer all call the same
   core. Never fork or duplicate rules/scoring/EV logic.
2. **Information-set hygiene.** The bot/coach/analyzer compute a move using only
   the acting player's information set (own board, own cards/discards, opponents'
   *revealed* boards). They must never read opponents' hidden cards, discards,
   future draws, or the undealt stub. There is a test that enforces this — keep
   it green.
3. **Engine boundary.** All engine entry points sit behind one `Engine`
   interface + worker RPC. The UI never imports engine internals. This is what
   lets a Rust→WASM core + NN drop in at Phase 6 with no UI changes.
4. **No Firebase/UI imports inside the engine.** The engine is pure, deterministic
   (seeded RNG), and unit-testable in isolation.
5. **Correctness before UI.** Engine + passing tests before any interface for a
   feature.
6. **No Cloud Functions. No secrets committed.** Firebase config in `.env.local`.

## Workflow

- Build in the P0→P6 order in `docs/03`. **Finish a phase, run tests, summarize
  what works + how to try it, then stop for review** before the next phase.
- Ask before any architectural deviation from the docs.
- Conventional commits, one per phase or logical unit (e.g.
  `feat(engine): hand evaluator + foul detection`).
- Keep changes scoped; don't refactor unrelated code in a feature commit.

## Commands

Fill these in once scaffolded and keep them current:

- Dev: `npm run dev`
- Test: `npm test` (must pass before committing engine changes)
- Typecheck/lint: `npm run typecheck && npm run lint`
- Build: `npm run build`
- Deploy: `firebase deploy --only hosting`

**Always run typecheck + tests before committing.**

## Code conventions

- TypeScript strict mode; no `any`; model cards/ranks/boards as precise types.
- Engine modules are pure functions; side effects (Firebase, DOM) only at the
  app layer.
- Determinism: thread a seedable RNG everywhere randomness is used; same seed →
  same deal → same output.
- Web Worker streams progressive EV estimates; UI shows best-so-far + confidence,
  never blocks.
- Prefer small, tested units over large modules. Comment the *why*, not the *what*.

## Game gotchas (where bugs hide)

- **Top is a 3-card hand:** only high-card / pair / trips — no straights or
  flushes on top.
- **Cross-size foul comparison:** compare Top vs Middle vs Bottom by category
  then rank tuple; `Top ≤ Middle ≤ Bottom` or it fouls. Trips beats two pair.
- **Royalties only for non-bust boards;** they're added regardless of whether the
  row is won.
- **Scoop = +6** (3 row points + 3 bonus). **Vs a bust opponent = +6.**
  **Both bust = net 0.**
- **Scoring is zero-sum across the whole table** — assert this in tests.
- **Fresh reshuffled 52-card deck per round** (3-player normal round uses 51/52,
  so the bonus round cannot reuse the stub).
- **Bonus trigger:** non-bust final top = QQ/KK/AA/any trips → QQ:13 / KK:14 /
  AA-or-trips:15 cards, set as a one-shot 3-5-5 board.
- **`allowBonusRecursion` defaults to false** in v1 — keep the recursion path
  structured but disabled.

## Do not

- Add Cloud Functions, server-side bot compute, or move EV off the client.
- Let the UI reach into engine internals or bypass the worker.
- Give the bot/coach access to information the acting player can't see.
- Hardcode the deal or skip seeds (breaks replay/self-play).
- Mark a phase done with failing or skipped tests.
