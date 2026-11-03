/**
 * Number formatting for the log. Amounts stay bigints in token units until they are printed. Amounts round half up
 * to the places shown; health factors are cut to two places.
 */

/** `x` (an amount with `decimals` decimals) rounded half up to `places` decimals, scaled by 10^places. */
export function scaled(x: bigint, decimals: number, places: number): bigint {
  const neg = x < 0n;
  const a = neg ? -x : x;
  let r: bigint;
  if (places >= decimals) {
    r = a * 10n ** BigInt(places - decimals);
  } else {
    const d = 10n ** BigInt(decimals - places);
    r = (a + d / 2n) / d;
  }
  return neg ? -r : r;
}

/** A value scaled by 10^places as text with thousands separators: (1234567n, 2) gives "12,345.67". */
export function text(v: bigint, places: number): string {
  const neg = v < 0n;
  const digits = (neg ? -v : v).toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = places > 0 ? `.${digits.slice(digits.length - places)}` : "";
  return `${neg ? "-" : ""}${whole}${frac}`;
}

/** A token amount: amount(5_913_405_043_865_438_056n, 18, 4) gives "5.9134". */
export const amount = (x: bigint, decimals: number, places: number): string => text(scaled(x, decimals, places), places);

/** a × b rounded half up to `places`, for `a` with `pa` decimals and `b` with `pb`: (59134n, 4, 165387n, 2, 0) is 9780n. */
export const times = (a: bigint, pa: number, b: bigint, pb: number, places: number): bigint =>
  scaled(a * b, pa + pb, places);

/**
 * Parts to print that add up to a total as printed. Each part is rounded on its own, except the largest, which takes
 * what the total leaves. `off` is how many units that part is from its own rounding (0 or 1 when the parts add up).
 */
export function fit(total: bigint, exact: bigint[], decimals: number, places: number): { parts: bigint[]; off: bigint } {
  const own = exact.map((x) => scaled(x, decimals, places));
  const big = exact.reduce((best, x, i) => (x > exact[best] ? i : best), 0);
  const parts = [...own];
  parts[big] = total - own.reduce((sum, x, i) => (i === big ? sum : sum + x), 0n);
  return { parts, off: parts[big] - own[big] };
}

/**
 * A price (8 decimals) with the fewest places, 2 to 8, at which `amount` (with `places` decimals) gives the same
 * value at `valuePlaces` as the full price does. Printed amount × printed price then rounds to the printed value.
 */
export function priceFor(
  amount: bigint, places: number, price8: bigint, valuePlaces: number,
): { price: bigint; places: number; value: bigint } {
  const value = times(amount, places, price8, 8, valuePlaces);
  for (let p = 2; p < 8; p++) {
    const price = scaled(price8, 8, p);
    if (times(amount, places, price, p, valuePlaces) === value) return { price, places: p, value };
  }
  return { price: price8, places: 8, value };
}

/** Two amounts with the places it takes to tell them apart: at least `places`, at most `decimals`. */
export function apart(a: bigint, b: bigint, decimals: number, places: number): [string, string] {
  let at = Math.min(places, decimals);
  while (at < decimals && scaled(a, decimals, at) === scaled(b, decimals, at)) at++;
  return [amount(a, decimals, at), amount(b, decimals, at)];
}

/** Aave's base currency is USD with 8 decimals. */
export const usd = (x8: bigint, places = 0): string => `$${amount(x8, 8, places)}`;

/** A health factor (18 decimals), cut to two places so 0.996 shows as 0.99, never as 1.00. */
export const hf = (x18: bigint): string => text(x18 / 10n ** 16n, 2);

/** 1234567 gives "1,234,567". */
export const int = (n: number | bigint): string => text(BigInt(n), 0);

/** 0x99da8b0caE360DF0c2F1F855b8407EF69462E5F8 gives "0x99da…E5F8". Works for tx hashes too. */
export const short = (hex: string): string => `${hex.slice(0, 6)}…${hex.slice(-4)}`;

/** Decimal places to print a token with, from its USD price (8 decimals): 2 for USDC, 4 for WETH, 6 for WBTC. */
export const placesFor = (price8: bigint): number => (price8 >= 10_000n * 10n ** 8n ? 6 : price8 >= 50n * 10n ** 8n ? 4 : 2);
