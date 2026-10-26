import { describe, expect, it } from "vitest";
import { RelayBscSwap } from "../src/execution/relay-bsc-swap.js";
import type { Candidate } from "../src/domain.js";

const user = "0x03508bb71268bba25ecacc8f620e01866650532c";
const token = "0xe78083B53F1d17B6D782106CE865c187fBB57777";
const native = "0x0000000000000000000000000000000000000000";
const candidate: Candidate = { chain: "bsc", launchpad: "flap_tax", token,
  pool: user, quoteToken: user, graduationTx: "0xabc", graduatedAt: 1 };

function response(output = token, chainId = 56) {
  return { requestId: "quote-id", details: { currencyIn: { currency: { chainId, address: native },
    amount: "10000000000000000" }, currencyOut: { currency: { chainId, address: output },
      amount: "1000000000000000000000", minimumAmount: "10000000000000000000" } },
    steps: [{ kind: "transaction", items: [{ data: { chainId, from: user,
      to: user, data: "0x1234", value: "10000000000000000" } }] }] };
}

describe("public Relay BNB purchase route", () => {
  it("quotes BNB to the graduated token with 99% slippage and no API key", async () => {
    let headers: Headers | undefined;
    let body: Record<string, unknown> = {};
    const request = (async (_url: string | URL | Request, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json(response());
    }) as typeof fetch;
    const quote = await new RelayBscSwap(request).quote(candidate, 10_000_000_000_000_000n, user);
    expect(headers?.has("x-api-key")).toBe(false);
    expect(body).toMatchObject({ originChainId: 56, destinationChainId: 56,
      originCurrency: native, destinationCurrency: token, slippageTolerance: "9900" });
    expect(quote).toMatchObject({ token, amountIn: 10_000_000_000_000_000n,
      minimumOut: 10_000_000_000_000_000_000n });
  });

  it("rejects a route to another token", async () => {
    const request = (async () => Response.json(response(user))) as typeof fetch;
    await expect(new RelayBscSwap(request).quote(candidate, 10_000_000_000_000_000n, user))
      .rejects.toThrow("differs");
  });
});

describe("public Relay Robinhood purchase route", () => {
  const rhCandidate: Candidate = { chain: "robinhood", launchpad: "pons_v2", token,
    pool: `0x${"12".repeat(32)}`, quoteToken: "0x3333333333333333333333333333333333333333",
    graduationTx: `0x${"ab".repeat(32)}`, graduatedAt: Date.now() };
  it("requests ETH to a custom-pair Pons token on chain 4663", async () => {
    let body: Record<string, unknown> = {};
    const request = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json(response(token, 4663));
    }) as typeof fetch;
    const quote = await new RelayBscSwap(request, "robinhood")
      .quote(rhCandidate, 10_000_000_000_000_000n, user);
    expect(body).toMatchObject({ originChainId: 4663, destinationChainId: 4663,
      destinationCurrency: token, slippageTolerance: "9900" });
    expect(quote.token).toBe(token);
  });
  it("rejects a quote on BNB for a Robinhood purchase", async () => {
    const request = (async () => Response.json(response(token, 56))) as typeof fetch;
    await expect(new RelayBscSwap(request, "robinhood")
      .quote(rhCandidate, 10_000_000_000_000_000n, user)).rejects.toThrow("differs");
  });
});
