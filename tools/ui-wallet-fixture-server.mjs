// Local-only browser fixture. It never connects to an RPC or uses real keys.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";

const root = resolve("web-dist");
const port = Number(process.env.NOMO_UI_FIXTURE_PORT ?? 8791);
const evm = `0x${"1".repeat(40)}`;
const hash = `0x${"a".repeat(64)}`;
let linked = false;
const claimed = new Set();
const rewards = [
  { candidateId: "fixture-sol", chain: "sol", launchpad: "pumpfun", token: "So11111111111111111111111111111111111111112",
    rewardAtoms: "700000000", rewardDecimals: 9, purchaseTx: "local-sol-buy", snapshotSlot: 1,
    claimReady: false, deliveryMode: "push", payoutState: "sent", payoutTx: "local-sol-payout" },
  { candidateId: "fixture-bsc", chain: "bsc", launchpad: "flap_tax", token: `0x${"2".repeat(40)}`,
    rewardAtoms: "1000000000000000000", rewardDecimals: 18, purchaseTx: "local-bsc-buy", snapshotSlot: 1,
    claimReady: true, deliveryMode: "claim" },
  { candidateId: "fixture-rh", chain: "robinhood", launchpad: "pons_v2", token: `0x${"3".repeat(40)}`,
    rewardAtoms: "2000000000000000000", rewardDecimals: 18, purchaseTx: "local-rh-buy", snapshotSlot: 1,
    claimReady: true, deliveryMode: "claim" },
];
const walletScript = `<script>
(() => {
  const account = Object.freeze({ address: "11111111111111111111111111111111", publicKey: new Uint8Array(32),
    chains: ["solana:mainnet"], features: ["solana:signMessage"] });
  const wallet = Object.freeze({ version: "1.0.0", name: "Local test wallet", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
    chains: ["solana:mainnet"], accounts: [account], features: {
      "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
      "solana:signMessage": { version: "1.0.0", signMessage: async ({ message }) =>
        [{ signedMessage: message, signature: new Uint8Array(64) }] }
    } });
  window.addEventListener("wallet-standard:app-ready", (event) => event.detail.register(wallet));
  let chainId = "0x1";
  window.ethereum = { request: async ({ method, params }) => {
    if (method === "eth_requestAccounts") return ["${evm}"];
    if (method === "eth_chainId") return chainId;
    if (method === "wallet_switchEthereumChain") { chainId = params[0].chainId; return null; }
    if (method === "personal_sign") return "0x" + "b".repeat(130);
    if (method === "eth_sendTransaction") return "${hash}";
    throw new Error("Unsupported fixture wallet method: " + method);
  } };
})();
</script>`;
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
function json(response, value, code = 200) {
  response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}
createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
    if (pathname === "/health") return json(response, { mode: "read_only", lastPollError: null });
    if (pathname === "/api/activity") return json(response, { items: [] });
    if (pathname === "/api/stats") return json(response, { count: 0, solBudgetLamports: null, totalUsd: 0,
      chains: { sol: { count: 0, nativeUnit: "SOL", spendAtoms: null, usd: 0, price: null },
        bsc: { count: 0, nativeUnit: "BNB", spendAtoms: null, usd: 0, price: null },
        robinhood: { count: 0, nativeUnit: "ETH", spendAtoms: null, usd: 0, price: null } } });
    if (pathname === "/api/stats/purchases") return json(response, { items: [], nextCursor: null });
    if (pathname.startsWith("/api/rewards/")) return json(response, { items: rewards.map((item) => ({
      ...item, claimed: item.deliveryMode === "push" || claimed.has(item.candidateId),
    })) });
    if (pathname.startsWith("/api/link/") && request.method === "GET") return json(response, { linked: linked ? evm : null });
    if (pathname === "/api/link/challenge") return json(response, { id: "fixture-link", message: "NOMO local wallet fixture" });
    if (pathname === "/api/link/confirm") { linked = true; return json(response, { linked: evm }); }
    if (/^\/api\/claims\/(bsc|rh)\/prepare$/.test(pathname)) {
      const rh = pathname.includes("/rh/");
      return json(response, { chainId: rh ? 4663 : 56, recipient: evm, gasWallet: `0x${"4".repeat(40)}`, feeWei: "100000000000000" });
    }
    if (/^\/api\/claims\/(bsc|rh)\/finalize$/.test(pathname)) {
      const rh = pathname.includes("/rh/");
      claimed.add(rh ? "fixture-rh" : "fixture-bsc");
      return json(response, { claimed: true, payoutHash: hash });
    }
    const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(root + "/")) return json(response, { error: "not_found" }, 404);
    if (!(await stat(file)).isFile()) return json(response, { error: "not_found" }, 404);
    let content = await readFile(file);
    if (pathname === "/") content = Buffer.from(content.toString().replace("</head>", `${walletScript}</head>`));
    response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    response.end(content);
  } catch { json(response, { error: "not_found" }, 404); }
}).listen(port, "127.0.0.1", () => process.stdout.write(`NOMO local UI fixture on 127.0.0.1:${port}\n`));
