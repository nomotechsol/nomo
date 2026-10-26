import { getAddress, isAddress, type Address, type Hex } from "viem";
import type { Candidate } from "../domain.js";
import { PURCHASE_SLIPPAGE_BPS } from "./slippage.js";

const NATIVE = "0x0000000000000000000000000000000000000000";
type Amount = { currency?: { chainId?: number; address?: string }; amount?: string; minimumAmount?: string };
type SwapResponse = { requestId?: string; details?: { currencyIn?: Amount; currencyOut?: Amount;
  route?: { origin?: { router?: string }; destination?: { router?: string } } };
  steps?: Array<{ kind?: string; items?: Array<{ data?: { from?: string; to?: string; data?: string;
    value?: string; chainId?: number } }> }> };

export type BscSwapQuote = { requestId: string; token: Address; amountIn: bigint;
  expectedOut: bigint; minimumOut: bigint; to: Address; data: Hex; value: bigint };

/** Relay exposes same-chain aggregation publicly; it may route through any liquid quote asset. */
export class RelayBscSwap {
  constructor(private readonly request: typeof fetch = fetch,
    private readonly chain: "bsc" | "robinhood" = "bsc") {}

  async quote(candidate: Candidate, amountIn: bigint, taker: Address): Promise<BscSwapQuote> {
    if (candidate.chain !== this.chain || !candidate.pool || !candidate.quoteToken || !candidate.graduationTx ||
        !isAddress(candidate.token) || amountIn <= 0n) throw new Error("Unverified EVM candidate or amount");
    const chainId = this.chain === "bsc" ? 56 : 4663;
    const token = getAddress(candidate.token);
    const account = getAddress(taker);
    const response = await this.request("https://api.relay.link/quote/v2", {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ user: account, recipient: account, originChainId: chainId, destinationChainId: chainId,
        originCurrency: NATIVE, destinationCurrency: token, amount: amountIn.toString(),
        tradeType: "EXACT_INPUT", slippageTolerance: String(PURCHASE_SLIPPAGE_BPS) }),
    });
    if (!response.ok) throw new Error(`Relay ${this.chain} swap quote HTTP ${response.status}`);
    const quote = await response.json() as SwapResponse;
    const input = quote.details?.currencyIn;
    const output = quote.details?.currencyOut;
    const items = quote.steps?.flatMap((step) => step.kind === "transaction" ? step.items ?? [] : []) ?? [];
    const tx = items.length === 1 ? items[0]?.data : undefined;
    const expectedOut = output?.amount;
    const minimumOut = output?.minimumAmount;
    if (!quote.requestId || input?.currency?.chainId !== chainId ||
        input.currency.address?.toLowerCase() !== NATIVE || input.amount !== amountIn.toString() ||
        output?.currency?.chainId !== chainId || output.currency.address?.toLowerCase() !== token.toLowerCase() ||
        !expectedOut || !minimumOut || !/^[1-9]\d*$/.test(expectedOut) ||
        !/^[1-9]\d*$/.test(minimumOut) || BigInt(minimumOut) > BigInt(expectedOut) ||
        BigInt(minimumOut) < BigInt(expectedOut) / 100n ||
        tx?.chainId !== chainId || tx.from?.toLowerCase() !== account.toLowerCase() ||
        !tx.to || !isAddress(tx.to) || !tx.data || !/^0x[\da-fA-F]+$/.test(tx.data) ||
        tx.value !== amountIn.toString()) throw new Error("Relay EVM swap differs from requested token or amount");
    return { requestId: quote.requestId, token, amountIn, expectedOut: BigInt(expectedOut),
      minimumOut: BigInt(minimumOut), to: getAddress(tx.to), data: tx.data as Hex, value: amountIn };
  }
}
