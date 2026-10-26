import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { type Candidate } from "../domain.js";

const SOL_NATIVE = "So11111111111111111111111111111111111111111";
const EVM_NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const SOL_CHAIN_ID = 999_999_999_991;
const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

type BridgeRoute = {
  quoteId?: string;
  sellAmount: string;
  buyAmount: string;
  minBuyAmount: string;
  steps: Array<{ type: string; provider?: string }>;
  transaction: { chainType: string; details: { serializedTransaction: string } };
};
type BridgeResponse = { liquidityAvailable: boolean; originChainId: number; destinationChainId: number;
  sellToken: string; buyToken: string; quotes?: BridgeRoute[]; routes?: BridgeRoute[] };

export type ValidatedBridgeQuote = { quoteId?: string; destinationChainId: 56 | 4663;
  expectedMinAtoms: bigint; transaction: VersionedTransaction };

/** Quotes only. Signing and chain submission are isolated behind an operator signer. */
export class ZeroExBridgeQuotes {
  constructor(private readonly apiKey: string, private readonly solanaRpc: string,
    private readonly request: typeof fetch = fetch) {}

  async quote(candidate: Candidate, amountLamports: bigint, origin: string, destination: string): Promise<ValidatedBridgeQuote> {
    if (candidate.chain === "sol" || amountLamports <= 0n) throw new Error("Bridge requires an EVM destination and positive SOL amount");
    const destinationChainId = candidate.chain === "bsc" ? 56 : 4663;
    const payer = new PublicKey(origin);
    if (!/^0x[0-9a-fA-F]{40}$/.test(destination)) throw new Error("Invalid EVM destination wallet");
    const params = new URLSearchParams({ originChain: "solana", destinationChain: String(destinationChainId),
      sellToken: SOL_NATIVE, buyToken: EVM_NATIVE, sellAmount: amountLamports.toString(),
      originAddress: payer.toBase58(), destinationAddress: destination, includedBridges: "relay",
      sortQuotesBy: "price", maxNumQuotes: "1" });
    const response = await this.request(`https://api.0x.org/cross-chain/quotes?${params}`, {
      headers: { "0x-api-key": this.apiKey }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`0x bridge quote HTTP ${response.status}`);
    const data = await response.json() as BridgeResponse;
    if (!data.liquidityAvailable || data.originChainId !== SOL_CHAIN_ID ||
        data.destinationChainId !== destinationChainId || data.sellToken !== SOL_NATIVE ||
        data.buyToken.toLowerCase() !== EVM_NATIVE) throw new Error("0x bridge quote does not match requested route");
    // Current 0x examples use both `routes` and `quotes`; accept either documented envelope.
    const route = (data.quotes ?? data.routes)?.[0];
    if (!route || BigInt(route.sellAmount) !== amountLamports || BigInt(route.minBuyAmount) <= 0n ||
        BigInt(route.buyAmount) < BigInt(route.minBuyAmount))
      throw new Error("Invalid 0x bridge quote amounts");
    if (!route.steps.some((step) => step.type === "bridge" && step.provider === "relay") ||
        route.steps.some((step) => !["bridge", "wrap"].includes(step.type) ||
          (step.type === "bridge" && step.provider !== "relay")))
      throw new Error("Bridge route includes an unapproved swap or provider");
    if (route.transaction.chainType !== "svm") throw new Error("Bridge origin transaction is not Solana");
    const transaction = VersionedTransaction.deserialize(Buffer.from(route.transaction.details.serializedTransaction, "base64"));
    if (transaction.message.version !== 0 || !transaction.message.staticAccountKeys[0]?.equals(payer))
      throw new Error("Bridge transaction version or fee payer mismatch");
    const connection = new Connection(this.solanaRpc, "confirmed");
    const lookupAccounts = await Promise.all(transaction.message.addressTableLookups.map(async (lookup) => {
      const result = await connection.getAddressLookupTable(lookup.accountKey);
      if (!result.value) throw new Error("Bridge transaction lookup table missing");
      return result.value;
    }));
    const decoded = TransactionMessage.decompile(transaction.message, { addressLookupTableAccounts: lookupAccounts });
    if (decoded.instructions.some((instruction) => instruction.programId.toBase58() === JUPITER_V6))
      throw new Error("Jupiter route is prohibited");
    return { quoteId: route.quoteId, destinationChainId, expectedMinAtoms: BigInt(route.minBuyAmount), transaction };
  }
}
