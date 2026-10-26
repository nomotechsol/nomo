import { getAddress, type Address } from "viem";
import { type Candidate } from "../domain.js";
import { PURCHASE_SLIPPAGE_BPS, validPurchaseSlippage } from "./slippage.js";

const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

type ZeroExPrice = {
  liquidityAvailable?: boolean;
  sellToken?: string;
  buyToken?: string;
  sellAmount?: string;
  buyAmount?: string;
  minBuyAmount?: string;
  route?: { fills?: Array<{ from?: string; to?: string; source?: string }> };
};

export type EvmPurchaseRoute = {
  chainId: 56 | 4663;
  target: Address;
  poolQuoteToken: Address;
  inputNativeAtoms: bigint;
  expectedTargetAtoms: bigint;
  minimumTargetAtoms: bigint;
  sources: string[];
};

/** Read-only route discovery. 0x chooses any liquid path to the graduated target. */
export class ZeroExEvmPurchaseRoutes {
  constructor(private readonly apiKey: string, private readonly request: typeof fetch = fetch) {
    if (!apiKey) throw new Error("0x API key is required for EVM purchase routes");
  }

  async price(candidate: Candidate, inputNativeAtoms: bigint, taker: Address,
    slippageBps = PURCHASE_SLIPPAGE_BPS): Promise<EvmPurchaseRoute> {
    if (candidate.chain === "sol" || !candidate.pool || !candidate.quoteToken ||
        !candidate.graduationTx || inputNativeAtoms <= 0n || !validPurchaseSlippage(slippageBps))
      throw new Error("EVM purchase requires a verified pool, quote token and budget");
    const chainId = candidate.chain === "bsc" ? 56 : 4663;
    const target = getAddress(candidate.token);
    const poolQuoteToken = getAddress(candidate.quoteToken);
    const params = new URLSearchParams({ chainId: String(chainId), sellToken: NATIVE,
      buyToken: target, sellAmount: inputNativeAtoms.toString(), taker: getAddress(taker),
      slippageBps: String(slippageBps) });
    const response = await this.request(`https://api.0x.org/swap/allowance-holder/price?${params}`, {
      headers: { "0x-api-key": this.apiKey, "0x-version": "v2" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`0x EVM price HTTP ${response.status}`);
    const data = await response.json() as ZeroExPrice;
    if (!data.liquidityAvailable) throw new Error("No liquid route to the graduated EVM token");
    if (data.sellToken?.toLowerCase() !== NATIVE || data.buyToken?.toLowerCase() !== target.toLowerCase() ||
        data.sellAmount !== inputNativeAtoms.toString() ||
        !data.buyAmount || !data.minBuyAmount || !/^[1-9][0-9]*$/.test(data.buyAmount) ||
        !/^[1-9][0-9]*$/.test(data.minBuyAmount) ||
        BigInt(data.minBuyAmount) > BigInt(data.buyAmount))
      throw new Error("0x EVM route differs from the requested target or budget");
    const fills = data.route?.fills;
    if (!Array.isArray(fills) || fills.length === 0 ||
        !fills.some((fill) => fill.to?.toLowerCase() === target.toLowerCase()) ||
        fills.some((fill) => !fill.source || !fill.from || !fill.to))
      throw new Error("0x EVM route has no verified target leg");
    return { chainId, target, poolQuoteToken, inputNativeAtoms,
      expectedTargetAtoms: BigInt(data.buyAmount), minimumTargetAtoms: BigInt(data.minBuyAmount),
      sources: [...new Set(fills.map((fill) => fill.source!))] };
  }
}
