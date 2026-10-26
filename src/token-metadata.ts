import { Connection, PublicKey } from "@solana/web3.js";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { bsc } from "viem/chains";
import type { Chain } from "./domain.js";
import { Store, type TokenMetadata } from "./store.js";

type MetadataFields = Pick<TokenMetadata, "name" | "symbol" | "imageUrl">;
const pending = new Map<string, Promise<TokenMetadata>>();
const metaplexProgram = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const flapTokenAbi = parseAbi(["function metaURI() view returns (string)"]);
const erc20Abi = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)"]);
const ponsTokenAbi = parseAbi([
  "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }",
  "function getTokenInfo() view returns (address tokenDeployer, string tokenLogo, string tokenDescription, Socials tokenSocials)",
]);
const robinhood = { id: 4663, name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } } as const;

function cleanText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" ? value.trim().replace(/[\x00-\x1f\x7f]/g, " ").slice(0, maxLength) || null : null;
}

function mediaUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const trimmed = value.trim();
    const raw = trimmed.startsWith("ipfs://") ? `https://gateway.pinata.cloud/ipfs/${trimmed.slice(7).replace(/^ipfs\//, "")}` :
      /^(?:bafy|bafk|Qm)[a-zA-Z0-9]+$/.test(trimmed) ? `https://gateway.pinata.cloud/ipfs/${trimmed}` : trimmed;
    const url = new URL(raw);
    if (["ipfs.io", "dweb.link"].includes(url.hostname) && url.pathname.startsWith("/ipfs/"))
      url.hostname = "gateway.pinata.cloud";
    return url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

/** Helius DAS indexes the token's on-chain URI and exposes its resolved image. */
export async function fromHeliusAsset(rpcUrl: string, token: string,
  request: typeof fetch = fetch): Promise<MetadataFields> {
  const response = await request(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: token, method: "getAsset",
      params: { id: token, displayOptions: { showFungible: true } } }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Helius getAsset returned ${response.status}`);
  const payload = await response.json() as { error?: unknown; result?: {
    id?: unknown; content?: { metadata?: { name?: unknown; symbol?: unknown };
      links?: { image?: unknown }; files?: Array<{ uri?: unknown; cdn_uri?: unknown; mime?: unknown }> } } };
  if (payload.error || payload.result?.id !== token) throw new Error("Helius asset unavailable or token mismatch");
  const content = payload.result.content;
  const file = content?.files?.find((entry) => typeof entry.mime !== "string" || entry.mime.startsWith("image/"));
  return { name: cleanText(content?.metadata?.name, 100), symbol: cleanText(content?.metadata?.symbol, 30),
    imageUrl: mediaUrl(content?.links?.image) ?? mediaUrl(file?.cdn_uri) ?? mediaUrl(file?.uri) };
}

const metadataHosts = new Set(["gateway.pinata.cloud", "flap.mypinata.cloud", "gg.sc", "arweave.net",
  "gateway.irys.xyz", "nftstorage.link", "pump.fun", "ipfs.filebase.io"]);
async function metadataJson(uri: string, request: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const url = mediaUrl(uri);
  if (!url || !metadataHosts.has(new URL(url).hostname)) throw new Error("Unsupported token metadata URI");
  const primary = new URL(url);
  const urls = [url];
  if (primary.hostname === "gateway.pinata.cloud" && primary.pathname.startsWith("/ipfs/")) {
    primary.hostname = "ipfs.filebase.io";
    urls.push(primary.href);
  }
  let response: Response | undefined;
  for (const target of urls) {
    try {
      const attempt = await request(target, { signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } });
      if (attempt.ok) { response = attempt; break; }
    } catch { /* retry through the second IPFS gateway */ }
  }
  if (!response) throw new Error("Token metadata unavailable");
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > 256_000) throw new Error("Token metadata too large");
  const raw: unknown = await response.json();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid token metadata JSON");
  return raw as Record<string, unknown>;
}

/** Token-2022 metadata is in the mint extension; legacy mints use a Metaplex PDA. */
export async function fromSolanaOnChain(rpcUrl: string, token: string,
  request: typeof fetch = fetch): Promise<MetadataFields> {
  const connection = new Connection(rpcUrl, "confirmed");
  const mint = new PublicKey(token);
  const parsed = await connection.getParsedAccountInfo(mint);
  const info = parsed.value?.data && !Buffer.isBuffer(parsed.value.data) && "parsed" in parsed.value.data
    ? parsed.value.data.parsed.info as { extensions?: Array<{ extension?: string; state?: Record<string, unknown> }> }
    : undefined;
  const extension = info?.extensions?.find((entry) => entry.extension === "tokenMetadata")?.state;
  let name = cleanText(extension?.name, 100);
  let symbol = cleanText(extension?.symbol, 30);
  let uri = cleanText(extension?.uri, 1000);
  if (!uri) {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("metadata"),
      metaplexProgram.toBuffer(), mint.toBuffer()], metaplexProgram);
    const account = await connection.getAccountInfo(pda);
    if (!account || !account.owner.equals(metaplexProgram)) throw new Error("Solana token metadata account unavailable");
    const data = account.data;
    let offset = 65;
    const field = (): string => {
      if (offset + 4 > data.length) throw new Error("Invalid Metaplex metadata field");
      const length = data.readUInt32LE(offset); offset += 4;
      if (length > 2048 || offset + length > data.length) throw new Error("Invalid Metaplex metadata length");
      const value = data.subarray(offset, offset + length).toString("utf8").replace(/\0+$/g, "");
      offset += length;
      return value;
    };
    name = cleanText(field(), 100);
    symbol = cleanText(field(), 30);
    uri = cleanText(field(), 1000);
  }
  let json: Record<string, unknown> = {};
  if (uri) {
    try { json = await metadataJson(uri, request); }
    catch { /* on-chain name and symbol remain usable while image hosting recovers */ }
  }
  return { name, symbol, imageUrl: mediaUrl(json.image) };
}

/** Flap stores the metadata URI on its token contract. */
export async function fromFlapMetadataUri(uri: string, request: typeof fetch = fetch): Promise<MetadataFields> {
  const json = await metadataJson(uri, request);
  return { name: cleanText(json.name, 100), symbol: cleanText(json.symbol, 30), imageUrl: mediaUrl(json.image) };
}

async function fromFlap(rpcUrl: string, token: string): Promise<MetadataFields> {
  const client = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
  const uri = await client.readContract({ address: token as Address, abi: flapTokenAbi, functionName: "metaURI" });
  return fromFlapMetadataUri(uri);
}

/** Four.meme does not put its uploaded PFP in the ERC-20 contract. */
export async function fromFourMeme(token: string, request: typeof fetch = fetch): Promise<MetadataFields> {
  const response = await request(`https://four.meme/meme-api/v1/private/token/get/v2?address=${encodeURIComponent(token)}`,
    { signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Four.meme metadata returned ${response.status}`);
  const payload = await response.json() as { code?: unknown; data?: {
    address?: unknown; name?: unknown; shortName?: unknown; image?: unknown } };
  const data = payload.data;
  if (Number(payload.code) !== 0 || typeof data?.address !== "string" ||
      data.address.toLowerCase() !== token.toLowerCase()) throw new Error("Four.meme token address mismatch");
  return { name: cleanText(data.name, 100), symbol: cleanText(data.shortName, 30),
    imageUrl: mediaUrl(data.image) };
}

async function fromEvmContract(chain: "bsc" | "robinhood", rpcUrl: string, token: string): Promise<MetadataFields> {
  const client = createPublicClient({ chain: chain === "bsc" ? bsc : robinhood, transport: http(rpcUrl) });
  const address = token as Address;
  const [name, symbol] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: "name" }),
    client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
  ]);
  let imageUrl: string | null = null;
  if (chain === "robinhood") {
    try {
      const [, logo] = await client.readContract({ address, abi: ponsTokenAbi, functionName: "getTokenInfo" });
      imageUrl = mediaUrl(logo);
    } catch { /* an older token may not expose Pons V2 metadata */ }
  }
  return { name: cleanText(name, 100), symbol: cleanText(symbol, 30), imageUrl };
}

/** Only chain-owned metadata is used; images themselves are retrieved from their URI. */
export async function getOrFetchTokenMetadata(store: Store, chain: Chain, token: string): Promise<TokenMetadata> {
  const cached = store.getTokenMetadata(chain, token);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const key = `${chain}:${chain === "sol" ? token : token.toLowerCase()}`;
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const task = (async () => {
    let fields: MetadataFields = { name: null, symbol: null, imageUrl: null };
    try {
      if (chain === "sol" && process.env.HELIUS_RPC_URL) {
        try { fields = await fromHeliusAsset(process.env.HELIUS_RPC_URL, token); }
        catch { /* fall back to the on-chain metadata account if DAS is lagging */ }
        if (!fields.name || !fields.symbol || !fields.imageUrl) {
          try {
            const onChain = await fromSolanaOnChain(process.env.HELIUS_RPC_URL, token);
            fields = { name: fields.name ?? onChain.name, symbol: fields.symbol ?? onChain.symbol,
              imageUrl: fields.imageUrl ?? onChain.imageUrl };
          } catch { /* retain any Helius fields already resolved */ }
        }
      }
      else if (chain === "bsc" && process.env.BSC_RPC_URL) {
        fields = await fromEvmContract("bsc", process.env.BSC_RPC_URL, token);
        try {
          const flap = await fromFlap(process.env.BSC_RPC_URL, token);
          fields = { name: fields.name ?? flap.name, symbol: fields.symbol ?? flap.symbol,
            imageUrl: flap.imageUrl };
        } catch {
          try {
            const four = await fromFourMeme(token);
            fields = { name: fields.name ?? four.name, symbol: fields.symbol ?? four.symbol,
              imageUrl: four.imageUrl };
          } catch { /* launchpad metadata is not available yet */ }
        }
      } else if (chain === "robinhood" && process.env.RH_RPC_URL)
        fields = await fromEvmContract("robinhood", process.env.RH_RPC_URL, token);
    } catch { /* keep any prior metadata when the chain or URI provider is unavailable */ }
    fields = { name: fields.name ?? cached?.name ?? null, symbol: fields.symbol ?? cached?.symbol ?? null,
      imageUrl: fields.imageUrl ?? cached?.imageUrl ?? null };
    const now = Date.now();
    const ttl = fields.name && fields.symbol && fields.imageUrl ? 24 * 60 * 60_000 :
      fields.name || fields.symbol || fields.imageUrl ? 60_000 : 15_000;
    const metadata = { ...fields, fetchedAt: now, expiresAt: now + ttl };
    store.putTokenMetadata(chain, token, metadata);
    return metadata;
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}
