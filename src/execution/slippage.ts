/** User-selected maximum purchase slippage: 99% = 9,900 basis points. */
export const PURCHASE_SLIPPAGE_BPS = 9_900;

export function validPurchaseSlippage(bps: number): boolean {
  return Number.isInteger(bps) && bps >= 1 && bps <= PURCHASE_SLIPPAGE_BPS;
}
