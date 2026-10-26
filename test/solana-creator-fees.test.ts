import { createRequire } from "node:module";
import BN from "bn.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { SolanaExecutionAdapter } from "../src/execution/solana-adapter.js";
import { Store } from "../src/store.js";

const PUMP = new PublicKey("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");
const require = createRequire(import.meta.url);
const { PUMP_AMM_PROGRAM_ID, PUMP_AMM_SDK } = require("@pump-fun/pump-swap-sdk") as
  typeof import("@pump-fun/pump-swap-sdk");
const { PUMP_SDK } = require("@pump-fun/pump-sdk") as typeof import("@pump-fun/pump-sdk");

describe("NOMO creator fees before migration", () => {
  it("accepts a live PUMP-quoted curve without a PumpSwap pool and performs no empty sweep", async () => {
    const store = new Store(":memory:");
    const mint = Keypair.generate().publicKey;
    const treasury = Keypair.generate();
    const reward = Keypair.generate();
    const connection = {
      getAccountInfo: vi.fn(async (address: PublicKey) =>
        address.equals(mint) ? { owner: TOKEN_PROGRAM_ID } : null),
      getBalance: vi.fn(async () => 20_000_000),
    } as unknown as Connection;
    const signer = { publicKey: treasury.publicKey, sign: vi.fn() };
    const rewardSigner = { publicKey: reward.publicKey, sign: vi.fn() };
    const adapter = new SolanaExecutionAdapter(store, "http://127.0.0.1:8899", connection,
      signer, rewardSigner, mint.toBase58());
    const sdk = {
      fetchBondingCurve: vi.fn(async () => ({ creator: treasury.publicKey, quoteMint: PUMP,
        isHolderReward: false, creatorFee: new BN(0), complete: false })),
      getCreatorVaultQuoteBalances: vi.fn(async () => []),
    };
    Object.assign(adapter, { sdk });
    try {
      await expect(adapter.assertReady()).resolves.toBeUndefined();
      await expect(adapter.collectCreatorFees("prebond")).resolves.toEqual({ tx: "no-pump-fees" });
      expect(connection.getAccountInfo).toHaveBeenCalledTimes(3);
      expect(sdk.getCreatorVaultQuoteBalances).toHaveBeenCalledOnce();
    } finally { store.close(); }
  });

  it("sweeps pending curve fees before migration without touching PumpSwap", async () => {
    const store = new Store(":memory:");
    const mint = Keypair.generate().publicKey;
    const treasury = Keypair.generate();
    const connection = {
      getAccountInfo: vi.fn(async () => null),
    } as unknown as Connection;
    const adapter = new SolanaExecutionAdapter(store, "http://127.0.0.1:8899", connection,
      { publicKey: treasury.publicKey, sign: vi.fn() },
      { publicKey: Keypair.generate().publicKey, sign: vi.fn() }, mint.toBase58());
    const sender = { execute: vi.fn(async () => "swept") };
    Object.assign(adapter, { sender, sdk: {
      fetchBondingCurve: vi.fn(async () => ({ creator: treasury.publicKey, quoteMint: PUMP,
        isHolderReward: false, creatorFee: new BN(3), complete: false })),
      getCreatorVaultQuoteBalances: vi.fn(async () => []),
    } });
    const sweepCurve = vi.spyOn(PUMP_SDK, "sweepCreatorFeeInstruction");
    const sweepPool = vi.spyOn(PUMP_SDK, "sweepPoolCreatorFeeInstruction");
    try {
      await adapter.collectCreatorFees("prebond-fees");
      expect(sender.execute).toHaveBeenCalledWith("prebond-fees:sweep", expect.any(Function));
      expect(sweepCurve).toHaveBeenCalledOnce();
      expect(sweepPool).not.toHaveBeenCalled();
    } finally { sweepCurve.mockRestore(); sweepPool.mockRestore(); store.close(); }
  });

  it("rejects a different creator even before the pool exists", async () => {
    const store = new Store(":memory:");
    const mint = Keypair.generate().publicKey;
    const treasury = Keypair.generate();
    const connection = {
      getAccountInfo: vi.fn(async (address: PublicKey) =>
        address.equals(mint) ? { owner: TOKEN_PROGRAM_ID } : null),
      getBalance: vi.fn(async () => 20_000_000),
    } as unknown as Connection;
    const adapter = new SolanaExecutionAdapter(store, "http://127.0.0.1:8899", connection,
      { publicKey: treasury.publicKey, sign: vi.fn() },
      { publicKey: Keypair.generate().publicKey, sign: vi.fn() }, mint.toBase58());
    Object.assign(adapter, { sdk: { fetchBondingCurve: vi.fn(async () => ({
      creator: Keypair.generate().publicKey, quoteMint: PUMP, isHolderReward: false,
    })) } });
    try { await expect(adapter.assertReady()).rejects.toThrow(/curve creator/); }
    finally { store.close(); }
  });

  it("accepts the canonical pool after migration and sweeps both fee buckets", async () => {
    const store = new Store(":memory:");
    const mint = Keypair.generate().publicKey;
    const treasury = Keypair.generate();
    const poolInfo = { owner: PUMP_AMM_PROGRAM_ID };
    const connection = {
      getAccountInfo: vi.fn(async (address: PublicKey) =>
        address.equals(mint) ? { owner: TOKEN_PROGRAM_ID } : poolInfo),
      getBalance: vi.fn(async () => 20_000_000),
    } as unknown as Connection;
    const adapter = new SolanaExecutionAdapter(store, "http://127.0.0.1:8899", connection,
      { publicKey: treasury.publicKey, sign: vi.fn() },
      { publicKey: Keypair.generate().publicKey, sign: vi.fn() }, mint.toBase58());
    const sender = { execute: vi.fn(async () => "swept") };
    Object.assign(adapter, { sender, sdk: {
      fetchBondingCurve: vi.fn(async () => ({ creator: treasury.publicKey, quoteMint: PUMP,
        isHolderReward: false, creatorFee: new BN(3), complete: true })),
      getCreatorVaultQuoteBalances: vi.fn(async () => []),
    } });
    const decode = vi.spyOn(PUMP_AMM_SDK, "decodePool").mockReturnValue({
      baseMint: mint, quoteMint: PUMP, coinCreator: treasury.publicKey,
      isHolderReward: false, creatorFees: new BN(2),
    } as ReturnType<typeof PUMP_AMM_SDK.decodePool>);
    const sweepCurve = vi.spyOn(PUMP_SDK, "sweepCreatorFeeInstruction");
    const sweepPool = vi.spyOn(PUMP_SDK, "sweepPoolCreatorFeeInstruction");
    try {
      await expect(adapter.assertReady()).resolves.toBeUndefined();
      await adapter.collectCreatorFees("postbond");
      expect(sender.execute).toHaveBeenCalledWith("postbond:sweep", expect.any(Function));
      expect(sweepCurve).toHaveBeenCalledOnce();
      expect(sweepPool).toHaveBeenCalledOnce();
    } finally { decode.mockRestore(); sweepCurve.mockRestore(); sweepPool.mockRestore(); store.close(); }
  });
});
