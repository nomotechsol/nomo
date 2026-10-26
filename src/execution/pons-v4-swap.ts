import { createPublicClient, encodeAbiParameters, encodeFunctionData, getAddress, http,
  keccak256, parseAbi, parseAbiItem, type Address, type PublicClient } from "viem";
import type { Candidate } from "../domain.js";
import { robinhood } from "../evm/scanner.js";
import type { BscSwapQuote } from "./relay-bsc-swap.js";

const native = "0x0000000000000000000000000000000000000000" as const;
const usdg = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
const factory = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as const;
const hook = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044" as const;
const quoter = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94" as const;
const router = "0x204FAca1764B154221e35c0d20aBb3c525710498" as const;
const poolManager = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as const;
const initialized = parseAbiItem("event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)");
const factoryAbi = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
]);
const quoteAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
  "function quoteExactInput((address exactCurrency,(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path,uint128 exactAmount) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);
const routerAbi = parseAbi(["function execute(bytes commands,bytes[] inputs,uint256 deadline) payable"]);
const poolKeyTypes = [
  { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;
const pathKeyTypes = [
  { name: "intermediateCurrency", type: "address" }, { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
  { name: "hookData", type: "bytes" },
] as const;
type Hop = { intermediateCurrency: Address; fee: number; tickSpacing: number;
  hooks: Address; hookData: "0x" };

export class PonsV4RouteUnavailableError extends Error {}

/** On-chain v4 routes: ETH directly or through liquid USDG/quote pools into the Pons pool. */
export class PonsV4Swap {
  private readonly client: PublicClient;
  private readonly poolCache = new Map<string, { paths: Hop[][]; expiresAt: number }>();
  constructor(rpcUrl: string, client?: PublicClient) {
    this.client = client ?? createPublicClient({ chain: robinhood, transport: http(rpcUrl) });
  }

  async quote(candidate: Candidate, amountIn: bigint, taker: Address): Promise<BscSwapQuote> {
    if (candidate.chain !== "robinhood" || candidate.launchpad !== "pons_v2" ||
        !candidate.quoteToken || amountIn <= 0n || amountIn >= (1n << 128n))
      throw new Error("Pons V2 candidate or amount invalid");
    const token = getAddress(candidate.token);
    const launch = await this.client.readContract({ address: factory, abi: factoryAbi,
      functionName: "getLaunchedToken", args: [token] });
    const quoteToken = getAddress(candidate.quoteToken);
    if (!launch.exists || launch.phase !== 2 || launch.token.toLowerCase() !== token.toLowerCase() ||
        launch.pairToken.toLowerCase() !== quoteToken.toLowerCase())
      throw new Error("Pons factory launch state or pair differs from candidate");
    const [currency0, currency1] = quoteToken.toLowerCase() < token.toLowerCase()
      ? [quoteToken, token] : [token, quoteToken];
    const poolKey = { currency0, currency1, fee: launch.poolFee,
      tickSpacing: launch.tickSpacing, hooks: hook };
    const poolId = keccak256(encodeAbiParameters(poolKeyTypes, [currency0, currency1,
      launch.poolFee, launch.tickSpacing, hook]));
    if (candidate.pool.toLowerCase() !== poolId.toLowerCase())
      throw new Error("Pons factory pool differs from candidate");
    let expectedOut = 0n;
    let path: Hop[] = [];
    if (quoteToken.toLowerCase() === native) {
      try {
        const quoted = await this.client.simulateContract({ address: quoter, abi: quoteAbi,
          functionName: "quoteExactInputSingle", account: getAddress(taker), args: [{ poolKey,
            zeroForOne: true, exactAmount: amountIn, hookData: "0x" }] });
        expectedOut = quoted.result[0];
      } catch {
        throw new PonsV4RouteUnavailableError("Pons native pool quote is unavailable");
      }
    } else {
      const lastHop: Hop = { intermediateCurrency: token, fee: launch.poolFee,
        tickSpacing: launch.tickSpacing, hooks: hook, hookData: "0x" };
      for (const prefix of await this.prefixes(quoteToken)) {
        const route = [...prefix, lastHop];
        try {
          const quoted = await this.client.simulateContract({ address: quoter, abi: quoteAbi,
            functionName: "quoteExactInput", account: getAddress(taker),
            args: [{ exactCurrency: native, path: route, exactAmount: amountIn }] });
          if (quoted.result[0] > expectedOut) { expectedOut = quoted.result[0]; path = route; }
        } catch { /* pool may be empty or a hook may reject this route */ }
      }
    }
    if (expectedOut <= 0n) throw new PonsV4RouteUnavailableError("No liquid on-chain Pons V4 route");
    const minimumOut = expectedOut / 100n > 0n ? expectedOut / 100n : 1n; // 99% slippage
    const swap = quoteToken.toLowerCase() === native
      ? encodeAbiParameters([{ type: "tuple", components: [
        { name: "poolKey", type: "tuple", components: poolKeyTypes },
        { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" },
        { name: "amountOutMinimum", type: "uint128" },
        { name: "minHopPriceX36", type: "uint256" }, { name: "hookData", type: "bytes" },
      ] }], [{ poolKey, zeroForOne: true, amountIn, amountOutMinimum: minimumOut,
        minHopPriceX36: 0n, hookData: "0x" }])
      : encodeAbiParameters([{ type: "tuple", components: [
        { name: "currencyIn", type: "address" },
        { name: "path", type: "tuple[]", components: pathKeyTypes },
        { name: "minHopPriceX36", type: "uint256[]" },
        { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" },
      ] }], [{ currencyIn: native, path, minHopPriceX36: [], amountIn,
        amountOutMinimum: minimumOut }]);
    const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [native, amountIn]);
    const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [token, minimumOut]);
    const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }],
      [quoteToken.toLowerCase() === native ? "0x060c0f" : "0x070c0f", [swap, settle, take]]);
    const data = encodeFunctionData({ abi: routerAbi, functionName: "execute",
      args: ["0x10", [input], BigInt(Math.floor(Date.now() / 1000) + 120)] });
    return { requestId: `v4:${poolId}`, token, amountIn, expectedOut,
      minimumOut, to: router, data, value: amountIn };
  }

  private async prefixes(quoteToken: Address): Promise<Hop[][]> {
    const key = quoteToken.toLowerCase();
    const cached = this.poolCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.paths;
    const bridge: Hop = { intermediateCurrency: usdg, fee: 100, tickSpacing: 1,
      hooks: native, hookData: "0x" };
    const pairs: Array<[Address, Hop[]]> = [[native, []], [usdg, [bridge]]];
    const directPaths: Hop[][] = [];
    const viaUsdgPaths: Hop[][] = [];
    if (quoteToken.toLowerCase() === usdg.toLowerCase()) viaUsdgPaths.push([bridge]);
    for (const [base, prefix] of pairs) {
      if (base.toLowerCase() === quoteToken.toLowerCase()) continue;
      const [a, b] = base.toLowerCase() < quoteToken.toLowerCase()
        ? [base, quoteToken] : [quoteToken, base];
      let pools;
      try {
        pools = await this.client.getLogs({ address: poolManager, event: initialized,
          args: { currency0: a, currency1: b }, fromBlock: 1n, toBlock: "latest" });
      } catch {
        throw new PonsV4RouteUnavailableError("Pons V4 route discovery is unavailable");
      }
      for (const pool of pools) {
        const { fee, tickSpacing, hooks } = pool.args;
        if (fee === undefined || tickSpacing === undefined || !hooks ||
            fee > 30_000 || hooks.toLowerCase() !== native) continue;
        (base.toLowerCase() === native ? directPaths : viaUsdgPaths)
          .push([...prefix, { intermediateCurrency: quoteToken, fee, tickSpacing,
            hooks, hookData: "0x" }]);
      }
    }
    const limited = [...directPaths.slice(0, 12), ...viaUsdgPaths.slice(0, 12)];
    this.poolCache.set(key, { paths: limited, expiresAt: Date.now() + 5 * 60_000 });
    return limited;
  }
}
