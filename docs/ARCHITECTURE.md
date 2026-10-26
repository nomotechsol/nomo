# NOMO architecture

NOMO is an event-driven backend with a SQLite journal, chain-specific discovery, a single sequential execution engine and a public website. The main NOMO token is expected to launch on Pump.fun in a PUMP-quoted pool. The backend signs transactions; there is no custom claim contract or external multisig signer.

## Execution flow

1. Helius, GMGN and EVM RPC scanners discover new launchpad graduations. The launchpad transaction, pair token and destination pool are checked on chain. Persistent scanner cursors and candidate IDs suppress duplicates.
2. Fresh GMGN Total Fees and the configured launchpad filters qualify a candidate. Fees belong to the **candidate token** and serve only as a quality screen. Unknown required metrics block selection.
3. The engine selects one qualifying candidate newer than its chain's activation timestamp. Graduations older than five minutes are not started. Before an unsigned buy, filters and age are checked again.
4. The Solana treasury claims NOMO's own creator fees from the PUMP-quoted Pump.fun curve and PumpSwap pool. It converts available PUMP to SOL through a Raydium route, without Jupiter.
5. The engine budgets 25% of the current available SOL balance, keeping a SOL network reserve. Budgets under 1 SOL stop before a bridge or buy. BNB/RH budgets are bridged with Relay into their EVM treasuries and retain BNB/ETH gas reserves.
6. A finalized NOMO holder snapshot identifies wallets holding at least 1,000,000 NOMO. Known bonding-curve and canonical PUMP-pool accounts are excluded.
7. The destination-chain executor gets a fresh route and submits a signed buy. It verifies the transaction and measures the actual token balance increase. Pair assets may be non-native when a valid route exists.
8. Of the amount actually bought, 70% is transferred to a reward wallet and 30% remains with the treasury. Integer rounding dust belongs to the treasury. If a taxed token credits less than the nominal 70%, allocation uses only the credited amount.
9. Proportional holder allocations are calculated in integer base units. The allocation sum equals the credited holder pool.
10. The backend journals round publication and delivery. New Solana rounds are paid automatically in batches of up to four holders per transaction, including idempotent token-account creation. BNB/RH holders sign a wallet link, reimburse native gas and claim an ERC-20 transfer. Older Solana rounds can retain manual claims.

The execution journal stores operation IDs and signed transaction bytes before broadcast. On restart, it reconciles previous signatures rather than blindly repeating a transfer. Claim payments and payouts are separate EVM transactions; an incomplete claim stays recoverable.

## Chain-specific paths

| Chain | Discovery and pool checks | Purchase route | Delivery |
| --- | --- | --- | --- |
| Solana | Pump.fun Helius logs/GMGN, StonkFun GMGN/API, RPC migration verification; Mayhem Mode excluded | Validated PumpSwap/Raydium routes | Backend SPL transfers; reward wallet pays SOL fees and rent |
| BNB Chain | Flap tax/non-tax and Four.meme events, RPC pool verification, GMGN leads | Public Relay BNB-to-token route | Backend ERC-20 claim after BNB gas reimbursement |
| Robinhood Chain | Pons V2 factory graduation and Uniswap v4 pool verification | Direct on-chain v4 route via native or custom pair, then Relay fallback | Backend ERC-20 claim after ETH gas reimbursement |

BNB and RH use the **same EVM execution and claim classes** with different chain IDs, RPC URLs, native balances and route selection. A single pair of EVM private keys may be reused on both networks: one treasury signer and one reward signer. The two roles remain separate in the current custody model.

## Operational limits

- `LIVE_TRADING=true` requires a deployed NOMO mint, the canonical graduated PumpSwap pool with PUMP as quote token, a treasury signer matching the on-chain creator and a Solana reward signer with at least 0.01 SOL. `LIVE_BSC_TRADING` and `LIVE_RH_TRADING` each require their RPC and EVM key paths in addition to Solana live mode.
- The finalized holder snapshot uses Solana `getProgramAccounts` at one bank view. The Helius plan must support the real NOMO holder set. If it does not, a slot-consistent indexed snapshot is needed.
- Helius WebSocket alone cannot guarantee discovery during outages. GMGN and launchpad APIs provide bounded recent-history fallback, but high-volume periods can exceed their result limits. Guaranteed coverage would require a cursor-based indexed event stream.
- Pump.fun candidates require an on-chain PumpSwap pool and Mayhem flag check. StonkFun's GMGN pool address is the destination CPMM pool; the original LaunchLab pool comes from StonkFun data and is verified by the migration transaction.
- Four.meme's `LiquidityAdded` event does not itself identify the DEX pool. The scanner searches the same transaction for a unique matching token pair and leaves ambiguous pools unqualified.
- Pons V2 verifies factory phase, pair currency and Uniswap v4 pool ID. A native ETH pair is represented by the zero address; custom ERC-20 pairs use their actual addresses.
- A route quote is time-sensitive. 99% purchase slippage permits a minimum output as low as 1% of the quote. No discovered token or pair is guaranteed to remain liquid or transferable.
- Direct EVM claims require two non-atomic transactions. The backend verifies reimbursement sender, recipient, amount, chain and confirmations; payment cannot be reused. Retry state remains if the payout fails.
- Transfer-tax, transfer-blocked or honeypot tokens can defeat delivery. Available filters and simulations reduce that risk, but the allocation is always based on tokens credited to the reward wallet.

## Verification scope

Unit and local integration tests cover filters, the sequential budget, snapshots, allocation math, journal recovery, wallet linking and claim replay protection. Automatic Solana payout was tested on `solana-test-validator` with 100 holders. Solana purchases were exercised on a local Surfpool fork for selected Pump.fun and StonkFun examples. BNB Flap/Four.meme and RH Pons routes passed read-only `eth_call` examples, and EVM claims passed local Anvil tests. These results are route- and state-specific. NOMO creator-fee collection, PUMP-to-SOL conversion, Relay settlement and a full funded purchase/distribution cycle have not yet been confirmed together on mainnet because NOMO is not deployed.

See the [operations guide](OPERATIONS.md) for setup and activation checks.
