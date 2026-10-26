import "dotenv/config";
import { Connection, Keypair } from "@solana/web3.js";
import { PumpPurchaseQuotes, RaydiumFundingQuotes, RaydiumRouteUnavailable, StonkPurchaseQuotes } from
  "../src/execution/solana-routes.js";
import { Store } from "../src/store.js";

const tokens = process.argv.slice(2);
const store = new Store(process.env.DATABASE_PATH ?? "./data/nomo.db");
try {
  if (!process.env.HELIUS_RPC_URL || tokens.length === 0) throw new Error("Missing RPC or tokens");
  const connection = new Connection(process.env.HELIUS_RPC_URL, "finalized");
  const pump = new PumpPurchaseQuotes(connection, new RaydiumFundingQuotes(connection));
  const stonk = new StonkPurchaseQuotes(connection);
  const user = Keypair.generate().publicKey; // Only used for quote account derivation.
  for (const token of tokens) {
    const candidate = store.listCandidates(10_000).find((row) => row.candidate.token === token)?.candidate;
    if (!candidate) throw new Error("Candidate is absent from the local cache");
    if (candidate.launchpad === "stonkfun") {
      const quote = await stonk.quote(candidate, 10_000_000n);
      process.stdout.write(JSON.stringify({ target: token, route: "raydium", quote: quote.quoteMint,
        fundingPools: quote.pools.length, pools: quote.pools }) + "\n");
      continue;
    }
    try {
      const direct = await pump.quote(candidate, 10_000_000n, user);
      process.stdout.write(JSON.stringify({ target: token, route: "direct", quote: direct.quoteMint,
        fundingPools: direct.funding?.pools.length ?? 0 }) + "\n");
    } catch (error) {
      if (!(error instanceof RaydiumRouteUnavailable)) throw error;
      const nested = await pump.planNestedRoute(candidate, 10_000_000n);
      process.stdout.write(JSON.stringify({ target: token, route: "nested", path: nested.path,
        fundingPools: nested.funding?.pools.length ?? 0 }) + "\n");
    }
  }
} catch (error) {
  // Provider exceptions may contain credential-bearing URLs.
  const detail = error instanceof Error ? error.message
    .replace(/https?:\/\/[^\s"']+/g, "[rpc]")
    .replace(/[A-Za-z0-9_-]{48,}/g, "[id]").slice(0, 350) : "unknown";
  process.stderr.write(`Route planning failed (${error instanceof Error ? error.name : "unknown"}): ${detail}.\n`);
  process.exitCode = 1;
} finally {
  store.close();
}
