import { PublicKey } from "@solana/web3.js";
import { getAddress } from "viem";
import type { Candidate } from "../domain.js";

const SOL_CHAIN = 792703809;
const SOL_NATIVE = "11111111111111111111111111111111";
const EVM_NATIVE = "0x0000000000000000000000000000000000000000";

type CurrencyAmount = { currency?: { chainId?: number; address?: string }; amount?: string;
  minimumAmount?: string };
type RelayResponse = { requestId?: string; details?: { currencyIn?: CurrencyAmount;
  currencyOut?: CurrencyAmount; route?: { origin?: { router?: string; inputCurrency?: CurrencyAmount;
    outputCurrency?: CurrencyAmount }; destination?: { router?: string; inputCurrency?: CurrencyAmount;
    outputCurrency?: CurrencyAmount } } }; steps?: Array<{ kind?: string; items?: Array<{
    data?: { instructions?: Array<{ programId?: string; data?: string;
      keys?: Array<{ pubkey?: string; isSigner?: boolean; isWritable?: boolean }> }>;
      addressLookupTableAddresses?: string[] } }> }> };

export type RelaySolanaInstruction = { programId: string; data: string;
  keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }> };

export type RelayBridgeQuote = { requestId: string; destinationChainId: 56 | 4663;
  inputLamports: bigint; expectedNativeAtoms: bigint; minimumNativeAtoms: bigint };

/** Read-only SOL → native BNB/ETH quote. Does not sign or submit a transaction. */
export class RelayBridgeQuotes {
  constructor(private readonly apiKey?: string, private readonly request: typeof fetch = fetch) {}

  async quote(candidate: Candidate, amountLamports: bigint, origin: string, destination: string): Promise<RelayBridgeQuote> {
    return (await this.fetchQuote(candidate, amountLamports, origin, destination)).summary;
  }

  async transaction(candidate: Candidate, amountLamports: bigint, origin: string, destination: string): Promise<{
    summary: RelayBridgeQuote; instructions: RelaySolanaInstruction[]; lookupTables: string[] }> {
    const { summary, data } = await this.fetchQuote(candidate, amountLamports, origin, destination);
    const items = data.steps?.flatMap((step) => step.kind === "transaction" ? step.items ?? [] : []) ?? [];
    if (items.length !== 1) throw new Error("Relay bridge requires exactly one Solana transaction");
    const item = items[0];
    const instructions = item?.data?.instructions;
    if (!instructions?.length || !instructions.every((ix) => ix.programId && ix.data &&
        Array.isArray(ix.keys) && ix.keys.every((key) => key.pubkey &&
          typeof key.isSigner === "boolean" && typeof key.isWritable === "boolean")))
      throw new Error("Relay Solana bridge instructions are invalid");
    return { summary, instructions: instructions as RelaySolanaInstruction[],
      lookupTables: item?.data?.addressLookupTableAddresses ?? [] };
  }

  private async fetchQuote(candidate: Candidate, amountLamports: bigint, origin: string,
    destination: string): Promise<{ summary: RelayBridgeQuote; data: RelayResponse }> {
    if (candidate.chain === "sol" || amountLamports <= 0n) throw new Error("Relay bridge requires an EVM destination");
    const destinationChainId = candidate.chain === "bsc" ? 56 : 4663;
    const user = new PublicKey(origin).toBase58();
    const recipient = getAddress(destination);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    const response = await this.request("https://api.relay.link/quote/v2", {
      method: "POST", headers, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ user, recipient, originChainId: SOL_CHAIN, destinationChainId,
        originCurrency: SOL_NATIVE, destinationCurrency: EVM_NATIVE,
        amount: amountLamports.toString(), tradeType: "EXACT_INPUT" }),
    });
    if (!response.ok) throw new Error(`Relay bridge quote HTTP ${response.status}`);
    const data = await response.json() as RelayResponse;
    const details = data.details;
    const route = details?.route;
    const input = route?.origin?.inputCurrency;
    const originOutput = route?.origin?.outputCurrency;
    const destinationInput = route?.destination?.inputCurrency;
    const output = route?.destination?.outputCurrency;
    const expected = details?.currencyOut?.amount;
    const minimum = output?.minimumAmount;
    if (!data.requestId || !details || details.currencyIn?.currency?.chainId !== SOL_CHAIN ||
        details.currencyIn.currency.address !== SOL_NATIVE || details.currencyIn.amount !== amountLamports.toString() ||
        details.currencyOut?.currency?.chainId !== destinationChainId ||
        details.currencyOut.currency.address?.toLowerCase() !== EVM_NATIVE ||
        route?.origin?.router !== "relay" || route.destination?.router !== "relay" ||
        input?.currency?.address !== SOL_NATIVE || originOutput?.currency?.address !== SOL_NATIVE ||
        destinationInput?.currency?.address?.toLowerCase() !== EVM_NATIVE ||
        output?.currency?.address?.toLowerCase() !== EVM_NATIVE ||
        !expected || !minimum || !/^[1-9]\d*$/.test(expected) || !/^[1-9]\d*$/.test(minimum) ||
        BigInt(minimum) > BigInt(expected) ||
        !data.steps?.some((step) => step.kind === "transaction" && step.items?.some((item) =>
          item.data?.instructions?.length))) throw new Error("Relay quote differs from the requested native bridge route");
    if (data.steps.some((step) => step.items?.some((item) => item.data?.instructions?.some((instruction) =>
      instruction.programId?.startsWith("JUP"))))) throw new Error("Jupiter route is prohibited");
    return { summary: { requestId: data.requestId, destinationChainId, inputLamports: amountLamports,
      expectedNativeAtoms: BigInt(expected), minimumNativeAtoms: BigInt(minimum) }, data };
  }
}
