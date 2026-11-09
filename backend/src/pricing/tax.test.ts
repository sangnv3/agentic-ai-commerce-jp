import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTax } from "./tax.js";

test("example order from the conversation script (docs/05 §5.1)", () => {
  const s = computeTax([
    { amountInclTax: 1340, taxRate: 8 }, // 定食 + 緑茶
    { amountInclTax: -100, taxRate: 8 }, // coupon LUNCH100 on food
    { amountInclTax: 330, taxRate: 10 }, // 配送料
  ]);
  assert.equal(s.total, 1570);
  assert.deepEqual(s.buckets, [
    { rate: 8, taxableAmountInclTax: 1240, tax: 91 },
    { rate: 10, taxableAmountInclTax: 330, tax: 30 },
  ]);
});

test("tax is rounded once per rate, not per line", () => {
  // 3 × ¥105: per-line rounding would give floor(105*8/108)=7, ×3 = 21;
  // the qualified-invoice rule rounds the bucket once: floor(315*8/108) = 23
  const s = computeTax([
    { amountInclTax: 105, taxRate: 8 },
    { amountInclTax: 105, taxRate: 8 },
    { amountInclTax: 105, taxRate: 8 },
  ]);
  assert.equal(s.buckets[0].tax, 23);
});

test("rejects non-integer yen", () => {
  assert.throws(() => computeTax([{ amountInclTax: 10.5, taxRate: 8 }]));
});
