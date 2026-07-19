// Bridge to "Huub" (Pokker6), a separate live Firebase project (huub-c4e5b)
// with its own Auth namespace and its own Chinese Poker (OFC) engine. This
// lets the user pick a historical Hiinakas session + a player's perspective
// and challenge a real Huub user to play through it on their own account —
// see /Users/jaspervahk/.claude/plans/federated-doodling-zephyr.md for the
// full cross-repo design.
//
// These two functions run AS a dedicated GCP service account
// (hiinakas-bridge@hiinakas-355.iam.gserviceaccount.com, `serviceAccount`
// option below) so their outbound calls to Huub's two IAM-locked-down
// onRequest endpoints authenticate automatically via a GCP-signed ID token —
// there is no shared secret anywhere. Huub only accepts calls from this exact
// identity (verified via `gcloud run services get-iam-policy` during Huub's
// Phase 1).
//
// This is Hiinakas's first-ever Cloud Function — a deliberate, user-approved
// deviation from this repo's "no Cloud Functions" rule, scoped to exactly
// this bridge. Every other engine/bot/EV computation stays entirely
// client-side per CLAUDE.md.
import {onCall, HttpsError} from "firebase-functions/v2/https";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import {GoogleAuth} from "google-auth-library";
import {wrapRows} from "./utils/firestoreArrayCodec";

const REGION = "europe-west1";
const HIINAKAS_BRIDGE_SERVICE_ACCOUNT = "hiinakas-bridge@hiinakas-355.iam.gserviceaccount.com";

// Single allowlisted user, hardcoded server-side. Matches VITE_ALLOWED_UID in
// .env.local. Hiinakas's AuthGate.tsx allowlist check is client-only and
// harmless with no server surface — but a Cloud Function IS a server
// surface, so every callable here must re-check auth itself or any Google
// account could invoke it.
const ALLOWED_UID = "7d3zgIRy43OClSXUDhnsLmhDNwg2";

const HUUB_CREATE_URL = "https://createreplaychallenge-jpbf5hygua-ew.a.run.app";
const HUUB_STATUS_URL = "https://getreplaychallengestatus-jpbf5hygua-ew.a.run.app";
const HUUB_CANCEL_URL = "https://cancelreplaychallenge-jpbf5hygua-ew.a.run.app";

const db = getFirestore();
const googleAuth = new GoogleAuth();

async function callHuub<T>(url: string, body: unknown): Promise<T> {
  const client = await googleAuth.getIdTokenClient(url);
  const res = await client.request<T>({url, method: "POST", data: body});
  return res.data;
}

function requireAllowedUid(uid: string | undefined): void {
  if (uid !== ALLOWED_UID) {
    throw new HttpsError("permission-denied", "Not authorized");
  }
}

// ── Hiinakas-side shapes (mirrors src/engine/types.ts + src/engine/placement.ts) ──

interface HCard {
  rank: number; // 2-14
  suit: string; // 'c' | 'd' | 'h' | 's'
}

interface HPlacement {
  topAdd: HCard[];
  middleAdd: HCard[];
  bottomAdd: HCard[];
  discard: HCard | null;
}

interface HBoard {
  top: HCard[];
  middle: HCard[];
  bottom: HCard[];
}

type HBonusQualifier = "QQ" | "KK" | "AA_OR_TRIPS";

interface HOpponentBonusOutcome {
  qualifies: true;
  board: HBoard;
}
interface HOpponentSideOutcome {
  qualifies: false;
  placements: HPlacement[];
}

interface ClientHandInput {
  gameId: string;
  playerCount: 2 | 3;
  historicalTotal: number;
  opponentNames: string[]; // parallel to opponentNormalPlacements / opponentBonusOutcomes
  targetNormalHands: HCard[][]; // [street 0-4], the real player's historical hand
  opponentNormalPlacements: HPlacement[][]; // [opponent][street 0-4]
  opponentBonusOutcomes: (HOpponentBonusOutcome | HOpponentSideOutcome | null)[];
  humanBonusReplay:
    | {tier: HBonusQualifier; cards: HCard[]}
    | {tier: null; sideHands: HCard[][]}
    | null;
  // The target's own actual historical choices — not sent to Huub at all
  // (only used for Hiinakas's own local sent-challenge detail viewer), see
  // encodeHandForStorage.
  targetNormalPlacements: HPlacement[]; // [street 0-4]
  targetBonusOutcome: HOpponentBonusOutcome | HOpponentSideOutcome | null;
}

interface CreateChallengeRequest {
  targetUsername: string;
  sessionName: string;
  hands: ClientHandInput[];
}

// ── Translation to Huub's shapes (Card {rank:string,suit:string}, CpPlacement, PlayerBoardRow) ──

const SUIT_MAP: Record<string, string> = {c: "clubs", d: "diamonds", h: "hearts", s: "spades"};
const RANK_MAP: Record<number, string> = {11: "J", 12: "Q", 13: "K", 14: "A"};
const TIER_MAP: Record<HBonusQualifier, 13 | 14 | 15> = {QQ: 13, KK: 14, AA_OR_TRIPS: 15};

function toHuubCard(c: HCard): {rank: string; suit: string} {
  const suit = SUIT_MAP[c.suit];
  if (!suit) throw new HttpsError("invalid-argument", `Unknown suit "${c.suit}"`);
  return {rank: RANK_MAP[c.rank] ?? String(c.rank), suit};
}

type HuubRow = "top" | "middle" | "bottom";
interface HuubPlacement {row: HuubRow; card: {rank: string; suit: string}}

function toCpPlacements(p: HPlacement): HuubPlacement[] {
  const out: HuubPlacement[] = [];
  for (const c of p.topAdd) out.push({row: "top", card: toHuubCard(c)});
  for (const c of p.middleAdd) out.push({row: "middle", card: toHuubCard(c)});
  for (const c of p.bottomAdd) out.push({row: "bottom", card: toHuubCard(c)});
  return out;
}

function toHuubBoard(b: HBoard) {
  return {
    top: b.top.map(toHuubCard),
    middle: b.middle.map(toHuubCard),
    bottom: b.bottom.map(toHuubCard),
  };
}

function translateBonusOutcome(o: HOpponentBonusOutcome | HOpponentSideOutcome | null) {
  if (!o) return undefined;
  if (o.qualifies) return {qualifies: true as const, board: toHuubBoard(o.board)};
  return {qualifies: false as const, sidePlacements: o.placements.map(toCpPlacements)};
}

function translateHumanBonusReplay(h: ClientHandInput["humanBonusReplay"]) {
  if (!h) return undefined;
  if (h.tier === null) {
    return {tier: null, sideHands: h.sideHands.map((street) => street.map(toHuubCard))};
  }
  return {tier: TIER_MAP[h.tier], cards: h.cards.map(toHuubCard)};
}

// ── Local persistence (Hiinakas's own record of what was sent) ────────────
// Keeps the full historical hand data (both the target's dealt hands and the
// scripted opponents' placements/bonus outcomes) durably in Hiinakas's own
// Firestore, independent of Huub and independent of whether the original
// session is still loaded in the browser — lets a sent challenge be opened
// and inspected hand-by-hand later. Same nested-array Firestore restriction
// as the wire format to Huub, so the same wrap/unwrap treatment applies.

function encodeHandForStorage(hand: ClientHandInput): FirebaseFirestore.DocumentData {
  return {
    gameId: hand.gameId,
    playerCount: hand.playerCount,
    historicalTotal: hand.historicalTotal,
    opponentNames: hand.opponentNames,
    targetNormalHands: wrapRows(hand.targetNormalHands),
    // [opponent][street] — one Placement object per street already (not a
    // per-card list like Huub's CpPlacement), so only the opponent-indexed
    // outer array is directly nested; each opponent's own Placement[] is a
    // plain array of objects and needs no wrapping.
    opponentNormalPlacements: wrapRows(hand.opponentNormalPlacements),
    opponentBonusOutcomes: hand.opponentBonusOutcomes,
    humanBonusReplay: hand.humanBonusReplay ?
      (hand.humanBonusReplay.tier === null ?
        {tier: null, sideHands: wrapRows(hand.humanBonusReplay.sideHands)} :
        hand.humanBonusReplay) :
      null,
    // Plain array of Placement objects (no per-opponent outer dimension),
    // and the same qualifies:true/false shape as opponentBonusOutcomes[i] —
    // neither needs wrapping.
    targetNormalPlacements: hand.targetNormalPlacements,
    targetBonusOutcome: hand.targetBonusOutcome,
  };
}

function translateHand(hand: ClientHandInput) {
  if (hand.opponentNames.length !== hand.opponentNormalPlacements.length ||
      hand.opponentNames.length !== hand.opponentBonusOutcomes.length) {
    throw new HttpsError("invalid-argument", `Opponent array length mismatch for game ${hand.gameId}`);
  }
  return {
    hiinakasGameId: hand.gameId,
    playerCount: hand.playerCount,
    targetPreDealtHands: hand.targetNormalHands.map((street) => street.map(toHuubCard)),
    scriptedSeats: hand.opponentNames.map((username, i) => ({
      seatUid: `scripted:${i}`,
      username,
      normalPlacements: hand.opponentNormalPlacements[i]!.map(toCpPlacements),
      bonusOutcome: translateBonusOutcome(hand.opponentBonusOutcomes[i]!),
    })),
    targetBonusReplay: translateHumanBonusReplay(hand.humanBonusReplay),
    historicalTotal: hand.historicalTotal,
  };
}

// ── Callables ──────────────────────────────────────────────────────────────

interface CreateReplayChallengeResponse {
  challengeId: string;
}

export const createHuubReplayChallenge = onCall(
  {region: REGION, serviceAccount: HIINAKAS_BRIDGE_SERVICE_ACCOUNT},
  async (request) => {
    requireAllowedUid(request.auth?.uid);

    const body = request.data as Partial<CreateChallengeRequest>;
    if (typeof body.targetUsername !== "string" || !body.targetUsername) {
      throw new HttpsError("invalid-argument", "targetUsername required");
    }
    if (!Array.isArray(body.hands) || body.hands.length === 0) {
      throw new HttpsError("invalid-argument", "hands required");
    }
    const targetUsername = body.targetUsername;
    const sessionName = typeof body.sessionName === "string" ? body.sessionName : "";
    const hands = body.hands;

    const localRef = db.collection("replayChallenges").doc();
    const translatedHands = hands.map(translateHand);

    const huubResponse = await callHuub<CreateReplayChallengeResponse>(HUUB_CREATE_URL, {
      targetUsername,
      replayHiinakasRef: localRef.id,
      hands: translatedHands,
    });

    await localRef.set({
      huubChallengeId: huubResponse.challengeId,
      huubUsername: targetUsername,
      sessionName,
      createdAt: FieldValue.serverTimestamp(),
      sourceGameIds: hands.map((h) => h.gameId),
    });

    // Batches of 20 (well under Firestore's 500-op cap, same safety margin
    // used for Huub's own replayHands writes) — durable local record of the
    // full historical hand data, independent of Huub and of whether the
    // original session is still loaded, so a sent challenge can be opened
    // and inspected hand-by-hand later.
    for (let i = 0; i < hands.length; i += 20) {
      const batch = db.batch();
      const chunk = hands.slice(i, i + 20);
      chunk.forEach((hand, j) => {
        const index = i + j;
        const handRef = localRef.collection("hands").doc(String(index));
        batch.set(handRef, {...encodeHandForStorage(hand), index});
      });
      await batch.commit();
    }

    return {id: localRef.id, huubChallengeId: huubResponse.challengeId};
  }
);

interface GetStatusRequest {
  huubChallengeId: string;
}

export const getHuubReplayChallengeStatus = onCall(
  {region: REGION, serviceAccount: HIINAKAS_BRIDGE_SERVICE_ACCOUNT},
  async (request) => {
    requireAllowedUid(request.auth?.uid);

    const body = request.data as Partial<GetStatusRequest>;
    if (typeof body.huubChallengeId !== "string" || !body.huubChallengeId) {
      throw new HttpsError("invalid-argument", "huubChallengeId required");
    }

    return callHuub(HUUB_STATUS_URL, {challengeId: body.huubChallengeId});
  }
);

interface CancelRequest {
  id: string; // the local replayChallenges/{id} doc id, not Huub's challengeId
}

// Cancels a challenge sent by mistake — works whether the invited player
// hasn't joined yet or is already mid-hand (see Huub's cancelReplayChallenge
// for exactly what that does on their side). Deletes the local bookkeeping
// doc so it disappears from "Sent Huub challenges" — there's nothing left to
// pull status for once cancelled.
export const cancelHuubReplayChallenge = onCall(
  {region: REGION, serviceAccount: HIINAKAS_BRIDGE_SERVICE_ACCOUNT},
  async (request) => {
    requireAllowedUid(request.auth?.uid);

    const body = request.data as Partial<CancelRequest>;
    if (typeof body.id !== "string" || !body.id) {
      throw new HttpsError("invalid-argument", "id required");
    }

    const localRef = db.collection("replayChallenges").doc(body.id);
    const localSnap = await localRef.get();
    if (!localSnap.exists) {
      throw new HttpsError("not-found", "Challenge not found");
    }
    const huubChallengeId = localSnap.data()!.huubChallengeId as string;

    await callHuub(HUUB_CANCEL_URL, {challengeId: huubChallengeId});
    await localRef.delete();

    return {success: true};
  }
);
