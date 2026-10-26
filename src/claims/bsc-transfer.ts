import { encodeFunctionData, getAddress, parseAbi, type Hex } from "viem";
import { Store } from "../store.js";
import { BackendEvmSigner } from "../execution/backend-evm-signer.js";
import { EvmOperationSender } from "../execution/evm-sender.js";

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)"]);
type ClaimRow = { recipient: string; reimbursementHash: string; beforeBalance: string;
  payoutHash: string | null; state: string };
type QuoteRow = { recipient: string; feeWei: string; expiresAt: number };

/** No custom contract: wallet reimburses native gas, backend sends the ERC-20 reward. */
export class BackendBscClaims {
  private readonly sender;
  private readonly chainId: 56 | 4663;
  private readonly quotesTable: "bsc_claim_quotes" | "rh_claim_quotes";
  private readonly claimsTable: "bsc_claims" | "rh_claims";
  constructor(private readonly store: Store, rpcUrl: string, private readonly reward: BackendEvmSigner,
    private readonly chain: "bsc" | "robinhood" = "bsc") {
    this.chainId = chain === "bsc" ? 56 : 4663;
    this.quotesTable = chain === "bsc" ? "bsc_claim_quotes" : "rh_claim_quotes";
    this.claimsTable = chain === "bsc" ? "bsc_claims" : "rh_claims";
    this.sender = new EvmOperationSender(store, rpcUrl, reward, chain);
    store.db.exec(`CREATE TABLE IF NOT EXISTS ${this.quotesTable} (
      candidate_id TEXT NOT NULL, sol_wallet TEXT NOT NULL, recipient TEXT NOT NULL,
      fee_wei TEXT NOT NULL, expires_at INTEGER NOT NULL,
      PRIMARY KEY(candidate_id, sol_wallet));
      CREATE TABLE IF NOT EXISTS ${this.claimsTable} (
      candidate_id TEXT NOT NULL, sol_wallet TEXT NOT NULL, recipient TEXT NOT NULL,
      reimbursement_hash TEXT NOT NULL UNIQUE, before_balance TEXT NOT NULL,
      payout_hash TEXT, state TEXT NOT NULL CHECK(state IN ('prepared','claimed')),
      PRIMARY KEY(candidate_id, sol_wallet))`);
  }

  getClaim(candidateId: string, solWallet: string): { claimed: boolean; payoutHash: string | null } | undefined {
    const row = this.store.db.prepare(`SELECT state, payout_hash AS payoutHash FROM ${this.claimsTable}
      WHERE candidate_id = ? AND sol_wallet = ?`).get(candidateId, solWallet) as
      { state: string; payoutHash: string | null } | undefined;
    return row ? { claimed: row.state === "claimed", payoutHash: row.payoutHash } : undefined;
  }

  async prepare(candidateId: string, solWallet: string) {
    const { token, recipient, amount } = this.allocation(candidateId, solWallet);
    const old = this.store.db.prepare(`SELECT recipient, reimbursement_hash AS reimbursementHash,
      state FROM ${this.claimsTable} WHERE candidate_id = ? AND sol_wallet = ?`)
      .get(candidateId, solWallet) as { recipient: string; reimbursementHash: string; state: string } | undefined;
    if (old?.state === "claimed") throw new Error("EVM allocation already claimed");
    if (old) {
      if (old.recipient.toLowerCase() !== recipient.toLowerCase())
        throw new Error("Linked EVM wallet changed during an active claim");
      return { chainId: this.chainId, recipient, gasWallet: this.reward.account.address,
        feeWei: "0", expiresAt: 0, token, rewardAtoms: amount.toString(),
        reimbursementHash: old.reimbursementHash };
    }
    const data = encodeFunctionData({ abi: erc20, functionName: "transfer", args: [recipient, amount] });
    const [estimated, gasPrice] = await Promise.all([
      this.sender.client.estimateGas({ account: this.reward.account.address, to: token, data }),
      this.sender.client.getGasPrice(),
    ]);
    const feeWei = (estimated * 125n / 100n + 20_000n) * gasPrice * 2n;
    const expiresAt = Date.now() + 5 * 60_000;
    this.store.db.prepare(`INSERT INTO ${this.quotesTable} (candidate_id, sol_wallet, recipient, fee_wei, expires_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(candidate_id, sol_wallet) DO UPDATE SET
      recipient = excluded.recipient, fee_wei = excluded.fee_wei, expires_at = excluded.expires_at`)
      .run(candidateId, solWallet, recipient, feeWei.toString(), expiresAt);
    return { chainId: this.chainId, recipient, gasWallet: this.reward.account.address,
      feeWei: feeWei.toString(), expiresAt, token, rewardAtoms: amount.toString() };
  }

  async finalize(candidateId: string, solWallet: string, reimbursementHash: Hex) {
    const { token, recipient, amount } = this.allocation(candidateId, solWallet);
    const current = this.store.db.prepare(`SELECT recipient, reimbursement_hash AS reimbursementHash,
      before_balance AS beforeBalance, payout_hash AS payoutHash, state FROM ${this.claimsTable}
      WHERE candidate_id = ? AND sol_wallet = ?`).get(candidateId, solWallet) as ClaimRow | undefined;
    if (current?.state === "claimed") return { claimed: true, payoutHash: current.payoutHash };
    if (current && current.recipient.toLowerCase() !== recipient.toLowerCase())
      throw new Error("Linked EVM wallet changed during an active claim");
    if (current && current.reimbursementHash.toLowerCase() !== reimbursementHash.toLowerCase())
      throw new Error("Another reimbursement is already attached to this allocation");
    if (!current) {
      const quote = this.store.db.prepare(`SELECT recipient, fee_wei AS feeWei, expires_at AS expiresAt
        FROM ${this.quotesTable} WHERE candidate_id = ? AND sol_wallet = ?`)
        .get(candidateId, solWallet) as QuoteRow | undefined;
      if (!quote || quote.recipient.toLowerCase() !== recipient.toLowerCase())
        throw new Error("EVM claim quote expired or wallet link changed");
      const [payment, receipt, tip, before] = await Promise.all([
        this.sender.client.getTransaction({ hash: reimbursementHash }),
        this.sender.client.getTransactionReceipt({ hash: reimbursementHash }),
        this.sender.client.getBlockNumber(),
        this.sender.client.readContract({ address: token, abi: erc20,
          functionName: "balanceOf", args: [recipient] }),
      ]);
      const mined = await this.sender.client.getBlock({ blockNumber: receipt.blockNumber });
      if (receipt.status !== "success" || tip < receipt.blockNumber + 2n ||
          Number(mined.timestamp) * 1000 > quote.expiresAt + 30_000 ||
          payment.chainId !== this.chainId || payment.from.toLowerCase() !== recipient.toLowerCase() ||
          payment.to?.toLowerCase() !== this.reward.account.address.toLowerCase() ||
          payment.value < BigInt(quote.feeWei) || (payment.input !== "0x" && payment.input !== undefined))
        throw new Error("EVM gas reimbursement is not confirmed or does not match this wallet");
      const inserted = this.store.db.prepare(`INSERT OR IGNORE INTO ${this.claimsTable}
        (candidate_id, sol_wallet, recipient, reimbursement_hash, before_balance, state)
        VALUES (?, ?, ?, ?, ?, 'prepared')`).run(candidateId, solWallet, recipient,
          reimbursementHash.toLowerCase(), before.toString());
      if (!inserted.changes) throw new Error("EVM reimbursement already used");
    }
    const row = current ?? this.store.db.prepare(`SELECT recipient, reimbursement_hash AS reimbursementHash,
      before_balance AS beforeBalance, payout_hash AS payoutHash, state FROM ${this.claimsTable}
      WHERE candidate_id = ? AND sol_wallet = ?`).get(candidateId, solWallet) as ClaimRow;
    const data = encodeFunctionData({ abi: erc20, functionName: "transfer", args: [recipient, amount] });
    const payoutHash = await this.sender.execute(`${this.chain}:claim:${candidateId}:${solWallet}`,
      { to: token, data, value: 0n });
    const after = await this.sender.client.readContract({ address: token, abi: erc20,
      functionName: "balanceOf", args: [recipient] });
    if (after <= BigInt(row.beforeBalance)) throw new Error("EVM reward transfer did not credit recipient");
    this.store.db.prepare(`UPDATE ${this.claimsTable} SET state = 'claimed', payout_hash = ?
      WHERE candidate_id = ? AND sol_wallet = ?`).run(payoutHash, candidateId, solWallet);
    return { claimed: true, payoutHash };
  }

  private allocation(candidateId: string, solWallet: string) {
    const candidate = this.store.getCandidate(candidateId)?.candidate;
    const published = this.store.getPublishedRound(candidateId);
    const amount = this.store.allocationsForWallet(solWallet)
      .find((row) => row.candidateId === candidateId)?.rewardAtoms;
    const linked = this.store.getWalletLink(solWallet)?.evmWallet;
    if (candidate?.chain !== this.chain || !published || published.chainId !== this.chainId ||
        published.claimTarget?.toLowerCase() !== this.reward.account.address.toLowerCase() ||
        !amount || BigInt(amount) <= 0n || !linked)
      throw new Error("EVM allocation or linked wallet is unavailable");
    return { token: getAddress(candidate.token), recipient: getAddress(linked), amount: BigInt(amount) };
  }
}
