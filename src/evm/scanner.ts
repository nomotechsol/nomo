import { createPublicClient, encodeAbiParameters, http, keccak256, parseAbi, parseAbiItem,
  type Address, type PublicClient } from "viem";
import { bsc } from "viem/chains";
import { type Candidate } from "../domain.js";
import { Store } from "../store.js";

const flapPortal = "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0" as const;
const fourManagerV1 = "0xEC4549caDcE5DA21Df6E6422d448034B5233bFbC" as const;
const fourManagerV2 = "0x5c952063c7fc8610FFDB798152D69F0B9550762b" as const;
const fourHelper = "0xF251F83e40a78868FcfA3FA4599Dad6494E46034" as const;
const wbnb = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" as const;
const zeroAddress = "0x0000000000000000000000000000000000000000";
const ponsFactory = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as const;
const ponsHook = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044" as const;

const flapGraduated = parseAbiItem("event LaunchedToDEX(address token,address pool,uint256 amount,uint256 eth)");
const fourGraduated = parseAbiItem("event LiquidityAdded(address base,uint256 offers,address quote,uint256 funds)");
const ponsGraduated = parseAbiItem("event PoolGraduated(address indexed token,uint256 positionId,uint256 tokenAmount,uint256 pairTokenAmount)");
const ponsRegistered = parseAbiItem("event PoolRegistered(bytes32 indexed poolId,address memecoin,address quoteToken,address creator)");
const ponsFactoryAbi = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
]);
const flapAbi = parseAbi(["function getTokenV8Safe(address token) view returns ((uint8 status,uint256 reserve,uint256 circulatingSupply,uint256 price,uint8 tokenVersion,uint256 r,uint256 h,uint256 k,uint256 dexSupplyThresh,address quoteTokenAddress,bool nativeToQuoteSwapEnabled,bytes32 extensionID,uint256 buyTaxRate,uint256 sellTaxRate,address pool,uint256 progress,uint8 lpFeeProfile,uint8 dexId))"]);
const fourAbi = parseAbi(["function getTokenInfo(address token) view returns (uint256 version,address tokenManager,address quote,uint256 lastPrice,uint256 tradingFeeRate,uint256 minTradingFee,uint256 launchTime,uint256 offers,uint256 maxOffers,uint256 funds,uint256 maxFunds,bool liquidityAdded)"]);
const dexPairAbi = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)"]);

export const robinhood = {
  id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
} as const;

type Source = "flap" | "fourmeme" | "pons_v2";
type Config = { source: Source; rpcUrl: string; startBlock?: bigint; confirmations?: bigint; chunkSize?: bigint };

export class EvmGraduationScanner {
  private readonly client: PublicClient;
  private readonly confirmations: bigint;
  private readonly chunkSize: bigint;

  constructor(private readonly store: Store, private readonly config: Config, client?: PublicClient) {
    this.client = client ?? createPublicClient({ chain: config.source === "pons_v2" ? robinhood : bsc, transport: http(config.rpcUrl) });
    this.confirmations = config.confirmations ?? 3n;
    this.chunkSize = config.chunkSize ?? 250n;
    if (this.confirmations < 1n || this.chunkSize < 1n || this.chunkSize > 2000n) throw new Error("Invalid scanner confirmation/chunk setting");
  }

  async poll(): Promise<number> {
    const source = this.config.source;
    if (source === "flap") await this.refreshFlapQuotes();
    const tip = await this.client.getBlockNumber();
    if (tip < this.confirmations) return 0;
    const safeTip = tip - this.confirmations;
    const cursor = this.store.getCursor(source);
    // On first boot, start at the safe tip. A caller can explicitly set startBlock to backfill.
    const from = cursor === undefined ? (this.config.startBlock ?? safeTip) : cursor + 1n;
    if (from > safeTip) return 0;
    const to = from + this.chunkSize - 1n < safeTip ? from + this.chunkSize - 1n : safeTip;
    const candidates = source === "flap" ? await this.flap(from, to) :
      source === "fourmeme" ? await this.four(from, to) : await this.pons(from, to);
    for (const candidate of candidates) this.store.addCandidate(candidate);
    this.store.setCursor(source, to);
    return candidates.length;
  }

  private async refreshFlapQuotes(): Promise<void> {
    const pending = this.store.listCandidates(10_000).filter((row) => row.candidate.chain === "bsc" &&
      row.candidate.launchpad.startsWith("flap_") && !row.candidate.quoteToken && row.candidate.pool &&
      row.state !== "reserved" && row.state !== "settled").slice(0, 20);
    for (const row of pending) {
      const info = await this.client.readContract({ address: flapPortal, abi: flapAbi,
        functionName: "getTokenV8Safe", args: [row.candidate.token as Address] });
      if (info.pool.toLowerCase() !== row.candidate.pool.toLowerCase()) continue;
      const quoteToken = info.quoteTokenAddress.toLowerCase() === zeroAddress ? wbnb : info.quoteTokenAddress;
      if (quoteToken.toLowerCase() !== row.candidate.token.toLowerCase())
        this.store.enrichCandidate("bsc", row.candidate.token, { quoteToken });
    }
  }

  private async stamp(blockNumber: bigint): Promise<number> {
    const block = await this.client.getBlock({ blockNumber });
    return Number(block.timestamp) * 1000;
  }

  /** GMGN hints can jump to the recent on-chain window without moving the durable cursor. */
  async scanHinted(fromBlock: bigint, toBlock: bigint, tokens: ReadonlySet<string>): Promise<number> {
    const candidates = this.config.source === "flap" ? await this.flap(fromBlock, toBlock, tokens) :
      this.config.source === "fourmeme" ? await this.four(fromBlock, toBlock, tokens) :
        await this.pons(fromBlock, toBlock, tokens);
    for (const candidate of candidates) this.store.addCandidate(candidate);
    return candidates.length;
  }

  private async flap(fromBlock: bigint, toBlock: bigint, tokens?: ReadonlySet<string>): Promise<Candidate[]> {
    const logs = await this.client.getLogs({ address: flapPortal, event: flapGraduated, fromBlock, toBlock });
    const candidates: Candidate[] = [];
    for (const log of logs) {
      if (!log.args.token || !log.args.pool || !log.transactionHash) throw new Error("Malformed Flap graduation log");
      if (tokens && !tokens.has(log.args.token.toLowerCase())) continue;
      const info = await this.client.readContract({ address: flapPortal, abi: flapAbi, functionName: "getTokenV8Safe", args: [log.args.token] });
      const taxBps = Number(info.buyTaxRate);
      if (!Number.isSafeInteger(taxBps)) throw new Error("Flap tax rate overflow");
      if (info.pool.toLowerCase() !== log.args.pool.toLowerCase()) throw new Error("Flap pool mismatch");
      const quoteToken = info.quoteTokenAddress.toLowerCase() === zeroAddress ? wbnb : info.quoteTokenAddress;
      if (quoteToken.toLowerCase() === log.args.token.toLowerCase()) throw new Error("Flap base and quote are identical");
      candidates.push({ chain: "bsc", launchpad: taxBps > 0 ? "flap_tax" : "flap_nontax", token: log.args.token,
        pool: log.args.pool, quoteToken, graduationTx: log.transactionHash,
        graduatedAt: await this.stamp(log.blockNumber), taxBps });
    }
    return candidates;
  }

  private async four(fromBlock: bigint, toBlock: bigint, tokens?: ReadonlySet<string>): Promise<Candidate[]> {
    const logs = await this.client.getLogs({ address: [fourManagerV1, fourManagerV2], event: fourGraduated, fromBlock, toBlock });
    const candidates: Candidate[] = [];
    for (const log of logs) {
      if (!log.args.base || !log.transactionHash) throw new Error("Malformed Four.meme graduation log");
      if (tokens && !tokens.has(log.args.base.toLowerCase())) continue;
      const info = await this.client.readContract({ address: fourHelper, abi: fourAbi, functionName: "getTokenInfo", args: [log.args.base] });
      if (!info[11] || info[1].toLowerCase() !== log.address.toLowerCase()) throw new Error("Four.meme status/manager mismatch");
      const eventQuote = log.args.quote?.toLowerCase() === zeroAddress ? wbnb : log.args.quote;
      const infoQuote = info[2].toLowerCase() === zeroAddress ? wbnb : info[2];
      if (!eventQuote || eventQuote.toLowerCase() !== infoQuote.toLowerCase() ||
          eventQuote.toLowerCase() === log.args.base.toLowerCase())
        throw new Error("Four.meme quote token mismatch");
      const pool = await this.dexPoolInReceipt(log.transactionHash, log.args.base, eventQuote);
      candidates.push({ chain: "bsc", launchpad: "fourmeme", token: log.args.base,
        pool, quoteToken: eventQuote, graduationTx: log.transactionHash,
        graduatedAt: await this.stamp(log.blockNumber) });
    }
    return candidates;
  }

  private async dexPoolInReceipt(tx: `0x${string}`, base: Address, quote: Address): Promise<string> {
    const receipt = await this.client.getTransactionReceipt({ hash: tx });
    const excluded = new Set([base.toLowerCase(), quote.toLowerCase(), fourManagerV1.toLowerCase(),
      fourManagerV2.toLowerCase(), fourHelper.toLowerCase()]);
    const addresses = [...new Set(receipt.logs.map((log) => log.address))]
      .filter((address) => !excluded.has(address.toLowerCase())).slice(0, 30);
    const matches: Address[] = [];
    for (const address of addresses) {
      try {
        const [token0, token1] = await Promise.all([
          this.client.readContract({ address, abi: dexPairAbi, functionName: "token0" }),
          this.client.readContract({ address, abi: dexPairAbi, functionName: "token1" }),
        ]);
        if ([token0.toLowerCase(), token1.toLowerCase()].sort().join(":") ===
            [base.toLowerCase(), quote.toLowerCase()].sort().join(":")) matches.push(address);
      } catch { /* unrelated log emitter */ }
    }
    return matches.length === 1 ? matches[0]! : "";
  }

  private async pons(fromBlock: bigint, toBlock: bigint, tokens?: ReadonlySet<string>): Promise<Candidate[]> {
    const graduations = await this.client.getLogs({ address: ponsFactory, event: ponsGraduated,
      ...(tokens ? { args: { token: [...tokens] as Address[] } } : {}), fromBlock, toBlock });
    const registrations = tokens ? [] : await this.client.getLogs({
      address: ponsHook, event: ponsRegistered, fromBlock, toBlock });
    const registrationsByToken = new Map<string, Array<{ tx: string; block: bigint; poolId: string; quoteToken: Address }>>();
    for (const log of registrations) {
      if (log.args.memecoin && log.args.poolId && log.args.quoteToken && log.transactionHash) {
        const token = log.args.memecoin.toLowerCase();
        if (tokens && !tokens.has(token)) continue;
        const entries = registrationsByToken.get(token) ?? [];
        entries.push({ tx: log.transactionHash, block: log.blockNumber, poolId: log.args.poolId,
          quoteToken: log.args.quoteToken });
        registrationsByToken.set(token, entries);
      }
    }
    for (const [token, entries] of registrationsByToken) {
      const verified = await this.ponsPool(token as Address);
      if (!verified || entries.some((entry) => entry.poolId !== verified.pool ||
          entry.quoteToken.toLowerCase() !== verified.quoteToken.toLowerCase())) continue;
      this.store.resolvePool("robinhood", token, verified.pool);
      this.store.enrichCandidate("robinhood", token, { quoteToken: verified.quoteToken });
    }
    const candidates: Candidate[] = [];
    for (const log of graduations) {
      if (!log.args.token || !log.transactionHash) throw new Error("Malformed Pons graduation log");
      if (tokens && !tokens.has(log.args.token.toLowerCase())) continue;
      const verified = await this.ponsPool(log.args.token);
      if (!verified) continue;
      const registrations = (registrationsByToken.get(log.args.token.toLowerCase()) ?? [])
        .filter((entry) => entry.block >= log.blockNumber);
      if (registrations.some((entry) => entry.poolId !== verified.pool ||
          entry.quoteToken.toLowerCase() !== verified.quoteToken.toLowerCase()))
        throw new Error("Pons registration differs from factory pool key");
      candidates.push({ chain: "robinhood", launchpad: "pons_v2", token: log.args.token,
        pool: verified.pool, quoteToken: verified.quoteToken, graduationTx: log.transactionHash,
        graduatedAt: await this.stamp(log.blockNumber) });
    }
    return candidates;
  }

  private async ponsPool(token: Address): Promise<{ pool: string; quoteToken: Address } | undefined> {
    const launch = await this.client.readContract({ address: ponsFactory, abi: ponsFactoryAbi,
      functionName: "getLaunchedToken", args: [token] });
    if (!launch.exists || launch.phase !== 2 || launch.token.toLowerCase() !== token.toLowerCase() ||
        launch.pairToken.toLowerCase() === token.toLowerCase()) return undefined;
    const quoteToken = launch.pairToken;
    const [currency0, currency1] = quoteToken.toLowerCase() < token.toLowerCase()
      ? [quoteToken, token] : [token, quoteToken];
    const pool = keccak256(encodeAbiParameters([
      { type: "address" }, { type: "address" }, { type: "uint24" },
      { type: "int24" }, { type: "address" },
    ], [currency0, currency1, launch.poolFee, launch.tickSpacing, ponsHook]));
    return { pool, quoteToken };
  }
}
