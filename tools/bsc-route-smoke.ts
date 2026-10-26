import "dotenv/config";
import { getAddress, parseEther } from "viem";
import { Store } from "../src/store.js";
import { RelayBscSwap } from "../src/execution/relay-bsc-swap.js";

const token = process.argv[2];
const amount = process.argv[3] ?? "0.01";
if (!token || !process.env.BSC_RPC_URL) {
  console.error("Usage: npx tsx tools/bsc-route-smoke.ts <verified BNB token> [BNB amount]");
  process.exit(2);
}
const store = new Store(process.env.DATABASE_PATH ?? "./data/nomo.db");
try {
  const candidate = store.listCandidates(10_000).find((row) => row.candidate.chain === "bsc" &&
    row.candidate.token.toLowerCase() === token.toLowerCase())?.candidate;
  if (!candidate) throw new Error("Token is not a verified Flap/Four.meme candidate in the local store");
  const taker = getAddress("0x64D7f006b96862234298514253c7019af1633B0d");
  const quote = await new RelayBscSwap().quote(candidate, parseEther(amount), taker);
  const rpc = await fetch(process.env.BSC_RPC_URL, { method: "POST",
    headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ from: taker, to: quote.to, data: quote.data,
        value: `0x${quote.value.toString(16)}` }, "latest",
      { [taker]: { balance: "0x56BC75E2D63100000" } }] }),
  });
  const result = await rpc.json() as { result?: string; error?: { message?: string } };
  if (!rpc.ok || !result.result) throw new Error(result.error?.message ?? `BNB RPC HTTP ${rpc.status}`);
  console.log(JSON.stringify({ simulated: true, chainId: 56, launchpad: candidate.launchpad,
    target: quote.token, nativeInputWei: quote.amountIn.toString(),
    expectedOutputAtoms: quote.expectedOut.toString(), minimumOutputAtoms: quote.minimumOut.toString(),
    router: quote.to, sent: false }, null, 2));
} finally { store.close(); }
