# 01 — Rules & Scoring (Source of Truth)

This is the canonical rules spec for the engine. Where the original house rules
were ambiguous, the resolved decision is marked **[DECISION]**.

## 1. Game shape

- Variant: **Pineapple Open-Face Chinese Poker**, 2 or 3 players.
- One human + bots only. 2-player = human + 1 bot. 3-player = human + **two
  independent instances of the same bot brain** (independent draws/decisions).
- Deck: standard 52 cards, no jokers. **[DECISION]** A fresh, reshuffled 52-card
  deck is dealt for the normal round and again for each bonus round (the normal
  3-player round consumes 51 of 52 cards, so a reshuffle is mandatory).
- It is a **zero-sum** game (the sum of all players' net scores is 0).

## 2. The board

Three rows, ordered by required strength **Top ≤ Middle ≤ Bottom**:

- **Top** — 3 cards.
- **Middle** — 5 cards.
- **Bottom** — 5 cards.

## 3. Hand evaluation

Standard poker rankings, with these rules:

- Middle and Bottom are 5-card hands (high card → straight flush / royal).
- **Top is a 3-card hand and can only be: high card, one pair, or trips.**
  Straights and flushes do **not** count on a 3-card hand.
- **Cross-size comparison (for the foul check):** compare by category first
  (trips > pair > high card; and on 5-card rows the full ladder), then by the
  standard descending rank tuple, then kickers. A 3-card hand's max category is
  trips. Examples:
  - Top = AA x, Middle = KK x y z → top pair(A) > middle pair(K) → **FOUL**.
  - Top = KK x, Middle = AA x y z → top pair(K) < middle pair(A) → legal.
  - Top = trips 7s, Middle = two pair → trips > two pair → **FOUL**.
- Ties on a row compare equal (a push, 0 points).

## 4. Dealing & placement

- **Street 0:** deal 5 cards; place all 5 anywhere on the board.
- **Streets 1–4:** deal 3 cards; place 2, discard 1.
- Totals per player: **17 dealt, 13 placed, 4 discarded** → final 3-5-5 board.
- **Simultaneous with reveal [DECISION]:** on each street every player commits
  their placements without seeing opponents' choices *for that street*; then all
  placements are revealed at once. From the next street on, each player can see
  **all opponents' previously placed (revealed) cards**.
- **Discards are hidden** from opponents, forever.

## 5. Fouling (busting)

- A final board that violates Top ≤ Middle ≤ Bottom is **fouled (bust)**.
- Quitting / abandoning a hand counts as bust.
- A bust player: loses all three rows to every opponent and earns **no
  royalties**.

## 6. Scoring (pairwise)

Computed independently against each opponent, then summed.

- Per row, head-to-head: **win +1, lose −1, tie 0**.
- **Scoop** (win all three rows vs one opponent): **+6** for that pairing
  instead of +3 (i.e. the 3 row points plus a **+3** scoop bonus).
- **Royalties** (Section 7) are added to your side of every pairing regardless
  of whether you win or lose the row — *unless you are bust*.
- **Net = Σ over opponents of ( your_row_points + your_royalties −
  opp_row_points − opp_royalties ).**
- **Vs a bust opponent:** you take all 3 rows = **+6** (a scoop) against them,
  and you still add your own royalties; the bust player scores 0 of their own.
- **[DECISION] Both players bust in the same pairing → net 0 between them.**

## 7. Royalties (standard OFC values — confirmed)

**Bottom (5-card):** Straight +2 · Flush +4 · Full House +6 · Four of a Kind
+10 · Straight Flush +15 · Royal Flush +25. (Trips or lower = 0.)

**Middle (5-card):** Three of a Kind +2 · Straight +4 · Flush +8 · Full House
+12 · Four of a Kind +20 · Straight Flush +30 · Royal Flush +50. (Two pair or
lower = 0.)

**Top (3-card):** Pair 66 +1 · 77 +2 · 88 +3 · 99 +4 · TT +5 · JJ +6 · QQ +7 ·
KK +8 · AA +9 · Trip 2s +10 · Trip 3s..Ks +11..+21 (each rank +1) · Trip As +22.
(Pairs below 66 and high card = 0.)

## 8. Bonus round

**Trigger:** after the normal round, a bonus round occurs if **any non-bust
player's final top row** is QQ, KK, AA, or any trips. **[DECISION]** A bust
player does not qualify.

**Qualifying players** set a brand-new 3-5-5 board **from scratch, all at once**
(Fantasyland-style, not street-by-street) from a fresh deal:

- QQ → **13 cards, 0 discards**
- KK → **14 cards, 1 discard**
- AA or any trips → **15 cards, 2 discards**

The new board must satisfy Top ≤ Middle ≤ Bottom or it fouls.

**Non-qualifying active players** simultaneously play a parallel normal
**5-street side game** (the standard 17-card Pineapple hand → a final 3-5-5
board).

**Bonus-round scoring [DECISION]:** every active player ends the bonus round with
a final 3-5-5 board (whether built one-shot or via the side game). Those boards
are scored against each other with the **exact same pairwise rules** (rows,
royalties, scoop, bust) as a normal round. Bonus-round results are **added on
top of** normal-round totals.

**Re-triggering — v1 [DECISION]:** **disabled.** Nothing inside the bonus round
(neither bonus boards nor side games) triggers a further bonus. Implement this as
a config flag `allowBonusRecursion = false`, structured so the future "infinite"
mode (side games / boards able to chain additional bonus rounds, accumulating
scores) can be switched on without an engine rewrite.

## 9. Worked test vectors (engine must pass these)

1. **Foul by pairs:** Top `As Ad 4c`, Middle `Ks Kd 9h 8h 2c`, Bottom
   `Qs Qd Qh 7c 5d` → top pair(A) > middle pair(K) → **FOUL**.
2. **Legal stack:** Top `2s 2d 9c`, Middle `8h 8s 8d 4c 3h` (trips),
   Bottom `Th Jh Qh Kh Ah` (royal) → legal; bottom royalty +25, middle royalty
   +2, top 0.
3. **Scoop:** Player A beats B on all three rows, neither bust → A +6, B −6.
4. **Royalty independent of row loss:** A loses bottom row but has a flush there
   → A still books +4 bottom royalty in the net formula.
5. **Bust opponent:** B fouls, A does not → A scores +6 vs B plus A's own
   royalties; B books 0 royalties.
6. **Both bust:** A and B both foul → net 0 between them.
7. **Top royalty ladder:** Top `Qs Qd 7c` → +7; Top `7s 7d 2c` → +2; Top
   `5s 5d 9c` → 0; Top `Kc Kd Ks` (trip K) → +21.
8. **Bonus trigger:** any non-bust player's final top = QQ/KK/AA/any trips fires
   the bonus round with the correct card count.
