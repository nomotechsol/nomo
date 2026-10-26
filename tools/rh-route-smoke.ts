import "dotenv/config";
import Database from "better-sqlite3";
import { createPublicClient, getAddress, http, parseEther } from "viem";
import type { Candidate } from "../src/domain.js";
import { PonsV4Swap } from "../src/execution/pons-v4-swap.js";
import { robinhood } from "../src/evm/scanner.js";

const token = getAddress(process.argv[2] ?? "");
const amount = parseEther(process.argv[3] ?? "0.01");
const rpcUrl = process.env.RH_RPC_URL;
if (!rpcUrl || amount <= 0n) throw new Error("RH_RPC_URL and a positive ETH amount are required");
const db = new Database(process.env.DATABASE_PATH ?? "./data/nomo.db", { readonly: true });
const row = db.prepare("SELECT candidate_json FROM candidates WHERE chain = 'robinhood' AND token = ?")
  .get(token.toLowerCase()) as { candidate_json: string } | undefined;
db.close();
if (!row) throw new Error("This Pons V2 token has not been verified by the local scanner");
const candidate = JSON.parse(row.candidate_json) as Candidate;
const sender = "0x03508bb71268bba25ecacc8f620e01866650532c";
const quote = await new PonsV4Swap(rpcUrl).quote(candidate, amount, sender);
const client = createPublicClient({ chain: robinhood, transport: http(rpcUrl) });
if (await client.getChainId() !== 4663) throw new Error("RH RPC chain mismatch");
await client.call({ account: sender, to: quote.to, data: quote.data, value: quote.value,
  gas: 2_000_000n, stateOverride: [{ address: sender, balance: amount * 2n + parseEther("1") }] });
console.log(JSON.stringify({ token, pairAsset: candidate.quoteToken, pool: candidate.pool,
  spendWei: amount.toString(), expectedOutAtoms: quote.expectedOut.toString(),
  minimumOutAtoms: quote.minimumOut.toString(), chainId: 4663, simulated: true }));
