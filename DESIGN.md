# NOMO website design

The interface is in English. The visual direction comes from the [Hims App reference on Refero](https://styles.refero.design/style/0a489bce-4f93-4b38-b612-d87b1d00999e), selected for NOMO. Its open layout and typography support a different story: a phone scrolls on the left while NOMO's graduation activity appears on the right.

## Design decisions

| Element | Implementation |
| --- | --- |
| Canvas | White background, near-black primary text, restrained gray secondary text. |
| Accent | `#5d48db` headline; a broad, irregular pink-to-apricot-to-teal stroke under NOMO. |
| Type | Locally hosted Sofia Sans, selected for its proximity to the reference. |
| Shape | Soft 30–52 px radii, thin rules, long subdued shadows. |
| Hero image | Adapted Refero media: a pink phone without a hand, entering from the lower-left edge over a lavender glow. |
| Phone screen | HTML/CSS post skeletons scroll slowly within the screen mask; reduced-motion preferences stop the animation. |
| Activity feed | Qualified tokens only, with name, ticker and available token artwork. Verified purchases show the actual amount spent. |
| Rewards | A compact modal shows Solana delivery and per-row BNB/RH claims. Connecting an EVM wallet and signing the link happen within the claim flow. |
| Stats | A modal shows confirmed purchases, chain totals and a list that loads ten more rows as the user scrolls. |
| Thesis | A modal explains graduation checks, the 25% treasury budget and the 70/30 split. |

The Refero source captures are retained locally in `design-reference/` for provenance. The deployed phone adaptation is `web/public/images/refero-phone-only.png`. Rights to third-party reference media and exact brand type should be reviewed before wider commercial use.

## States and responsive behavior

- An unconfirmed purchase displays a dash; the amount appears only after a confirmed transaction is journaled.
- Candidates without fresh GMGN Total Fees or required metadata stay in the internal journal. They do not appear in the public feed.
- Token metadata is cached in SQLite across restarts. When artwork is unavailable, the feed displays a neutral placeholder. The fee value is used for screening and is not displayed in each row.
- Chain filters work on the loaded feed. Data refreshes every ten seconds.
- On desktop the hero fits the viewport, with the phone entering from the left edge and the feed scrolling on the right. Narrow screens give the feed full width and allow it to continue below the first viewport.
- Visible keyboard focus, legible controls and reduced-motion behavior are preserved.
- Solana rewards from new rounds are delivered automatically. BNB/RH claims guide the holder through wallet connection, two signatures, network-fee reimbursement and payout; errors remain visible inside the open modal.
- Stats count completed purchases only. USD totals use current Binance spot quotes with CoinGecko fallback and are estimates, not historical execution prices.
