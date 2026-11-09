/**
 * Japanese consumption tax for a tax-included (総額表示) price list, compliant with the
 * Qualified Invoice System (適格請求書): tax is computed ONCE per tax rate per invoice,
 * from the tax-included total of that rate, and rounded down (切り捨て).
 *
 * - Food for delivery/takeout: reduced rate 8% (軽減税率)
 * - Delivery fee, alcohol, non-food goods: standard rate 10%
 * - Discounts are allocated to the rate bucket of the goods they apply to.
 */
export type TaxRate = 8 | 10;

export interface PricedLine {
  amountInclTax: number; // JPY integer, already × quantity
  taxRate: TaxRate;
}

export interface TaxBucket {
  rate: TaxRate;
  taxableAmountInclTax: number;
  tax: number;
}

export interface TaxSummary {
  buckets: TaxBucket[];
  total: number;
}

export function computeTax(lines: PricedLine[]): TaxSummary {
  const sums = new Map<TaxRate, number>();
  for (const l of lines) {
    if (!Number.isInteger(l.amountInclTax)) throw new Error("JPY amounts must be integers");
    sums.set(l.taxRate, (sums.get(l.taxRate) ?? 0) + l.amountInclTax);
  }
  const buckets: TaxBucket[] = [...sums.entries()]
    .filter(([, amount]) => amount !== 0)
    .sort(([a], [b]) => a - b)
    .map(([rate, amount]) => {
      if (amount < 0) throw new Error(`Negative taxable amount for ${rate}%`);
      return { rate, taxableAmountInclTax: amount, tax: Math.floor((amount * rate) / (100 + rate)) };
    });
  return { buckets, total: buckets.reduce((s, b) => s + b.taxableAmountInclTax, 0) };
}
