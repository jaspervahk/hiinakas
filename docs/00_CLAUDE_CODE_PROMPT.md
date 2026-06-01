# Claude Code Kickoff Prompt — OFC Pineapple Bot + Trainer

Paste the section below into Claude Code at the root of an empty repo. The three
spec files (`01_RULES_AND_SCORING.md`, `02_ENGINE_EV_AND_BOT.md`,
`03_ARCHITECTURE_AND_ROADMAP.md`) should be committed into `docs/` first so Claude
Code can read them as the source of truth.

---

## PROMPT

You are building a single-user web app: a Pineapple Open-Face Chinese Poker
(OFC) trainer with a strong bot, a per-decision EV coach, and a custom-position
analyzer. The full specification lives in `docs/`. **Read all three docs in
`docs/` before writing any code, and treat them as the authoritative spec** —
if anything I say here conflicts with them, ask me.

Hard requirements:

- **Stack:** React + TypeScript + Vite + Tailwind, responsive for mobile and
  desktop. Firebase Hosting, Firebase Auth (Google sign-in, locked to a single
  allowlisted UID), Cloud Firestore (hand history + stats), Firebase Storage
  (phase-2 model artifacts). **No Cloud Functions** — all game/bot/EV compute
  runs client-side in a Web Worker.
- **One engine, three consumers:** the same core powers (a) the bot's moves,
  (b) the EV coach, and (c) the analyzer. Do not fork logic.
- **Engine boundary:** write the engine in TypeScript now, but behind a clean,
  documented interface (`Engine` with pure functions + a worker RPC layer) so a
  Rust→WASM core and a neural-net evaluator can be dropped in later (phase 6)
  with no UI changes.
- **Information-set hygiene is non-negotiable:** the bot/coach must compute every
  decision strictly from the acting player's information set. It must never read
  opponents' discards, hidden hands, future draws, or the undealt stub. See the
  "Information & Signaling" section of `02_ENGINE_EV_AND_BOT.md`.
- **Correctness before UI:** build and unit-test the rules engine (cards, deck,
  hand evaluation, fouling, scoring including the bonus round and side games)
  against the worked test vectors in `01_RULES_AND_SCORING.md` before building
  any interface. Every scoring rule needs a passing test.

Build incrementally following the phased roadmap in
`03_ARCHITECTURE_AND_ROADMAP.md`. After each phase: run the tests, give me a
short summary of what works, and a way to try it, before moving on. Ask before
any architectural deviation from the docs. Commit at the end of each phase with a
clear message.

Start with Phase 0 (repo scaffold + Firebase project wiring + Google auth gated
to one UID + a deployable empty shell), then stop and show me before Phase 1.
