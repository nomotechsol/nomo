import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { strict as assert } from "node:assert";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { createPublicClient, createWalletClient, defineChain, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BackendBscClaims } from "../src/claims/bsc-transfer.js";
import { confirmWalletLink, createWalletLinkChallenge } from "../src/claims/link.js";
import { candidateKey, type Candidate } from "../src/domain.js";
import { BackendEvmSigner } from "../src/execution/backend-evm-signer.js";
import { Store } from "../src/store.js";

const rpc = process.argv[2] ?? "http://127.0.0.1:19056";
const chainId = Number(process.argv[3] ?? 56);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(rpc) || (chainId !== 56 && chainId !== 4663))
  throw new Error("Use a local Anvil RPC and chain ID 56 or 4663");
const chainName = chainId === 56 ? "bsc" as const : "robinhood" as const;
const chain = defineChain({ id: chainId, name: `NOMO local ${chainName}`, nativeCurrency: {
  name: chainId === 56 ? "BNB" : "ETH", symbol: chainId === 56 ? "BNB" : "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } } });
const client = createPublicClient({ chain, transport: http(rpc) });
assert.equal(await client.getChainId(), chainId);
const deployer = privateKeyToAccount(generatePrivateKey());
const recipient = privateKeyToAccount(generatePrivateKey());
const rewardKey = generatePrivateKey();
const rewardAddress = privateKeyToAccount(rewardKey).address;
const folder = mkdtempSync(join(tmpdir(), "nomo-local-evm-claim-"));
const keyPath = join(folder, "reward.key");
writeFileSync(keyPath, rewardKey, { mode: 0o600 });
const store = new Store(":memory:");

async function rpcCall(method: string, params: unknown[]): Promise<void> {
  const response = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await response.json() as { error?: { message?: string } };
  if (!response.ok || body.error) throw new Error(`Local ${method} failed: ${body.error?.message ?? response.status}`);
}

try {
  for (const account of [deployer, recipient, { address: rewardAddress }])
    await rpcCall("anvil_setBalance", [account.address, `0x${parseEther("2").toString(16)}`]);
  const require = createRequire(import.meta.url);
  const solc = require("solc") as { compile(input: string): string };
  const source = `// SPDX-License-Identifier: UNLICENSED
    pragma solidity ^0.8.20;
    contract LocalRewardToken {
      mapping(address => uint256) public balanceOf;
      constructor(address owner) { balanceOf[owner] = 1000000; }
      function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
      }
    }`;
  const compiled = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity",
    sources: { "LocalRewardToken.sol": { content: source } },
    settings: { outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } }))) as {
    errors?: Array<{ severity: string; message: string }>;
    contracts: Record<string, Record<string, { abi: unknown[]; evm: { bytecode: { object: string } } }>>;
  };
  const errors = compiled.errors?.filter((item) => item.severity === "error") ?? [];
  if (errors.length) throw new Error(`Local test token compilation failed: ${errors[0]!.message}`);
  const contract = compiled.contracts["LocalRewardToken.sol"]!["LocalRewardToken"]!;
  const wallet = createWalletClient({ account: deployer, chain, transport: http(rpc) });
  const deployment = await wallet.deployContract({ abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}`,
    args: [rewardAddress] });
  const token = (await client.waitForTransactionReceipt({ hash: deployment })).contractAddress;
  if (!token) throw new Error("Local ERC-20 deployment has no address");

  const sol = nacl.sign.keyPair();
  const solWallet = bs58.encode(sol.publicKey);
  const candidate: Candidate = { chain: chainName, launchpad: chainName === "bsc" ? "flap_tax" : "pons_v2",
    token, pool: recipient.address, graduationTx: "0xlocal", graduatedAt: Date.now() };
  store.addCandidate(candidate);
  const candidateId = candidateKey(candidate);
  store.updateCandidate(candidateId, "eligible", []);
  store.startJob(candidateId);
  store.recordRound({ candidateId, purchaseTx: "local-buy", receivedAtoms: 700n,
    rewardDecimals: 0, snapshotSlot: 1, holders: [{ solWallet, rawBalance: 1_000_000n }] });
  store.advanceJob(candidateId, "reserved", "recorded", {});
  store.publishRound(candidateId, "root", "backend:publish", rewardAddress, chainId);

  const claims = new BackendBscClaims(store, rpc, BackendEvmSigner.fromFile(keyPath), chainName);
  await assert.rejects(() => claims.prepare(candidateId, solWallet), /linked wallet is unavailable/);
  const challenge = createWalletLinkChallenge(store, solWallet, recipient.address, "http://127.0.0.1");
  const solSignature = Buffer.from(nacl.sign.detached(new TextEncoder().encode(challenge.message),
    sol.secretKey)).toString("base64");
  const evmSignature = await recipient.signMessage({ message: challenge.message });
  await confirmWalletLink(store, challenge.id, solSignature, evmSignature);

  const quote = await claims.prepare(candidateId, solWallet);
  assert.equal(quote.chainId, chainId);
  assert.equal(quote.recipient, recipient.address);
  const payer = createWalletClient({ account: recipient, chain, transport: http(rpc) });
  const payment = await payer.sendTransaction({ to: rewardAddress, value: BigInt(quote.feeWei) });
  await client.waitForTransactionReceipt({ hash: payment });
  await rpcCall("anvil_mine", ["0x2"]);
  const first = await claims.finalize(candidateId, solWallet, payment);
  assert.equal(first.claimed, true);
  const second = await claims.finalize(candidateId, solWallet, payment);
  assert.equal(second.payoutHash, first.payoutHash);
  const balance = await client.readContract({ address: token,
    abi: [{ type: "function", name: "balanceOf", stateMutability: "view",
      inputs: [{ type: "address", name: "account" }], outputs: [{ type: "uint256" }] }],
    functionName: "balanceOf", args: [recipient.address] });
  assert.equal(balance, 700n);
  await assert.rejects(() => claims.prepare(candidateId, solWallet), /already claimed/);
  process.stdout.write(JSON.stringify({ chain: chainName, chainId, linked: true, gasReimbursed: true,
    claimed: true, deliveredAtoms: balance.toString(), repeatPayout: false,
    localOnly: true }) + "\n");
} finally {
  store.close();
  rmSync(folder, { recursive: true, force: true });
}
