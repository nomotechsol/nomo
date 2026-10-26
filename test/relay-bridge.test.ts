import { describe, expect, it } from "vitest";
import { RelayBridgeQuotes } from "../src/execution/relay-bridge.js";
import type { Candidate } from "../src/domain.js";

const sol = "11111111111111111111111111111111";
const native = "0x0000000000000000000000000000000000000000";
const recipient = "0x03508bb71268bba25ecacc8f620e01866650532c";
const candidate: Candidate = { chain: "bsc", launchpad: "fourmeme", token: recipient,
  pool: recipient, quoteToken: native, graduationTx: "0xabc", graduatedAt: 1 };

function quoteResponse(chainId: number, output = native) {
  const amount = { currency: { chainId: 792703809, address: sol }, amount: "50000000" };
  const evm = { currency: { chainId, address: output }, amount: "6770000000000000",
    minimumAmount: "6600000000000000" };
  return { requestId: "request-id", details: { currencyIn: amount, currencyOut: evm,
    route: { origin: { router: "relay", inputCurrency: amount, outputCurrency: amount },
      destination: { router: "relay", inputCurrency: evm, outputCurrency: evm } } },
    steps: [{ kind: "transaction", items: [{ data: { instructions: [{ programId: "relay-program" }] } }] }] };
}

describe("Relay bridge quotes", () => {
  it("requests a direct native bridge without a 0x key", async () => {
    let headers: Headers;
    let body: Record<string, unknown> = {};
    const request = (async (_url: string | URL | Request, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json(quoteResponse(56));
    }) as typeof fetch;
    const quote = await new RelayBridgeQuotes(undefined, request).quote(candidate, 50_000_000n, sol, recipient);
    expect(quote).toMatchObject({ destinationChainId: 56, inputLamports: 50_000_000n,
      minimumNativeAtoms: 6_600_000_000_000_000n });
    expect(headers!.has("x-api-key")).toBe(false);
    expect(body).toMatchObject({ originChainId: 792703809, destinationChainId: 56,
      originCurrency: sol, destinationCurrency: native, amount: "50000000" });
  });

  it("rejects a response with a different destination currency", async () => {
    const request = (async () => Response.json(quoteResponse(56, recipient))) as typeof fetch;
    await expect(new RelayBridgeQuotes(undefined, request).quote(candidate, 50_000_000n, sol, recipient))
      .rejects.toThrow("differs");
  });
});
