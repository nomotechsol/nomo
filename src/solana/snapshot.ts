import { createRequire } from "node:module";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { type Holder } from "../domain.js";

const require = createRequire(import.meta.url);
const { bondingCurvePda, bondingCurveV2Pda, pumpPoolAuthorityPda } = require("@pump-fun/pump-sdk") as typeof import("@pump-fun/pump-sdk");
const { canonicalPumpPoolPda, PUMP_AMM_SDK } = require("@pump-fun/pump-swap-sdk") as typeof import("@pump-fun/pump-swap-sdk");

const PUMP_MINT = new PublicKey("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");
export const MIN_NOMO_HOLDER_TOKENS = 1_000_000n;
const RPC_TIMEOUT_MS = 45_000;

export function eligibleNomoHolders(balances: ReadonlyMap<string, bigint>, decimals: number): Holder[] {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("Invalid mint decimals");
  const minimumAtoms = MIN_NOMO_HOLDER_TOKENS * 10n ** BigInt(decimals);
  return [...balances]
    .filter(([wallet, atoms]) => atoms >= minimumAtoms && PublicKey.isOnCurve(new PublicKey(wallet).toBytes()))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([solWallet, rawBalance]) => ({ solWallet, rawBalance }));
}

type RawAccount = { pubkey: string; account: { data: [string, string] } };
type RawProgramAccounts = { context: { slot: number }; value: RawAccount[] };

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "nomo-snapshot", method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Solana RPC ${method}: HTTP ${response.status}`);
  const json = await response.json() as { result?: T; error?: { message?: string } };
  if (json.error || json.result === undefined) throw new Error(`Solana RPC ${method}: ${json.error?.message ?? "missing result"}`);
  return json.result;
}

export async function pumpLpExclusions(connection: Connection, mainMint: PublicKey): Promise<Set<string>> {
  const excluded = new Set<string>([
    bondingCurvePda(mainMint).toBase58(),
    bondingCurveV2Pda(mainMint).toBase58(),
    pumpPoolAuthorityPda(mainMint).toBase58(),
  ]);
  const pool = canonicalPumpPoolPda(mainMint, PUMP_MINT);
  const poolAccount = await connection.getAccountInfo(pool, "finalized");
  if (poolAccount) {
    const decoded = PUMP_AMM_SDK.decodePool(poolAccount);
    excluded.add(decoded.poolBaseTokenAccount.toBase58());
    excluded.add(pool.toBase58());
  }
  return excluded;
}

/** One finalized RPC bank view, so all holders share the same slot. */
export async function finalizedHolderSnapshot(options: {
  rpcUrl: string;
  mainMint: string;
  extraExcludedAccounts?: string[];
}): Promise<{ slot: number; holders: Holder[]; excluded: string[]; decimals: number }> {
  const mint = new PublicKey(options.mainMint);
  const connection = new Connection(options.rpcUrl, "finalized");
  const mintInfo = await connection.getAccountInfo(mint, "finalized");
  if (!mintInfo) throw new Error("Main token mint does not exist");
  const program = mintInfo.owner;
  if (!program.equals(TOKEN_PROGRAM_ID) && !program.equals(TOKEN_2022_PROGRAM_ID)) throw new Error("Unsupported main token program");
  if (mintInfo.data.length < 45) throw new Error("Invalid mint account length");
  const decimals = mintInfo.data[44];
  if (decimals === undefined || decimals > 18) throw new Error("Invalid mint decimals");
  const excluded = await pumpLpExclusions(connection, mint);
  for (const value of options.extraExcludedAccounts ?? []) excluded.add(new PublicKey(value).toBase58());
  const filters: Array<Record<string, unknown>> = [{ memcmp: { offset: 0, bytes: mint.toBase58() } }];
  if (program.equals(TOKEN_PROGRAM_ID)) filters.push({ dataSize: 165 });
  const result = await rpc<RawProgramAccounts>(options.rpcUrl, "getProgramAccounts", [
    program.toBase58(),
    { commitment: "finalized", withContext: true, encoding: "base64", dataSlice: { offset: 0, length: 72 }, filters },
  ]);
  if (!Number.isSafeInteger(result.context?.slot) || !Array.isArray(result.value)) throw new Error("Incomplete holder snapshot response");
  const balances = new Map<string, bigint>();
  for (const row of result.value) {
    if (excluded.has(row.pubkey)) continue;
    const raw = Buffer.from(row.account?.data?.[0] ?? "", "base64");
    if (raw.length !== 72) throw new Error("Truncated token account data");
    if (!new PublicKey(raw.subarray(0, 32)).equals(mint)) throw new Error("Mint mismatch in holder snapshot");
    const ownerKey = new PublicKey(raw.subarray(32, 64));
    const owner = ownerKey.toBase58();
    if (excluded.has(owner)) continue;
    const amount = raw.readBigUInt64LE(64);
    if (amount > 0n) balances.set(owner, (balances.get(owner) ?? 0n) + amount);
  }
  const holders = eligibleNomoHolders(balances, decimals);
  if (holders.length === 0) throw new Error("No eligible holders at finalized snapshot");
  return { slot: result.context.slot, holders, excluded: [...excluded].sort(), decimals };
}
