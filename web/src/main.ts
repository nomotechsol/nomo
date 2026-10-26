import "@fontsource/sofia-sans/latin-400.css";
import "@fontsource/sofia-sans/latin-500.css";
import "./styles.css";
import { getWallets } from "@wallet-standard/app";
import { StandardConnect, type StandardConnectFeature } from "@wallet-standard/features";
import { SolanaSignMessage, type SolanaSignMessageFeature } from "@solana/wallet-standard-features";
import { SolanaSignAndSendTransaction, type SolanaSignAndSendTransactionFeature } from "@solana/wallet-standard-features";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import bs58 from "bs58";

type EthereumProvider = { request(input: { method: string; params?: unknown[] }): Promise<unknown> };
declare global { interface Window { ethereum?: EthereumProvider } }

type Reward = { candidateId: string; chain: "sol" | "bsc" | "robinhood"; launchpad: string;
  token: string; rewardAtoms: string; rewardDecimals: number; purchaseTx: string; snapshotSlot: number;
  claimReady: boolean; claimed?: boolean; submitted?: boolean; deliveryMode?: "claim" | "push";
  payoutState?: "pending" | "batched" | "sent" | null; payoutTx?: string | null };
type Activity = { id: string; chain: "sol" | "bsc" | "robinhood"; launchpad: string;
  token: string; state: string; reasons?: string[]; observedAt: number; graduatedAt: number;
  name?: string | null; symbol?: string | null; imageUrl?: string | null; metadataExpiresAt?: number | null;
  totalFeesNative?: number; totalFeesUsd?: number; feeMetricsAt?: number;
  budgetLamports: string | null; spendAtoms: string | null;
  purchasedAtoms: string | null; rewardDecimals: number | null; purchaseTx: string | null };
type Chain = Activity["chain"];
type SpotQuote = { usd: number; source: "binance" | "coingecko"; fetchedAt: number };
type StatsSummary = { count: number; solBudgetLamports: string | null; totalUsd: number | null;
  chains: Record<Chain, { count: number; nativeUnit: "SOL" | "BNB" | "ETH"; spendAtoms: string | null;
    usd: number | null; price: SpotQuote | null }>;
  rewardWallets?: Record<Chain, string | null> };
type Purchase = { candidateId: string; chain: Chain; launchpad: string; token: string;
  name: string | null; symbol: string | null; imageUrl: string | null; purchaseTx: string;
  spendAtoms: string | null; budgetLamports: string | null; createdAt: number };
type PayoutBatch = { id: number; token: string; signature: string; sentAt: number;
  recipientCount: number; rewardDecimals: number;
  recipients: Array<{ wallet: string; rewardAtoms: string }> };

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element: ${id}`);
  return element as T;
};

const walletNext = byId<HTMLButtonElement>("wallet-next");
const solWalletPicker = byId<HTMLDivElement>("sol-wallet-picker");
let showSolWalletPicker = false;
let selectedSolWallet: Wallet | undefined;
let solAccount: WalletAccount | undefined;
let evmAddress: string | undefined;
let linkedAddress: string | undefined;
let busy = false;
let rewards: Reward[] = [];
let activity: Activity[] = [];
let activityChain = "all";
const activityPageSize = 10;
let activityVisibleCount = activityPageSize;
let statsSummary: StatsSummary | null = null;
let purchases: Purchase[] = [];
let statsNextCursor: string | null = null;
let statsPageLoaded = false;
let statsBusy = false;
let statsGeneration = 0;
let statsView: "buys" | "payouts" = "buys";
let payoutBatches: PayoutBatch[] = [];
let payoutNextCursor: number | null = null;
let payoutPageLoaded = false;
let payoutBusy = false;
type TokenMetadata = { name: string | null; symbol: string | null; imageUrl: string | null; expiresAt: number };
const tokenMetadataCache = new Map<string, TokenMetadata>();
const tokenMetadataQueue: Activity[] = [];
const tokenMetadataQueued = new Set<string>();
let activeMetadataLookups = 0;

function tokenMetadataKey(item: Pick<Activity, "chain" | "token">): string { return `${item.chain}:${item.token.toLowerCase()}`; }
function safeImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^\/token-images\/[a-f0-9]{64}\.(?:png|jpg|webp|gif|avif)$/.test(value) ? value : null;
}
function attachTokenImage(avatar: HTMLElement, item: Pick<Activity, "token">, imageUrl: string | null, alt: string): void {
  if (!imageUrl) { avatar.append(fallbackAvatar(item)); return; }
  const image = document.createElement("img");
  image.src = imageUrl;
  image.alt = alt;
  image.loading = "lazy";
  image.decoding = "async";
  image.onerror = () => {
    image.remove();
    avatar.append(fallbackAvatar(item));
  };
  avatar.append(image);
}
async function lookupTokenMetadata(item: Pick<Activity, "chain" | "token">): Promise<TokenMetadata> {
  const response = await fetch(`/api/token-metadata/${item.chain}/${encodeURIComponent(item.token)}`);
  if (!response.ok) throw new Error("Metadata unavailable");
  return response.json() as Promise<TokenMetadata>;
}
function pumpMetadataQueue(): void {
  while (activeMetadataLookups < 3 && tokenMetadataQueue.length) {
    const item = tokenMetadataQueue.shift()!;
    activeMetadataLookups++;
    void lookupTokenMetadata(item).then((metadata) => {
      tokenMetadataCache.set(tokenMetadataKey(item), metadata);
      renderActivity();
    }).catch(() => {
      tokenMetadataCache.set(tokenMetadataKey(item), { name: null, symbol: null, imageUrl: null,
        expiresAt: Date.now() + 60_000 });
    }).finally(() => { tokenMetadataQueued.delete(tokenMetadataKey(item)); activeMetadataLookups--; pumpMetadataQueue(); });
  }
}
function queueTokenMetadata(rows: Activity[]): void {
  for (const item of rows) {
    const key = tokenMetadataKey(item);
    const cached = tokenMetadataCache.get(key);
    if (cached && cached.expiresAt > Date.now()) continue;
    if (tokenMetadataQueued.has(key)) continue;
    tokenMetadataQueued.add(key);
    tokenMetadataQueue.push(item);
  }
  pumpMetadataQueue();
}

class UiError extends Error {}

function userError(error: unknown, fallback: string): string {
  return error instanceof UiError ? error.message : fallback;
}

function short(value: string): string { return value.length > 18 ? `${value.slice(0, 7)}…${value.slice(-6)}` : value; }
function solscanTransaction(signature: string): string { return `https://solscan.io/tx/${encodeURIComponent(signature)}`; }
function purchaseExplorer(chain: Chain, signature: string): string | null {
  return chain === "sol" ? solscanTransaction(signature) :
    chain === "bsc" ? `https://bscscan.com/tx/${encodeURIComponent(signature)}` : null;
}
function amount(raw: string, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const atoms = BigInt(raw);
  const fraction = (atoms % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${(atoms / base).toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}
function nativeSpend(raw: string, decimals: number): string {
  const value = Number(raw) / 10 ** decimals;
  if (value > 0 && value < 0.000001) return "<0.000001";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(value);
}

const launchpadName: Record<string, string> = { pumpfun: "Pump.fun", stonkfun: "StonkFun",
  fourmeme: "Four.meme", flap_tax: "Flap · taxed", flap_nontax: "Flap · no tax", pons_v2: "Pons V2" };

function tokenCopyButton(token: string, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "token-copy";
  button.textContent = label;
  button.title = `Copy CA: ${token}`;
  button.setAttribute("aria-label", `Copy contract address for ${label}`);
  button.addEventListener("click", () => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(token);
        toast("CA copied to clipboard", false, 2600);
      } catch { toast("Could not copy CA", true); }
    })();
  });
  return button;
}

function renderActivity(): void {
  const filtered = activity.filter((item) => activityChain === "all" || item.chain === activityChain);
  const rows = filtered.slice(0, activityVisibleCount);
  byId("activity-count").textContent = `${filtered.length} ${filtered.length === 1 ? "event" : "events"}`;
  const body = byId<HTMLDivElement>("activity-body");
  const scrollTop = body.scrollTop;
  body.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement("div"); empty.className = "activity-empty";
    const icon = document.createElement("span"); icon.className = "empty-orbit"; icon.textContent = "✳";
    const title = document.createElement("strong"); title.textContent = "Waiting for the next graduation";
    const detail = document.createElement("p"); detail.textContent = "Confirmed tokens and NOMO purchases will show up here.";
    empty.append(icon, title, detail); body.append(empty);
    return;
  }
  for (const item of rows) {
    const row = document.createElement("div"); row.className = "activity-item";
    const avatar = document.createElement("span"); avatar.className = "activity-avatar";
    const metadata = tokenMetadataCache.get(tokenMetadataKey(item));
    const imageUrl = safeImageUrl(metadata?.imageUrl ?? item.imageUrl);
    attachTokenImage(avatar, item, imageUrl, `Token image for ${metadata?.name ?? item.name ?? short(item.token)}`);
    const middle = document.createElement("div"); middle.className = "activity-main";
    const name = metadata?.name ?? item.name;
    const symbol = metadata?.symbol ?? item.symbol;
    const token = tokenCopyButton(item.token, name ? `${name}${symbol ? ` ($${symbol})` : ""}` : short(item.token));
    const context = document.createElement("small");
    const networkLabel = item.chain === "sol" ? "SOL" : item.chain === "bsc" ? "BNB" : "RH";
    context.textContent = `${launchpadName[item.launchpad] ?? item.launchpad} · ${networkLabel}`;
    middle.append(token, context);
    const result = document.createElement("div"); result.className = "activity-result";
    const explorer = item.purchaseTx && item.state === "settled" ? purchaseExplorer(item.chain, item.purchaseTx) : null;
    const label = document.createElement(explorer ? "a" : "strong");
    if (explorer) {
      const link = label as HTMLAnchorElement;
      link.href = explorer; link.target = "_blank"; link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", `View ${item.chain === "sol" ? "Solscan" : "BscScan"} purchase transaction`);
    }
    const detail = document.createElement("small");
    const unit = item.chain === "sol" ? "SOL" : item.chain === "bsc" ? "BNB" : "ETH";
    label.textContent = `Buy ${item.spendAtoms && item.purchaseTx ? nativeSpend(item.spendAtoms, item.chain === "sol" ? 9 : 18) : "—"} ${unit}`;
    if (item.purchaseTx && item.state === "settled") {
      detail.textContent = "Confirmed buy";
      if (item.purchasedAtoms && item.rewardDecimals !== null)
        label.title = `${amount(item.purchasedAtoms, item.rewardDecimals)} tokens bought`;
    } else detail.textContent = item.state === "reserved" ? "Preparing buy" : "Qualified";
    result.append(label, detail); row.append(avatar, middle, result); body.append(row);
  }
  queueTokenMetadata(rows);
  body.scrollTop = scrollTop;
}

function fallbackAvatar(item: Pick<Activity, "token">): HTMLElement {
  const fallback = document.createElement("span");
  fallback.className = "activity-avatar-fallback";
  fallback.textContent = "✳";
  const hue = [...item.token].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 0);
  fallback.style.color = `hsl(${hue} 42% 42%)`;
  return fallback;
}

async function loadActivity(): Promise<void> {
  try {
    const response = await fetch("/api/activity", { cache: "no-store" });
    if (!response.ok) throw new Error("Activity request failed");
    const data = await response.json() as { mode: string; items: Activity[] };
    activity = data.items;
    for (const item of activity) {
      if (!item.name && !item.symbol && !item.imageUrl) continue;
      const key = tokenMetadataKey(item);
      tokenMetadataCache.set(key, { name: item.name ?? null,
        symbol: item.symbol ?? null, imageUrl: item.imageUrl ?? null, expiresAt: item.metadataExpiresAt ?? Date.now() });
    }
    byId("activity-updated").textContent = `Updated ${new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`;
    renderActivity();
  } catch { byId("activity-updated").textContent = "Activity feed unavailable"; }
}

function nativeUnit(chain: Chain): "SOL" | "BNB" | "ETH" {
  return chain === "sol" ? "SOL" : chain === "bsc" ? "BNB" : "ETH";
}

function nativeValue(raw: string | null, chain: Chain): number | null {
  if (raw === null) return null;
  const value = Number(BigInt(raw)) / 10 ** (chain === "sol" ? 9 : 18);
  return Number.isFinite(value) ? value : null;
}

function nativeLabel(raw: string | null, chain: Chain, compact = false): string {
  const value = nativeValue(raw, chain);
  if (value === null) return "—";
  if (value > 0 && value < 0.000001) return "<0.000001";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: compact ? 2 : 6,
    notation: compact && value >= 10_000 ? "compact" : "standard" }).format(value);
}

function usdLabel(value: number | null, compact = false): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD",
    maximumFractionDigits: value === 0 ? 0 : compact ? 1 : value < 10 ? 2 : 0,
    notation: compact && value >= 10_000 ? "compact" : "standard" }).format(value);
}

function renderStatsSummary(): void {
  if (!statsSummary) return;
  const summary = statsSummary;
  const solAllocated = `${nativeLabel(summary.solBudgetLamports, "sol", true)} SOL`;
  byId("hero-stats-count").textContent = String(summary.count);
  byId("hero-stats-sol").textContent = solAllocated;
  byId("hero-stats-usd").textContent = usdLabel(summary.totalUsd, true);
  byId("stats-total-count").textContent = summary.count.toLocaleString("en-US");
  byId("stats-total-sol").textContent = solAllocated;
  byId("stats-total-usd").textContent = usdLabel(summary.totalUsd);
  if (statsView === "buys")
    byId("stats-list-count").textContent = `${summary.count.toLocaleString("en-US")} ${summary.count === 1 ? "buy" : "buys"}`;
  for (const [chain, prefix] of [["sol", "sol"], ["bsc", "bsc"], ["robinhood", "rh"]] as const) {
    const row = summary.chains[chain];
    byId(`stats-${prefix}-native`).textContent = `${nativeLabel(row.spendAtoms, chain)} ${row.nativeUnit}`;
    byId(`stats-${prefix}-usd`).textContent = `${row.usd === null ? "USD unavailable" : `≈ ${usdLabel(row.usd)}`} · ${row.count} ${row.count === 1 ? "buy" : "buys"}`;
    const wallet = summary.rewardWallets?.[chain] ?? null;
    const button = byId<HTMLButtonElement>(`stats-${prefix}-wallet`);
    button.disabled = !wallet;
    button.textContent = wallet ? `${short(wallet)}  ⧉` : "—";
    button.title = wallet ? `Copy reward wallet: ${wallet}` : "Reward wallet unavailable";
    button.setAttribute("aria-label", wallet ? `Copy ${chain === "sol" ? "Solana" : chain === "bsc" ? "BNB Chain" : "Robinhood Chain"} reward wallet ${wallet}` : "Reward wallet unavailable");
  }
}

for (const [chain, prefix] of [["sol", "sol"], ["bsc", "bsc"], ["robinhood", "rh"]] as const) {
  byId<HTMLButtonElement>(`stats-${prefix}-wallet`).addEventListener("click", () => {
    const wallet = statsSummary?.rewardWallets?.[chain];
    if (!wallet) return;
    void navigator.clipboard.writeText(wallet).then(() => toast("Reward wallet copied", false, 2600))
      .catch(() => toast("Could not copy wallet", true));
  });
}

async function loadStatsSummary(): Promise<void> {
  try {
    const response = await fetch("/api/stats", { cache: "no-store" });
    if (!response.ok) throw new Error("Stats request failed");
    statsSummary = await response.json() as StatsSummary;
    renderStatsSummary();
    if (byId<HTMLDialogElement>("stats-modal").open) renderStatsList();
  } catch {
    if (!statsSummary) {
      byId("hero-stats-count").textContent = "—";
      byId("hero-stats-sol").textContent = "—";
      byId("hero-stats-usd").textContent = "—";
    }
  }
}

function renderStatsList(): void {
  const list = byId<HTMLDivElement>("stats-list");
  list.replaceChildren();
  if (statsView === "payouts") { renderPayoutList(list); return; }
  if (!purchases.length) {
    if (!statsBusy && statsPageLoaded) {
      const empty = document.createElement("div"); empty.className = "stats-empty";
      empty.textContent = "No confirmed buys yet."; list.append(empty);
    }
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const item of purchases) {
    const row = document.createElement("div"); row.className = "stats-row";
    const avatar = document.createElement("span"); avatar.className = "activity-avatar";
    const metadata = tokenMetadataCache.get(tokenMetadataKey(item));
    const imageUrl = safeImageUrl(metadata?.imageUrl ?? item.imageUrl);
    attachTokenImage(avatar, item, imageUrl, `Token image for ${metadata?.name ?? item.name ?? short(item.token)}`);
    const token = document.createElement("div"); token.className = "stats-token";
    const name = metadata?.name ?? item.name;
    const symbol = metadata?.symbol ?? item.symbol;
    const title = tokenCopyButton(item.token, name ? `${name}${symbol ? ` ($${symbol})` : ""}` : short(item.token));
    const context = document.createElement("small");
    context.textContent = `${launchpadName[item.launchpad] ?? item.launchpad} · ${nativeUnit(item.chain)} · ${new Date(item.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
    token.append(title, context);
    const spend = document.createElement("div"); spend.className = "stats-spend";
    const explorer = purchaseExplorer(item.chain, item.purchaseTx);
    const native = document.createElement(explorer ? "a" : "strong");
    if (explorer) {
      const link = native as HTMLAnchorElement;
      link.href = explorer; link.target = "_blank"; link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", `View ${item.chain === "sol" ? "Solscan" : "BscScan"} purchase transaction`);
    }
    native.textContent = `Buy ${nativeLabel(item.spendAtoms, item.chain)} ${nativeUnit(item.chain)}`;
    const usd = document.createElement("small");
    const price = statsSummary?.chains[item.chain].price;
    const value = nativeValue(item.spendAtoms, item.chain);
    usd.textContent = value !== null && price ? `≈ ${usdLabel(value * price.usd)}` : "USD unavailable";
    spend.append(native, usd);
    row.append(avatar, token, spend); fragment.append(row);
  }
  list.append(fragment);
}

function renderPayoutList(list: HTMLDivElement): void {
  if (!payoutBatches.length) {
    if (payoutPageLoaded && !payoutBusy) {
      const empty = document.createElement("div"); empty.className = "stats-empty";
      empty.textContent = "No holder transfers yet."; list.append(empty);
    }
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const batch of payoutBatches) {
    const row = document.createElement("div"); row.className = "payout-log";
    const summary = document.createElement("div"); summary.className = "payout-log-summary";
    const copy = document.createElement("div");
    const title = document.createElement("strong"); title.textContent = `${batch.recipientCount} ${batch.recipientCount === 1 ? "holder" : "holders"} paid`;
    const detail = document.createElement("small");
    detail.textContent = `${new Date(batch.sentAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${short(batch.token)}`;
    copy.append(title, detail);
    const link = document.createElement("a"); link.href = solscanTransaction(batch.signature);
    link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "Solscan ↗";
    link.setAttribute("aria-label", `View transfer transaction ${batch.signature} on Solscan`);
    summary.append(copy, link);
    const recipients = document.createElement("div"); recipients.className = "payout-recipients";
    for (const holder of batch.recipients) {
      const recipient = document.createElement("span");
      recipient.textContent = `${short(holder.wallet)} · ${amount(holder.rewardAtoms, batch.rewardDecimals)}`;
      recipient.title = holder.wallet;
      recipients.append(recipient);
    }
    row.append(summary, recipients); fragment.append(row);
  }
  list.append(fragment);
}

async function loadPayoutPage(): Promise<void> {
  if (payoutBusy || (payoutPageLoaded && !payoutNextCursor)) return;
  const generation = statsGeneration;
  payoutBusy = true;
  const state = byId<HTMLDivElement>("stats-load-state");
  state.textContent = "Loading transfers…";
  try {
    const query = payoutNextCursor ? `?cursor=${payoutNextCursor}` : "";
    const response = await fetch(`/api/stats/payouts${query}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Transfers unavailable");
    const page = await response.json() as { items: PayoutBatch[]; nextCursor: number | null };
    if (generation !== statsGeneration) return;
    payoutBatches.push(...page.items);
    payoutNextCursor = page.nextCursor;
    payoutPageLoaded = true; payoutBusy = false;
    if (statsView === "payouts") {
      byId("stats-list-count").textContent = `${payoutBatches.length}${payoutNextCursor ? "+" : ""} transfers`;
      renderStatsList();
      state.textContent = payoutNextCursor ? "Scroll for more" : "";
    }
  } catch {
    if (generation !== statsGeneration) return;
    payoutBusy = false;
    if (statsView === "payouts") {
      state.replaceChildren();
      const retry = document.createElement("button"); retry.type = "button";
      retry.className = "stats-retry"; retry.textContent = "Could not load. Retry";
      retry.addEventListener("click", () => { void loadPayoutPage(); }); state.append(retry);
    }
  }
}

async function hydratePurchaseMetadata(rows: Purchase[]): Promise<void> {
  const missing = rows.filter((row) => !row.name || !row.symbol || !row.imageUrl);
  for (let index = 0; index < missing.length; index += 3) {
    await Promise.allSettled(missing.slice(index, index + 3).map(async (row) => {
      const metadata = await lookupTokenMetadata(row);
      tokenMetadataCache.set(tokenMetadataKey(row), metadata);
      row.name = metadata.name; row.symbol = metadata.symbol; row.imageUrl = metadata.imageUrl;
      if (byId<HTMLDialogElement>("stats-modal").open) renderStatsList();
    }));
  }
}

async function loadStatsPage(): Promise<void> {
  if (statsBusy || (statsPageLoaded && !statsNextCursor)) return;
  const generation = statsGeneration;
  statsBusy = true;
  const state = byId<HTMLDivElement>("stats-load-state");
  state.textContent = "Loading 10 tokens…";
  try {
    const query = statsNextCursor ? `?cursor=${encodeURIComponent(statsNextCursor)}` : "";
    const response = await fetch(`/api/stats/purchases${query}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Purchase page unavailable");
    const page = await response.json() as { items: Purchase[]; nextCursor: string | null };
    if (generation !== statsGeneration) return;
    purchases.push(...page.items);
    statsNextCursor = page.nextCursor;
    statsPageLoaded = true;
    statsBusy = false;
    if (statsView === "buys") {
      renderStatsList();
      state.textContent = statsNextCursor ? "Scroll for more" : "";
    }
    void hydratePurchaseMetadata(page.items);
  } catch {
    if (generation !== statsGeneration) return;
    statsBusy = false;
    if (statsView === "buys") {
      state.replaceChildren();
      const retry = document.createElement("button"); retry.type = "button";
      retry.className = "stats-retry"; retry.textContent = "Could not load. Retry";
      retry.addEventListener("click", () => { void loadStatsPage(); });
      state.append(retry);
    }
  }
}

let toastTimer: number | undefined;
function toast(message: string, isError = false, durationMs = 6500): void {
  const element = byId<HTMLDivElement>("toast");
  const host = document.querySelector<HTMLDialogElement>("dialog[open]") ?? byId("app");
  if (element.parentElement !== host) host.append(element);
  element.textContent = message;
  element.classList.toggle("error", isError);
  element.hidden = false;
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { element.hidden = true; toastTimer = undefined; }, durationMs);
}

function walletChoices(): Wallet[] {
  return getWallets().get().filter((wallet) => Boolean(wallet.features[StandardConnect] && wallet.features[SolanaSignMessage]));
}

function renderWalletChoices(): void {
  const list = byId<HTMLDivElement>("sol-wallet-list");
  list.replaceChildren();
  const wallets = walletChoices();
  if (!wallets.length) {
    const empty = document.createElement("p");
    empty.className = "wallet-picker-empty";
    empty.textContent = "No compatible Solana wallet found. Install Phantom or another wallet that can sign messages, then try again.";
    list.append(empty);
    return;
  }
  for (const wallet of wallets) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wallet-option";
    const mark = document.createElement("span");
    mark.className = "wallet-option-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = wallet.name.slice(0, 1).toUpperCase();
    const name = document.createElement("span");
    name.textContent = wallet.name;
    const arrow = document.createElement("span");
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "↗";
    button.append(mark, name, arrow);
    button.disabled = busy;
    button.addEventListener("click", () => { void connectSol(wallet); });
    list.append(button);
  }
}

function renderRewards(): void {
  const body = byId<HTMLDivElement>("rewards-body");
  body.replaceChildren();
  byId<HTMLSpanElement>("round-count").textContent = `${rewards.length} ${rewards.length === 1 ? "round" : "rounds"}`;
  byId<HTMLDivElement>("rewards-table-head").hidden = rewards.length === 0;
  if (!solAccount || rewards.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const title = document.createElement("strong"); title.textContent = solAccount ? "No allocations yet" : "Connect your Solana wallet";
    const description = document.createElement("p");
    description.textContent = solAccount ? "Your rewards will appear here after purchases and holder snapshots."
      : "Your allocations will appear here after you connect.";
    empty.append(title, description);
    body.append(empty);
    return;
  }
  for (const reward of rewards) {
    const row = document.createElement("div"); row.className = "reward-row";
    const identity = document.createElement("div"); identity.className = "reward-identity";
    const network = document.createElement("span"); network.className = `network-badge ${reward.chain}`;
    network.textContent = reward.chain === "robinhood" ? "RH" : reward.chain === "bsc" ? "BNB" : "SOL";
    const text = document.createElement("div");
    const name = document.createElement("strong"); name.textContent = short(reward.token); name.title = reward.token;
    const platform = document.createElement("span"); platform.className = "reward-platform";
    platform.textContent = ({ pumpfun: "Pump.fun", stonkfun: "StonkFun", fourmeme: "Four.meme",
      flap_tax: "Flap · taxed", flap_nontax: "Flap · no tax", pons_v2: "Pons V2" } as Record<string, string>)[reward.launchpad]
      ?? reward.launchpad;
    text.append(name, platform); identity.append(network, text);
    const value = document.createElement("span"); value.className = "reward-amount";
    value.textContent = amount(reward.rewardAtoms, reward.rewardDecimals);
    value.title = `${reward.rewardAtoms} base units`;
    const state = document.createElement("span"); state.className = "reward-state";
    if (reward.deliveryMode === "push" && reward.chain === "sol") {
      state.textContent = reward.payoutState === "sent" ? "Sent to wallet" :
        reward.payoutState === "batched" ? "Sending" : "Queued for delivery";
      if (reward.payoutTx) state.title = `Solana transaction: ${reward.payoutTx}`;
    }
    else if (reward.claimed) state.textContent = "Claimed";
    else if (reward.submitted && reward.chain === "sol") state.textContent = "Claim submitted";
    else if (!reward.claimReady) state.textContent = reward.chain === "sol" ? "Pending funding" : "Not available yet";
    else {
      const button = document.createElement("button"); button.type = "button"; button.className = "claim-button";
      button.textContent = reward.submitted && reward.chain !== "sol" ? "Finish claim" : "Claim";
      button.disabled = busy;
      button.addEventListener("click", () => { void claimReward(reward); });
      state.append(button);
    }
    row.append(identity, value, state); body.append(row);
  }
}

async function claimReward(reward: Reward): Promise<void> {
  if (!solAccount || busy) return;
  if (reward.chain !== "sol") {
    if (!evmAddress && !await connectEvm()) return;
    if (linkedAddress?.toLowerCase() !== evmAddress?.toLowerCase() && !await linkWallets()) return;
  }
  busy = true; render();
  try {
    if (reward.chain === "sol") {
      if (!selectedSolWallet) throw new UiError("Connect your Solana wallet first");
      const feature = (selectedSolWallet.features as Wallet["features"] & SolanaSignAndSendTransactionFeature)
        [SolanaSignAndSendTransaction];
      if (!feature || !feature.supportedTransactionVersions.includes(0))
        throw new UiError("This wallet cannot send Solana v0 transactions");
      const response = await fetch("/api/claims/solana/prepare", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidateId: reward.candidateId, solWallet: solAccount.address }) });
      if (!response.ok) throw new UiError("The Solana claim is not ready yet");
      const prepared = await response.json() as { transactionBase64: string; chain: string };
      if (!/^solana:[a-z0-9-]+$/.test(prepared.chain)) throw new UiError("Invalid Solana network");
      const transaction = Uint8Array.from(atob(prepared.transactionBase64), (char) => char.charCodeAt(0));
      const sent = (await feature.signAndSendTransaction({ account: solAccount, transaction,
        chain: prepared.chain as `solana:${string}`, options: { commitment: "confirmed", skipPreflight: false } }))[0];
      if (!sent) throw new UiError("The wallet did not submit the claim");
      reward.submitted = true;
      const signature = bs58.encode(sent.signature);
      let confirmed = false;
      for (let attempt = 0; attempt < 5 && !confirmed; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 1_000));
        const finalized = await fetch("/api/claims/solana/finalize", { method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ candidateId: reward.candidateId, solWallet: solAccount.address, signature }) });
        confirmed = finalized.ok;
      }
      if (confirmed) reward.claimed = true;
      toast(confirmed ? `Claimed: ${short(signature)}` : `Claim submitted: ${short(signature)}`);
    } else {
      const isRh = reward.chain === "robinhood";
      const label = isRh ? "RH" : "BNB";
      const apiChain = isRh ? "rh" : "bsc";
      const chainId = isRh ? 4663 : 56;
      const chainHex = `0x${chainId.toString(16)}`;
      if (!window.ethereum || !evmAddress || !linkedAddress ||
          evmAddress.toLowerCase() !== linkedAddress.toLowerCase())
        throw new UiError(`Connect and link your ${label} wallet first`);
      const network = await window.ethereum.request({ method: "eth_chainId" });
      if (network !== chainHex) {
        try {
          await window.ethereum.request({ method: "wallet_switchEthereumChain",
            params: [{ chainId: chainHex }] });
        } catch (error) {
          if ((error as { code?: number })?.code !== 4902) throw error;
          await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{
            chainId: chainHex, chainName: isRh ? "Robinhood Chain" : "BNB Smart Chain",
            nativeCurrency: { name: isRh ? "Ether" : "BNB", symbol: isRh ? "ETH" : "BNB", decimals: 18 },
            rpcUrls: [isRh ? "https://rpc.mainnet.chain.robinhood.com" : "https://bsc-dataseed.bnbchain.org"],
            blockExplorerUrls: [isRh ? "https://robinhoodchain.blockscout.com" : "https://bscscan.com"],
          }] });
        }
      }
      const key = `nomo:${apiChain}-claim:${reward.candidateId}:${solAccount.address}`;
      let reimbursementHash = localStorage.getItem(key);
      if (!reimbursementHash) {
        const response = await fetch(`/api/claims/${apiChain}/prepare`, { method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ candidateId: reward.candidateId, solWallet: solAccount.address }) });
        if (!response.ok) throw new UiError(`The ${label} claim is not ready yet`);
        const prepared = await response.json() as { chainId: number; recipient: string;
          gasWallet: string; feeWei: string; reimbursementHash?: string };
        if (prepared.chainId !== chainId || prepared.recipient.toLowerCase() !== evmAddress.toLowerCase() ||
            !/^0x[\da-fA-F]{40}$/.test(prepared.gasWallet) || !/^\d+$/.test(prepared.feeWei))
          throw new UiError(`Invalid ${label} claim quote`);
        const sent = prepared.reimbursementHash ?? await window.ethereum.request({
          method: "eth_sendTransaction", params: [{ from: evmAddress, to: prepared.gasWallet,
            value: `0x${BigInt(prepared.feeWei).toString(16)}` }] });
        if (typeof sent !== "string" || !/^0x[\da-fA-F]{64}$/.test(sent))
          throw new UiError(`${label} wallet did not return a transaction hash`);
        reimbursementHash = sent;
        localStorage.setItem(key, sent);
      }
      reward.submitted = true;
      let finalized = false;
      for (let attempt = 0; attempt < 12 && !finalized; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 2_000));
        const response = await fetch(`/api/claims/${apiChain}/finalize`, { method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ candidateId: reward.candidateId, solWallet: solAccount.address,
            reimbursementHash }) });
        finalized = response.ok;
      }
      if (finalized) { reward.claimed = true; localStorage.removeItem(key); }
      toast(finalized ? `${label} reward claimed` : `${label} payment submitted. Reopen this reward to finish the claim`);
    }
  } catch (error) { toast(userError(error, "Could not submit the claim"), true); }
  finally { busy = false; render(); }
}

function render(): void {
  const connectedSol = Boolean(solAccount);
  const connectedEvm = Boolean(evmAddress);
  const linked = connectedEvm && linkedAddress?.toLowerCase() === evmAddress?.toLowerCase();
  byId("sol-status").textContent = connectedSol ? short(solAccount!.address) : "Not connected";
  byId("evm-status").textContent = connectedEvm ? short(evmAddress!) : "Not connected";
  byId("link-state").textContent = linked ? "Linked" : "Link on claim";
  byId("evm-progress").hidden = !connectedEvm;
  byId("wallet-progress").hidden = !connectedSol;
  solWalletPicker.hidden = !showSolWalletPicker;
  walletNext.hidden = connectedSol;
  byId<HTMLButtonElement>("change-sol").disabled = busy;
  byId<HTMLButtonElement>("change-evm").disabled = busy;
  if (!connectedSol) {
    byId("wallet-step").textContent = "YOUR WALLET";
    byId("wallet-step-title").textContent = "See what’s yours.";
    byId("wallet-step-description").textContent = "Connect the Solana wallet that held NOMO at the snapshot.";
  } else {
    byId("wallet-step").textContent = "CONNECTED";
    byId("wallet-step-title").textContent = "Your wallet is ready.";
    byId("wallet-step-description").textContent = rewards.length ?
      "Solana rewards arrive automatically. Claim BNB or RH rewards from their rows." :
      "Your allocations will appear below after qualifying purchases and snapshots.";
  }
  walletNext.textContent = busy ? "Please wait…" : "Choose Solana wallet";
  walletNext.disabled = busy;
  renderWalletChoices();
  renderRewards();
}

async function loadRewards(): Promise<void> {
  if (!solAccount) { rewards = []; render(); return; }
  const response = await fetch(`/api/rewards/${encodeURIComponent(solAccount.address)}`);
  if (!response.ok) throw new UiError("Could not load your allocations");
  const data = await response.json() as { items: Reward[] };
  rewards = data.items;
  render();
}

async function connectSol(wallet: Wallet): Promise<void> {
  busy = true; render();
  try {
    const feature = (wallet.features as Wallet["features"] & StandardConnectFeature)[StandardConnect];
    const result = await feature.connect();
    const account = result.accounts.find((item) => item.chains.some((chain) => chain.startsWith("solana:")) &&
      item.features.includes(SolanaSignMessage));
    if (!account) throw new UiError("This wallet cannot sign Solana messages");
    selectedSolWallet = wallet; solAccount = account; linkedAddress = undefined; rewards = [];
    showSolWalletPicker = false;
    await loadRewards();
    const link = await fetch(`/api/link/${encodeURIComponent(account.address)}`);
    if (link.ok) linkedAddress = (await link.json() as { linked: string | null }).linked ?? undefined;
    toast("Solana wallet connected");
  } catch (error) { toast(userError(error, "Could not connect the Solana wallet"), true); }
  finally { busy = false; render(); }
}

async function connectEvm(): Promise<boolean> {
  if (!window.ethereum) { toast("Install an EVM wallet to claim BNB or RH rewards", true); return false; }
  busy = true; render();
  try {
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" }) as string[];
    if (!accounts[0]) throw new UiError("The wallet did not return an address");
    evmAddress = accounts[0];
    return true;
  } catch (error) { toast(userError(error, "Could not connect the EVM wallet"), true); return false; }
  finally { busy = false; render(); }
}

async function linkWallets(): Promise<boolean> {
  if (!solAccount || !selectedSolWallet || !evmAddress || !window.ethereum) return false;
  busy = true; render();
  try {
    const response = await fetch("/api/link/challenge", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ solWallet: solAccount.address, evmWallet: evmAddress }) });
    if (!response.ok) throw new UiError("Could not create a wallet link request");
    const challenge = await response.json() as { id: string; message: string };
    const message = new TextEncoder().encode(challenge.message);
    const signFeature = (selectedSolWallet.features as Wallet["features"] & SolanaSignMessageFeature)[SolanaSignMessage];
    const signed = (await signFeature.signMessage({ account: solAccount, message }))[0];
    if (!signed || signed.signedMessage.length !== message.length ||
        signed.signedMessage.some((byte, index) => byte !== message[index]))
      throw new UiError("The wallet changed the signed message");
    const solSignatureBase64 = btoa(String.fromCharCode(...signed.signature));
    const messageHex = `0x${Array.from(message, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const evmSignature = await window.ethereum.request({ method: "personal_sign", params: [messageHex, evmAddress] });
    const confirmed = await fetch("/api/link/confirm", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: challenge.id, solSignatureBase64, evmSignature }) });
    if (!confirmed.ok) throw new UiError("The wallet signatures could not be verified");
    linkedAddress = evmAddress;
    return true;
  } catch (error) { toast(userError(error, "Could not link the wallets"), true); return false; }
  finally { busy = false; render(); }
}

walletNext.addEventListener("click", () => {
  if (busy) return;
  showSolWalletPicker = true;
  render();
  (byId("sol-wallet-list").querySelector("button") ?? byId("cancel-sol-wallet")).focus();
});
byId<HTMLButtonElement>("change-sol").addEventListener("click", () => {
  if (busy) return;
  showSolWalletPicker = true;
  render();
  (byId("sol-wallet-list").querySelector("button") ?? byId("cancel-sol-wallet")).focus();
});
byId<HTMLButtonElement>("change-evm").addEventListener("click", () => { if (!busy) void connectEvm(); });
byId<HTMLButtonElement>("cancel-sol-wallet").addEventListener("click", () => {
  showSolWalletPicker = false;
  render();
  byId<HTMLButtonElement>(solAccount ? "change-sol" : "wallet-next").focus();
});

getWallets().on("register", () => { renderWalletChoices(); render(); });
getWallets().on("unregister", () => { renderWalletChoices(); render(); });
renderWalletChoices(); render();
const rewardsModal = byId<HTMLDialogElement>("rewards-modal");
byId<HTMLButtonElement>("open-rewards").addEventListener("click", () => {
  rewardsModal.showModal();
  if (solAccount) void loadRewards().catch(() => toast("Could not refresh your rewards", true));
});
byId<HTMLButtonElement>("close-rewards").addEventListener("click", () => rewardsModal.close());
rewardsModal.addEventListener("click", (event) => {
  if (event.target !== rewardsModal) return;
  const rect = rewardsModal.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right ||
      event.clientY < rect.top || event.clientY > rect.bottom) rewardsModal.close();
});
const thesisModal = byId<HTMLDialogElement>("thesis-modal");
byId<HTMLButtonElement>("open-thesis").addEventListener("click", () => thesisModal.showModal());
byId<HTMLButtonElement>("close-thesis").addEventListener("click", () => thesisModal.close());
thesisModal.addEventListener("click", (event) => {
  if (event.target !== thesisModal) return;
  const rect = thesisModal.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right ||
      event.clientY < rect.top || event.clientY > rect.bottom) thesisModal.close();
});
const statsModal = byId<HTMLDialogElement>("stats-modal");
const statsScroll = byId<HTMLDivElement>("stats-scroll");
function selectStatsView(view: "buys" | "payouts"): void {
  statsView = view;
  statsScroll.scrollTop = 0;
  statsScroll.setAttribute("aria-label", view === "buys" ? "Bought tokens list" : "Holder transfer log");
  byId("stats-buys-tab").setAttribute("aria-selected", String(view === "buys"));
  byId("stats-payouts-tab").setAttribute("aria-selected", String(view === "payouts"));
  byId("stats-list-count").textContent = view === "buys"
    ? `${(statsSummary?.count ?? 0).toLocaleString("en-US")} ${statsSummary?.count === 1 ? "buy" : "buys"}`
    : `${payoutBatches.length}${payoutNextCursor ? "+" : ""} transfers`;
  byId("stats-load-state").textContent = "";
  renderStatsList();
  if (view === "buys") void loadStatsPage();
  else void loadPayoutPage();
}
byId<HTMLButtonElement>("stats-buys-tab").addEventListener("click", () => selectStatsView("buys"));
byId<HTMLButtonElement>("stats-payouts-tab").addEventListener("click", () => selectStatsView("payouts"));
byId<HTMLButtonElement>("open-stats").addEventListener("click", () => {
  statsGeneration++;
  purchases = [];
  statsNextCursor = null;
  statsPageLoaded = false;
  statsBusy = false;
  payoutBatches = [];
  payoutNextCursor = null;
  payoutPageLoaded = false;
  payoutBusy = false;
  statsScroll.scrollTop = 0;
  byId("stats-load-state").replaceChildren();
  selectStatsView("buys");
  statsModal.showModal();
  void loadStatsSummary();
  void loadStatsPage();
});
byId<HTMLButtonElement>("close-stats").addEventListener("click", () => statsModal.close());
statsModal.addEventListener("click", (event) => {
  if (event.target !== statsModal) return;
  const rect = statsModal.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right ||
      event.clientY < rect.top || event.clientY > rect.bottom) statsModal.close();
});
const statsObserver = new IntersectionObserver((entries) => {
  if (statsModal.open && entries.some((entry) => entry.isIntersecting))
    void (statsView === "buys" ? loadStatsPage() : loadPayoutPage());
}, { root: statsScroll, rootMargin: "120px" });
statsObserver.observe(byId("stats-sentinel"));
statsScroll.addEventListener("scroll", () => {
  if (statsScroll.scrollTop + statsScroll.clientHeight >= statsScroll.scrollHeight - 120)
    void (statsView === "buys" ? loadStatsPage() : loadPayoutPage());
});
document.querySelectorAll<HTMLButtonElement>(".chain-filters button[data-chain]").forEach((button) => {
  button.addEventListener("click", () => {
    activityChain = button.dataset.chain ?? "all";
    activityVisibleCount = activityPageSize;
    document.querySelectorAll<HTMLButtonElement>(".chain-filters button[data-chain]").forEach((option) => {
      const selected = option === button;
      option.classList.toggle("active", selected);
      option.setAttribute("aria-pressed", String(selected));
    });
    renderActivity();
    byId<HTMLDivElement>("activity-body").scrollTop = 0;
  });
});
byId<HTMLDivElement>("activity-body").addEventListener("scroll", (event) => {
  const body = event.currentTarget as HTMLDivElement;
  if (body.scrollTop + body.clientHeight < body.scrollHeight - 120) return;
  const total = activity.filter((item) => activityChain === "all" || item.chain === activityChain).length;
  if (activityVisibleCount >= total) return;
  activityVisibleCount += activityPageSize;
  renderActivity();
});
void loadActivity();
void loadStatsSummary();
window.setInterval(() => { void loadActivity(); }, 10_000);
window.setInterval(() => { void loadStatsSummary(); }, 30_000);
window.setInterval(() => {
  if (solAccount && rewardsModal.open && !busy)
    void loadRewards().catch(() => toast("Could not refresh your rewards", true));
}, 10_000);
void fetch("/health").then((response) => response.json()).then((health: { mode: string; lastPollError: string | null }) => {
  byId("system-status").textContent = health.lastPollError ? "Feed issue" :
    health.mode === "read_only" ? "Preview mode" : "Monitoring active";
}).catch(() => { byId("system-status").textContent = "Server unavailable"; });
