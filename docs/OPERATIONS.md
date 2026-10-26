# NOMO operations guide

NOMO is a backend-managed holder-rewards system for a Pump.fun token quoted in PUMP (`pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn`). It discovers newly graduated tokens, screens them, buys eligible tokens with a portion of the Solana treasury, and allocates the received tokens to NOMO holders. Jupiter is not used.

## Discovery and eligibility

- Solana: Helius logs and GMGN discover Pump.fun graduations. GMGN `completed` and StonkFun's API cover StonkFun candidates. Migration transactions and pools are verified against Solana RPC. PumpSwap's on-chain flag excludes Mayhem Mode.
- BNB Chain: Flap tax and non-tax graduations and Four.meme liquidity events are read from RPC with persistent cursors. GMGN `completed` supplies additional leads; a lead is not accepted without the launchpad event and pool verification.
- Robinhood Chain: Pons V2 graduation events, factory state and Uniswap v4 pool registration are verified through RPC. GMGN supplies the Total Fees metric.
- Quote assets can be non-native. Discovery records the actual pair asset. A buy still requires a liquid, validated path from SOL, BNB or ETH to the target token at execution time.
- Each candidate needs fresh GMGN **Total Fees** for that candidate: at least 1 SOL on Solana, 0.15 BNB on BNB Chain, or 0.042934 ETH on Robinhood Chain. The ETH threshold was set to approximately $100 on 26 October 2026; it is a fixed ETH threshold, not a live USD conversion. These fees screen third-party tokens and are unrelated to NOMO creator fees.
- Additional configurable checks include market capitalization, liquidity, holder count, volume, concentration, tax and graduation age. Missing required data blocks eligibility. The public feed waits for an eligible token's name and symbol. Solana metadata is fetched through Helius DAS first and cached in SQLite.

See [`config/filters.example.json`](../config/filters.example.json) for the active defaults and optional fields. Fees are denominated in the chain's native asset. Concentration values are fractions, tax uses basis points, age uses seconds and the other monetary filters use USD.

## Purchase and distribution

The execution journal handles one candidate at a time. On activation it stores a per-chain start time; only newer graduations can be bought. An eligible candidate must also be no more than five minutes old when selected and before an unsigned buy is prepared.

An independent journaled job checks for NOMO creator fees every minute: it sweeps the PUMP-quoted Pump.fun curve before migration, adds the PumpSwap pool after migration, claims the fees and swaps collected PUMP to SOL. It resumes the same operation IDs after a restart. Each selected candidate also triggers a fresh claim before the backend calculates 25% of the current available SOL treasury balance. A budget below **1 SOL** aborts the purchase before any bridge or buy. The minimum applies to Solana, BNB and Robinhood purchases because their budget originates in SOL.

For BNB and RH, Relay bridges the allocated SOL to the destination treasury, leaving a native gas reserve (default 0.002 BNB or 0.002 ETH). BNB swaps use a validated public Relay route. RH first quotes the on-chain Pons Uniswap v4 route and uses Relay only when the direct route is unavailable. A missing or changed route stops the buy. Purchases allow 99% slippage, so the minimum output can be only 1% of the current quote. The actual received balance, not the quote, is used to determine the reward amount.

The backend takes a finalized NOMO holder snapshot at purchase time. A wallet needs at least **1,000,000 NOMO**. Known curve and canonical liquidity-pool accounts are excluded. Of the tokens actually received, 70% are reserved for holders in proportion to the snapshot; 30% stay in the treasury. For taxed tokens, the allocation uses the amount that actually reaches the reward wallet.

New Solana rewards are sent automatically from the reward wallet. Up to four recipients are grouped into a transaction, with token-account creation where necessary. The reward wallet pays SOL network fees and account rent. BNB and RH holders link an EVM address by signing with both wallets. A claim reimburses the estimated native gas, then the backend sends the ERC-20 reward. Payment and payout are separate transactions; the journal keeps an incomplete claim for retry and prevents a second payout.

The same two EVM key files may be used on **both** BNB and RH: one treasury key and one reward key. Their public addresses are identical across these EVM networks, while balances and gas currencies remain chain-specific. They must be distinct from each other in the current custody model.

## Run locally

Requires Node.js 24 and npm:

```bash
npm ci
cp .env.example .env
npm run build
npm test
npm run web:build
npm start
```

The API defaults to `http://127.0.0.1:8789`. Run `npm run web:dev` separately for the Vite frontend on port 5173. Useful read endpoints include `/health`, `/api/candidates`, `/api/rounds`, `/api/stats` and `/api/stats/purchases?cursor=...`.

Set `HELIUS_RPC_URL`, `BSC_RPC_URL`, `RH_RPC_URL` and `GMGN_API_KEY` in the untracked local `.env`. EVM RPC endpoints must support `eth_getLogs`. The live BNB and RH execution paths use public Relay quotes; `ZEROX_API_KEY` is only for an older read-only route tool. The scanners begin at the current confirmed block unless `BSC_START_BLOCK` or `RH_START_BLOCK` is supplied. The execution engine still refuses pre-activation graduations.

## Route checks

- `npx tsx tools/route-plan-smoke.ts <token addresses>` inspects Solana route plans without sending transactions.
- `npx tsx tools/local-route-smoke.ts <token>` and `npx tsx tools/local-stonk-smoke.ts <token> [slippageBps]` use a local Surfpool fork at `127.0.0.1:8899`.
- `npx tsx tools/auto-buy-local-smoke.ts <token>` funds a temporary local wallet and exercises the Solana buy executor only against the local fork. Historical Pump.fun and StonkFun examples, including non-native pairs, have passed this test. Fork account-fetch failures can require a rerun.
- `npx tsx tools/bsc-route-smoke.ts <token> [BNB amount]` checks a Relay BNB quote and read-only `eth_call` with an overridden test balance. Flap tax, Flap non-tax and Four.meme examples were simulated; no BNB mainnet transaction was sent.
- `npx tsx tools/rh-route-smoke.ts <token> [ETH amount]` checks Pons factory and pool identities, chain ID 4663, the output token, a v4 quote and read-only `eth_call`. Several native and non-native Pons pairs passed this check. Relay's RH fallback returned HTTP 429 during earlier checks.
- `npx tsx tools/evm-claim-local-smoke.ts http://127.0.0.1:19056 56` and `npx tsx tools/evm-claim-local-smoke.ts http://127.0.0.1:19063 4663` exercise EVM claim payment, payout and replay protection on local Anvil chains. They use a temporary test token, not a production contract.
- For automatic Solana delivery, run `solana-test-validator --rpc-port 18999 --faucet-port 19001 --reset`, then `npx tsx tools/solana-auto-payout-local.ts http://127.0.0.1:18999 100`. The test checks batched transfers and recipient balances.

These checks are local or read-only. They do not cover a complete mainnet round funded by NOMO creator fees.

## Activation checks

1. Deploy NOMO and provide its mint. Its bonding curve must quote PUMP, and the treasury key must match the curve creator. NOMO does **not** have to graduate first. If its canonical PumpSwap pool has appeared, its quote and creator must also match. `SolanaExecutionAdapter.assertReady()` verifies the applicable on-chain state. An arbitrary LP address cannot override the canonical pool identity.
2. Put the Solana treasury and reward keypair JSON files outside the repository with `0600` permissions. Set `SOLANA_TREASURY_KEYPAIR_PATH`, `SOLANA_REWARD_KEYPAIR_PATH` and `MAIN_TOKEN_MINT`. The reward wallet must hold at least 0.01 SOL for startup; actual automatic payouts may need more for fees and account rent.
3. Set EVM treasury and reward key paths for any chain being activated (`BSC_*` and `RH_*`). The same pair can serve both EVM chains. The treasury receives bridged native currency; the reward wallet holds the 70% allocation and sends claims.
4. Confirm RPC health, fresh GMGN metrics, live route quotes, sufficient SOL treasury balance, a funded Solana reward wallet and no unresolved execution journal entry. A 1 SOL minimum buy at 25% of current balance generally requires at least about 4 SOL available after the Solana reserve, unless creator fees increase the balance first.
5. Enable `LIVE_TRADING=true` for Solana, then `LIVE_BSC_TRADING=true` and/or `LIVE_RH_TRADING=true` for the desired EVM chains. Observe an initial small mainnet round and reconcile the claim, bridge, purchase, holder snapshot and payouts against chain receipts before treating the system as proven.

Private keys, seed phrases, RPC credentials, `.env`, production SQLite files and local audit artifacts must remain outside Git. The server binds to localhost behind the reverse proxy. Signed operations are journaled before broadcast and reconciled after restarts.

## Protocol references

[Pump.fun creator fees](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COLLECT_CREATOR_FEE.md) · [PUMP-quoted creation](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/CREATE_WITH_PUMP_COIN_QUOTE.md) · [Four.meme trade guide](https://github.com/four-meme-community/fourmeme-docs/blob/main/docs/trade-guide.md) · [StonkFun API](https://www.stonkfun.xyz/developers) · [Robinhood Chain](https://docs.robinhood.com/chain/connecting/) · [Relay quotes](https://docs.relay.link/references/api/get-quote-v2) · [Helius DAS](https://www.helius.dev/blog/how-to-fetch-newly-minted-tokens-with-helius)
