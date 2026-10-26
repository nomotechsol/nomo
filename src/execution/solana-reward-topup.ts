import { Connection, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { Store } from "../store.js";
import type { SolanaTransactionSigner } from "./solana-buy.js";
import { SolanaOperationSender } from "./solana-sender.js";

export type SolanaRewardTopUpConfig = {
  thresholdLamports: number;
  amountLamports: number;
  treasuryReserveLamports: number;
};

type TopUpRow = { id: number; amountLamports: number; treasuryWallet: string;
  rewardWallet: string; state: "pending" | "confirmed" | "cancelled" };

/** Bounded, journalled SOL funding for the payout wallet. Only one transfer can be pending. */
export class SolanaRewardTopUp {
  private readonly sender: SolanaOperationSender;
  private running = false;

  constructor(private readonly store: Store, private readonly connection: Connection,
    private readonly treasurySigner: SolanaTransactionSigner,
    private readonly rewardSigner: SolanaTransactionSigner,
    private readonly config: SolanaRewardTopUpConfig) {
    const { thresholdLamports, amountLamports, treasuryReserveLamports } = config;
    if (treasurySigner.publicKey.equals(rewardSigner.publicKey) ||
        ![thresholdLamports, amountLamports, treasuryReserveLamports]
          .every((value) => Number.isSafeInteger(value) && value > 0) ||
        thresholdLamports > 200_000_000 || amountLamports > 500_000_000 ||
        treasuryReserveLamports < 4_000_000_000 || amountLamports <= thresholdLamports)
      throw new Error("Unsafe Solana reward top-up configuration");
    store.db.exec(`CREATE TABLE IF NOT EXISTS solana_reward_topups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount_lamports INTEGER NOT NULL,
      treasury_wallet TEXT NOT NULL,
      reward_wallet TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'confirmed', 'cancelled')),
      signature TEXT,
      created_at INTEGER NOT NULL,
      confirmed_at INTEGER
    )`);
    store.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS one_pending_solana_reward_topup
      ON solana_reward_topups(state) WHERE state = 'pending'`);
    this.sender = new SolanaOperationSender(store, connection, treasurySigner);
  }

  async tick(): Promise<string | undefined> {
    if (this.running) return undefined;
    this.running = true;
    try {
      let row = this.store.db.prepare(`SELECT id, amount_lamports AS amountLamports,
        treasury_wallet AS treasuryWallet, reward_wallet AS rewardWallet, state
        FROM solana_reward_topups WHERE state = 'pending' ORDER BY id LIMIT 1`)
        .get() as TopUpRow | undefined;
      if (row && (row.treasuryWallet !== this.treasurySigner.publicKey.toBase58() ||
          row.rewardWallet !== this.rewardSigner.publicKey.toBase58() ||
          row.amountLamports > this.config.amountLamports))
        throw new Error("Pending Solana reward top-up does not match configured wallets or limit");
      if (row && !this.store.db.prepare(`SELECT 1 FROM solana_signed_operations
          WHERE operation_id = ?`).get(`reward-topup:${row.id}`) &&
          await this.connection.getBalance(this.rewardSigner.publicKey, "confirmed") >=
            this.config.thresholdLamports) {
        this.store.db.prepare(`UPDATE solana_reward_topups SET state = 'cancelled'
          WHERE id = ? AND state = 'pending'`).run(row.id);
        return undefined;
      }
      if (!row) {
        const rewardBalance = await this.connection.getBalance(this.rewardSigner.publicKey, "confirmed");
        if (rewardBalance >= this.config.thresholdLamports) return undefined;
        const lastConfirmed = this.store.db.prepare(`SELECT confirmed_at AS confirmedAt
          FROM solana_reward_topups WHERE state = 'confirmed'
          ORDER BY confirmed_at DESC LIMIT 1`).get() as { confirmedAt: number } | undefined;
        // Give the confirmed balance time to become visible across RPC backends.
        if (lastConfirmed && Date.now() - lastConfirmed.confirmedAt < 60_000) return undefined;
        const result = this.store.db.prepare(`INSERT INTO solana_reward_topups
          (amount_lamports, treasury_wallet, reward_wallet, state, created_at)
          VALUES (?, ?, ?, 'pending', ?)`).run(this.config.amountLamports,
          this.treasurySigner.publicKey.toBase58(), this.rewardSigner.publicKey.toBase58(), Date.now());
        row = { id: Number(result.lastInsertRowid), amountLamports: this.config.amountLamports,
          treasuryWallet: this.treasurySigner.publicKey.toBase58(),
          rewardWallet: this.rewardSigner.publicKey.toBase58(), state: "pending" };
      }
      const signature = await this.sender.execute(`reward-topup:${row.id}`, async () => {
        const latest = await this.connection.getLatestBlockhash("confirmed");
        const message = new TransactionMessage({ payerKey: this.treasurySigner.publicKey,
          recentBlockhash: latest.blockhash,
          instructions: [SystemProgram.transfer({ fromPubkey: this.treasurySigner.publicKey,
            toPubkey: this.rewardSigner.publicKey, lamports: row.amountLamports })],
        }).compileToV0Message();
        const [balance, fee] = await Promise.all([
          this.connection.getBalance(this.treasurySigner.publicKey, "confirmed"),
          this.connection.getFeeForMessage(message, "confirmed"),
        ]);
        if (fee.value === null || balance - row.amountLamports - fee.value <
            this.config.treasuryReserveLamports)
          throw new Error("Solana treasury reserve blocks reward top-up");
        return new VersionedTransaction(message);
      });
      this.store.db.prepare(`UPDATE solana_reward_topups
        SET state = 'confirmed', signature = ?, confirmed_at = ? WHERE id = ? AND state = 'pending'`)
        .run(signature, Date.now(), row.id);
      return signature;
    } finally { this.running = false; }
  }
}
