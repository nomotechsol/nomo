import "dotenv/config";
import { type Address } from "viem";
import { ZeroExEvmPurchaseRoutes } from "../src/execution/evm-routes.js";
import { Store } from "../src/store.js";

const store = new Store(process.env.DATABASE_PATH ?? "./data/nomo.db");
try {
  const token = process.argv[2];
  if (!token || !process.env.ZEROX_API_KEY) throw new Error("A token and ZEROX_API_KEY are required");
  const candidate = store.listCandidates(10_000).find((row) =>
    row.candidate.chain !== "sol" && row.candidate.token.toLowerCase() === token.toLowerCase())?.candidate;
  if (!candidate) throw new Error("Candidate is absent from the local cache");
  const nativeAtoms = BigInt(process.argv[3] ?? "10000000000000000");
  const taker = "0x000000000000000000000000000000000000dEaD" as Address;
  const route = await new ZeroExEvmPurchaseRoutes(process.env.ZEROX_API_KEY)
    .price(candidate, nativeAtoms, taker);
  process.stdout.write(JSON.stringify({ chainId: route.chainId, target: route.target,
    pairQuote: route.poolQuoteToken, minimumTargetAtoms: route.minimumTargetAtoms.toString(),
    sources: route.sources }) + "\n");
} catch (error) {
  // An HTTP client error may include its full request URL; never print it with credentials.
  process.stderr.write(`EVM route probe failed (${error instanceof Error ? error.name : "unknown"}).\n`);
  process.exitCode = 1;
} finally {
  store.close();
}
