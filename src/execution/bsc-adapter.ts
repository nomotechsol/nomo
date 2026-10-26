import { createHash } from "node:crypto";
import { Connection, PublicKey, TransactionInstruction, TransactionMessage,
  VersionedTransaction } from "@solana/web3.js";
import { encodeFunctionData, getAddress, parseAbi, type Address } from "viem";
import type { Allocation, Candidate } from "../domain.js";
import { Store } from "../store.js";
import type { BuyReceipt, ExecutionAdapter, FundingReceipt, PublicationReceipt,
  SnapshotReceipt } from "./engine.js";
import { BackendSolanaSigner } from "./backend-solana-signer.js";
import { BackendEvmSigner } from "./backend-evm-signer.js";
import { EvmOperationSender } from "./evm-sender.js";
import { RelayBridgeQuotes } from "./relay-bridge.js";
import { RelayBscSwap, type BscSwapQuote } from "./relay-bsc-swap.js";
import { PonsV4Swap, PonsV4RouteUnavailableError } from "./pons-v4-swap.js";
import { SolanaExecutionAdapter } from "./solana-adapter.js";
import { SolanaOperationSender } from "./solana-sender.js";

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)", "function transfer(address,uint256) returns (bool)"]);
const reserveDefault = 2_000_000_000_000_000n; // 0.002 native BNB/ETH
type BridgeRow = { requestId: string; initialBalance: string; minimum: string; signature: string | null };
type BuyRow = { initialBalance: string; spend: string };

/** SOL creator fees → Relay bridge → EVM swap → 70% in backend reward wallet. */
export class BscExecutionAdapter implements ExecutionAdapter {
  private readonly evm: EvmOperationSender;
  private readonly solSender: SolanaOperationSender;
  private readonly bridgeQuotes = new RelayBridgeQuotes();
  private readonly swaps: RelayBscSwap;
  private readonly ponsV4: PonsV4Swap | undefined;
  private readonly chainId: 56 | 4663;

  constructor(private readonly store: Store, private readonly sol: SolanaExecutionAdapter,
    private readonly connection: Connection, private readonly solSigner: BackendSolanaSigner,
    bscRpcUrl: string, private readonly signer: BackendEvmSigner,
    private readonly reward: BackendEvmSigner,
    private readonly gasReserve = reserveDefault,
    private readonly chain: "bsc" | "robinhood" = "bsc") {
    this.chainId = chain === "bsc" ? 56 : 4663;
    if (signer.account.address === reward.account.address) throw new Error("EVM treasury and reward wallets must differ");
    if (gasReserve <= 0n) throw new Error("EVM gas reserve must be positive");
    this.evm = new EvmOperationSender(store, bscRpcUrl, signer, chain);
    this.swaps = new RelayBscSwap(fetch, chain);
    this.ponsV4 = chain === "robinhood" ? new PonsV4Swap(bscRpcUrl) : undefined;
    this.solSender = new SolanaOperationSender(store, connection, solSigner);
    store.db.exec(`CREATE TABLE IF NOT EXISTS relay_bridge_operations (
      operation_id TEXT PRIMARY KEY, request_id TEXT NOT NULL,
      initial_balance TEXT NOT NULL, minimum TEXT NOT NULL, signature TEXT);
      CREATE TABLE IF NOT EXISTS bsc_buy_operations (
      operation_id TEXT PRIMARY KEY, initial_balance TEXT NOT NULL, spend TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bsc_fund_operations (
      operation_id TEXT PRIMARY KEY, initial_balance TEXT NOT NULL)`);
  }

  async assertReady(): Promise<void> {
    if (await this.evm.client.getChainId() !== this.chainId) throw new Error(`${this.chain} RPC chain mismatch`);
    if (this.gasReserve > 100_000_000_000_000_000n) throw new Error("EVM gas reserve is unreasonable");
  }

  collectCreatorFees(operationId: string): Promise<{ tx: string }> {
    return this.sol.collectCreatorFees(operationId);
  }
  convertPumpToSol(operationId: string): Promise<{ tx: string }> {
    return this.sol.convertPumpToSol(operationId);
  }
  availableSolLamports(): Promise<bigint> { return this.sol.availableSolLamports(); }
  snapshot(_operationId: string): Promise<SnapshotReceipt> { return this.sol.snapshot(); }

  private async quoteBuy(candidate: Candidate, amount: bigint): Promise<BscSwapQuote> {
    if (this.ponsV4 && candidate.launchpad === "pons_v2") {
      try { return await this.ponsV4.quote(candidate, amount, this.signer.account.address); }
      catch (error) {
        // Only a genuine absence of an on-chain path may fall back to Relay.
        // Factory or pool identity mismatches must stop execution.
        if (!(error instanceof PonsV4RouteUnavailableError)) throw error;
      }
    }
    return this.swaps.quote(candidate, amount, this.signer.account.address);
  }

  async bridge(operationId: string, candidate: Candidate, amountLamports: bigint): Promise<{
    tx: string; receivedAtoms: bigint }> {
    if (candidate.chain !== this.chain || amountLamports <= 0n) throw new Error("EVM bridge candidate or amount invalid");
    const destination = this.signer.account.address;
    let row = this.store.db.prepare(`SELECT request_id AS requestId, initial_balance AS initialBalance,
      minimum, signature FROM relay_bridge_operations WHERE operation_id = ?`).get(operationId) as BridgeRow | undefined;
    let prepared: Awaited<ReturnType<RelayBridgeQuotes["transaction"]>> | undefined;
    if (!row) {
      const initialBalance = await this.evm.client.getBalance({ address: destination });
      prepared = await this.bridgeQuotes.transaction(candidate, amountLamports,
        this.solSigner.publicKey.toBase58(), destination);
      if (prepared.summary.minimumNativeAtoms <= this.gasReserve ||
          prepared.summary.expectedNativeAtoms <= this.gasReserve)
        throw new Error("Relay bridge would not cover the destination gas reserve");
      // Confirm that the destination chain currently has a route before sending SOL away.
      // The final quote is refreshed after bridging for the actual received amount.
      await this.quoteBuy(candidate, prepared.summary.expectedNativeAtoms - this.gasReserve);
      this.store.db.prepare(`INSERT INTO relay_bridge_operations
        (operation_id, request_id, initial_balance, minimum) VALUES (?, ?, ?, ?)`)
        .run(operationId, prepared.summary.requestId, initialBalance.toString(),
          prepared.summary.minimumNativeAtoms.toString());
      row = { requestId: prepared.summary.requestId, initialBalance: initialBalance.toString(),
        minimum: prepared.summary.minimumNativeAtoms.toString(), signature: null };
    }
    if (!row.signature) {
      // A quote can expire before its first signature; the sender will reuse persisted signed
      // bytes after that point. If no signed bytes exist, refresh the quote and request ID.
      if (!prepared && !this.store.db.prepare(`SELECT 1 FROM solana_signed_operations WHERE operation_id = ?`)
        .get(operationId)) {
        prepared = await this.bridgeQuotes.transaction(candidate, amountLamports,
          this.solSigner.publicKey.toBase58(), destination);
        if (prepared.summary.minimumNativeAtoms <= this.gasReserve ||
            prepared.summary.expectedNativeAtoms <= this.gasReserve)
          throw new Error("Relay bridge would not cover the destination gas reserve");
        await this.quoteBuy(candidate, prepared.summary.expectedNativeAtoms - this.gasReserve);
        this.store.db.prepare(`UPDATE relay_bridge_operations SET request_id = ?, minimum = ?
          WHERE operation_id = ?`).run(prepared.summary.requestId,
          prepared.summary.minimumNativeAtoms.toString(), operationId);
        row.requestId = prepared.summary.requestId;
        row.minimum = prepared.summary.minimumNativeAtoms.toString();
      }
      const signed = await this.solSender.execute(operationId, async () => {
        if (!prepared) throw new Error("Signed Relay bridge operation missing after restart");
        const lookupTables = await Promise.all(prepared.lookupTables.map(async (address) => {
          const result = await this.connection.getAddressLookupTable(new PublicKey(address));
          if (!result.value) throw new Error("Relay lookup table is unavailable");
          return result.value;
        }));
        const instructions = prepared.instructions.map((instruction) => {
          if (!/^(?:[\da-fA-F]{2})+$/.test(instruction.data))
            throw new Error("Relay bridge instruction encoding is invalid");
          if (instruction.keys.some((key) => key.isSigner && key.pubkey !== this.solSigner.publicKey.toBase58()))
            throw new Error("Relay bridge requires an unexpected signer");
          return new TransactionInstruction({ programId: new PublicKey(instruction.programId),
            keys: instruction.keys.map((key) => ({ pubkey: new PublicKey(key.pubkey),
              isSigner: key.isSigner, isWritable: key.isWritable })),
            data: Buffer.from(instruction.data, "hex") });
        });
        const blockhash = await this.connection.getLatestBlockhash("confirmed");
        const message = new TransactionMessage({ payerKey: this.solSigner.publicKey,
          recentBlockhash: blockhash.blockhash, instructions }).compileToV0Message(lookupTables);
        return new VersionedTransaction(message);
      });
      this.store.db.prepare(`UPDATE relay_bridge_operations SET signature = ? WHERE operation_id = ?`)
        .run(signed, operationId);
      row.signature = signed;
    }
    const statusResponse = await fetch(`https://api.relay.link/intents/status/v3?requestId=${encodeURIComponent(row.requestId)}`,
      { signal: AbortSignal.timeout(12_000) });
    if (!statusResponse.ok) throw new Error(`Relay bridge status HTTP ${statusResponse.status}`);
    const status = await statusResponse.json() as { status?: string };
    if (status.status === "failure" || status.status === "refund")
      throw new Error(`Relay bridge ${status.status}: ${row.requestId}`);
    if (status.status !== "success") throw new Error(`Relay bridge pending: ${status.status ?? "unknown"}`);
    const balance = await this.evm.client.getBalance({ address: destination });
    const received = balance - BigInt(row.initialBalance);
    if (received < BigInt(row.minimum)) throw new Error("Relay settled below quoted minimum");
    const spendable = balance > this.gasReserve ? balance - this.gasReserve : 0n;
    const spend = received < spendable ? received : spendable;
    if (spend <= 0n) throw new Error("Bridged EVM native currency is below the gas reserve");
    return { tx: row.signature, receivedAtoms: spend };
  }

  async buy(operationId: string, candidate: Candidate, spendAtoms: bigint): Promise<BuyReceipt> {
    if (candidate.chain !== this.chain || spendAtoms <= 0n) throw new Error("Invalid EVM buy");
    const token = getAddress(candidate.token);
    let row = this.store.db.prepare(`SELECT initial_balance AS initialBalance, spend FROM bsc_buy_operations
      WHERE operation_id = ?`).get(operationId) as BuyRow | undefined;
    let quote;
    if (!row) {
      const [balance, nativeBalance] = await Promise.all([
        this.evm.client.readContract({ address: token, abi: erc20, functionName: "balanceOf",
          args: [this.signer.account.address] }),
        this.evm.client.getBalance({ address: this.signer.account.address }),
      ]);
      if (nativeBalance - spendAtoms < this.gasReserve)
        throw new Error("EVM buy would consume the gas reserve");
      quote = await this.quoteBuy(candidate, spendAtoms);
      this.store.db.prepare(`INSERT INTO bsc_buy_operations (operation_id, initial_balance, spend)
        VALUES (?, ?, ?)`).run(operationId, balance.toString(), spendAtoms.toString());
      row = { initialBalance: balance.toString(), spend: spendAtoms.toString() };
    }
    if (BigInt(row.spend) !== spendAtoms) throw new Error("EVM buy budget changed during retry");
    if (!this.evm.has(operationId)) {
      quote ??= await this.quoteBuy(candidate, spendAtoms);
    }
    const tx = await this.evm.execute(operationId,
      quote ? { to: quote.to, data: quote.data, value: quote.value } : undefined);
    const balance = await this.evm.client.readContract({ address: token, abi: erc20,
      functionName: "balanceOf", args: [this.signer.account.address] });
    const receivedAtoms = balance - BigInt(row.initialBalance);
    if (receivedAtoms <= 0n) throw new Error("EVM swap confirmed without receiving target tokens");
    const rewardDecimals = await this.evm.client.readContract({ address: token, abi: erc20,
      functionName: "decimals" });
    return { tx, receivedAtoms, rewardDecimals };
  }

  async fund(operationId: string, candidate: Candidate, purchase: BuyReceipt,
    holderAtoms: bigint, ownerAtoms: bigint): Promise<FundingReceipt> {
    if (candidate.chain !== this.chain || holderAtoms <= 0n ||
        holderAtoms + ownerAtoms !== purchase.receivedAtoms) throw new Error("Invalid EVM reward split");
    const token = getAddress(candidate.token);
    const rewardAddress = this.reward.account.address;
    let row = this.store.db.prepare(`SELECT initial_balance AS initialBalance FROM bsc_fund_operations
      WHERE operation_id = ?`).get(operationId) as { initialBalance: string } | undefined;
    if (!row) {
      const before = await this.evm.client.readContract({ address: token, abi: erc20,
        functionName: "balanceOf", args: [rewardAddress] });
      this.store.db.prepare(`INSERT INTO bsc_fund_operations (operation_id, initial_balance)
        VALUES (?, ?)`).run(operationId, before.toString());
      row = { initialBalance: before.toString() };
    }
    const data = encodeFunctionData({ abi: erc20, functionName: "transfer",
      args: [rewardAddress, holderAtoms] });
    const tx = await this.evm.execute(operationId, { to: token, data, value: 0n });
    const after = await this.evm.client.readContract({ address: token, abi: erc20,
      functionName: "balanceOf", args: [rewardAddress] });
    const creditedAtoms = after - BigInt(row.initialBalance);
    if (creditedAtoms <= 0n || creditedAtoms > holderAtoms)
      throw new Error("EVM reward wallet did not receive the holder allocation");
    return { tx, creditedAtoms, ownerRetainedAtoms: ownerAtoms };
  }

  async publish(operationId: string, candidate: Candidate, roundId: bigint,
    allocations: Allocation[], fundedAtoms: bigint): Promise<PublicationReceipt> {
    if (candidate.chain !== this.chain) throw new Error("Invalid EVM reward round");
    const digest = createHash("sha256").update(JSON.stringify({ roundId: roundId.toString(),
      allocations: allocations.map((item) => ({ solWallet: item.solWallet,
        rewardAtoms: item.rewardAtoms.toString() })), fundedAtoms: fundedAtoms.toString() })).digest("hex");
    return { tx: `backend:${operationId}`, root: `0x${digest}`,
      claimTarget: this.reward.account.address, chainId: this.chainId };
  }
}
