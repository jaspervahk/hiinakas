// Bridge to Huub's "Challenge vs Bot" feature — unlike replayBridge.ts's
// historical-session replay, this sends no hand data at all: just a target
// username, a sims count, and a number of hands. Huub deals fresh hands live
// and a bot (heuristicBot/) computes its own placement each street; the real
// player plays against it in real time. See replayBridge.ts's header for the
// IAM bridge pattern this reuses unchanged (same service account, same
// "no shared secret" design).
import {onCall, HttpsError} from "firebase-functions/v2/https";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import {GoogleAuth} from "google-auth-library";

const REGION = "europe-west1";
const HIINAKAS_BRIDGE_SERVICE_ACCOUNT = "hiinakas-bridge@hiinakas-355.iam.gserviceaccount.com";
const ALLOWED_UID = "7d3zgIRy43OClSXUDhnsLmhDNwg2";

// Verified via `gcloud run services list --project=huub-c4e5b` after Huub's
// first deploy of these functions — newer Cloud Run deployments in this
// project get project-number-based URLs, not the older short-hash format
// replayBridge.ts's HUUB_*_URL constants use (that older format still works
// for those already-deployed services, but isn't the pattern new services get).
const HUUB_CREATE_URL = "https://createbotchallenge-453674862477.europe-west1.run.app";
const HUUB_STATUS_URL = "https://getbotchallengestatus-453674862477.europe-west1.run.app";
const HUUB_CANCEL_URL = "https://cancelbotchallenge-453674862477.europe-west1.run.app";

// Mirrors botChallengeServer.ts's own clamps — defense in depth, since a
// client-side bug or a stale UI build shouldn't be able to send an
// unreasonable sims/hands count into a production app with real other users.
const MIN_SIMS = 10;
const MAX_SIMS = 150;
const DEFAULT_SIMS = 60;
const MAX_TOTAL_HANDS = 50;

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

function clampSims(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : DEFAULT_SIMS;
  return Math.max(MIN_SIMS, Math.min(MAX_SIMS, v));
}
function clampTotalHands(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 1;
  return Math.max(1, Math.min(MAX_TOTAL_HANDS, v));
}

// ── Callables ──────────────────────────────────────────────────────────────

interface CreateBotChallengeRequest {
  targetUsername: string;
  sims: number;
  totalHands: number;
}

interface CreateBotChallengeResponse {
  challengeId: string;
}

export const createHuubBotChallenge = onCall(
  {region: REGION, serviceAccount: HIINAKAS_BRIDGE_SERVICE_ACCOUNT},
  async (request) => {
    requireAllowedUid(request.auth?.uid);

    const body = request.data as Partial<CreateBotChallengeRequest>;
    if (typeof body.targetUsername !== "string" || !body.targetUsername) {
      throw new HttpsError("invalid-argument", "targetUsername required");
    }
    const sims = clampSims(body.sims);
    const totalHands = clampTotalHands(body.totalHands);

    const huubResponse = await callHuub<CreateBotChallengeResponse>(HUUB_CREATE_URL, {
      targetUsername: body.targetUsername,
      sims,
      totalHands,
    });

    const localRef = db.collection("botChallenges").doc();
    await localRef.set({
      huubChallengeId: huubResponse.challengeId,
      huubUsername: body.targetUsername,
      sims,
      totalHands,
      createdAt: FieldValue.serverTimestamp(),
    });

    return {id: localRef.id, huubChallengeId: huubResponse.challengeId};
  }
);

interface GetStatusRequest {
  huubChallengeId: string;
}

export const getHuubBotChallengeStatus = onCall(
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
  id: string; // the local botChallenges/{id} doc id, not Huub's challengeId
}

export const cancelHuubBotChallenge = onCall(
  {region: REGION, serviceAccount: HIINAKAS_BRIDGE_SERVICE_ACCOUNT},
  async (request) => {
    requireAllowedUid(request.auth?.uid);

    const body = request.data as Partial<CancelRequest>;
    if (typeof body.id !== "string" || !body.id) {
      throw new HttpsError("invalid-argument", "id required");
    }

    const localRef = db.collection("botChallenges").doc(body.id);
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
