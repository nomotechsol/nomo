import type { Connection } from "@solana/web3.js";

/** A replacement is safe only after finality proves the old blockhash expired and a newer history read finds no signature. */
export async function expiredSignatureAbsent(connection: Connection, signature: string,
  lastValidBlockHeight: number): Promise<boolean> {
  const tip = await connection.getEpochInfo("finalized");
  if (tip.blockHeight === undefined || !Number.isSafeInteger(tip.blockHeight))
    throw new Error("Finalized Solana block height is unavailable");
  if (tip.blockHeight <= lastValidBlockHeight) return false;
  const statuses = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  if (statuses.context.slot < tip.absoluteSlot)
    throw new Error("Solana signature history is behind the finalized tip");
  const status = statuses.value[0];
  if (status?.err) throw new Error(`Solana operation failed: ${JSON.stringify(status.err)}`);
  return status === null;
}
