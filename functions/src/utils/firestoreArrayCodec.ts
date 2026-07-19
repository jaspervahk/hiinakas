// Firestore rejects directly-nested arrays ([[...], [...]]) as a document
// field value. Several ChallengeHandInput fields (targetNormalHands,
// opponentNormalPlacements, humanBonusReplay.sideHands — one entry per
// turn/street) are exactly that shape. Wrap each inner array in a
// single-field object before writing to Firestore, unwrap after reading.
export function wrapRows<T>(rows: T[][]): {row: T[]}[] {
  return rows.map((row) => ({row}));
}

export function unwrapRows<T>(wrapped: {row: T[]}[]): T[][] {
  return wrapped.map((w) => w.row);
}
