/**
 * A platform total as the API's two-decimal USD string: "49.9" → "49.90", 12 → "12.00".
 * Strings may have up to two decimals (more only if they are zeros). Numbers are rounded to cents.
 * @param {string | number} amount
 */
export function normalizeAmount(amount) {
  let value = amount;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new RangeError('The amount must be a positive number.');
    if (value >= 1e13) throw new RangeError('The amount is too large.');
    // Round half up on the decimal digits a person would read (1.005 → 1.01), not the binary value.
    value = (Math.round(Number(`${value.toFixed(8)}e2`)) / 100).toFixed(2);
  }
  const match = typeof value === 'string' ? /^\s*([0-9]{1,13})(?:\.([0-9]*?)0*)?\s*$/.exec(value) : null;
  if (!match) throw new RangeError('The amount must be a decimal number such as "136.41".');
  const decimals = match[2] ?? '';
  if (decimals.length > 2) throw new RangeError('The amount has more than two decimals.');
  const whole = match[1].replace(/^0+/, '') || '0';
  return `${whole}.${decimals.padEnd(2, '0')}`;
}

/** Exact cents as a BigInt: "136.41" → 13641n. */
export function toCents(amount) {
  return BigInt(normalizeAmount(amount).replace('.', ''));
}

/** -1, 0 or 1, exactly. */
export function compareAmounts(a, b) {
  const x = toCents(a);
  const y = toCents(b);
  return x === y ? 0 : x < y ? -1 : 1;
}
