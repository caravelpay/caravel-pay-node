import { normalizeAmount } from './amount.js';

/**
 * Currencies a checkout can be priced in, with their decimals. Anything but USD is converted to US dollars when the
 * checkout is created, and the rate is fixed for that checkout: buyers are always charged in US dollars and you are
 * always paid in USDC. The checkout keeps your `amount` and `currency` and adds `usd_amount` and `fx_rate`.
 */
export const CURRENCIES = Object.freeze({
  USD: 2, EUR: 2, GBP: 2, CAD: 2, AUD: 2, NZD: 2, SEK: 2, NOK: 2, DKK: 2, CHF: 2, PLN: 2, CZK: 2, HUF: 2, RON: 2, HKD: 2, SGD: 2, MXN: 2, BRL: 2, ZAR: 2,
  ILS: 2, INR: 2, THB: 2, MYR: 2, PHP: 2, TRY: 2, JPY: 0, KRW: 0,
});
/** The largest margin (`fx_buffer_bps`) a checkout accepts: 500 basis points, 5%. */
export const MAX_FX_BUFFER_BPS = 500;
export const FX_RATE = /^[0-9]{1,9}\.[0-9]{1,18}$/;

/** True for a currency a checkout can be priced in (upper case, as in ISO 4217). */
export const isSupportedCurrency = code => typeof code === 'string' && Object.hasOwn(CURRENCIES, code);
/** 2 for most currencies, 0 for JPY and KRW. Unknown codes count as 2. */
export const currencyDecimals = code => (isSupportedCurrency(code) ? CURRENCIES[code] : 2);

/**
 * A platform total as the API's string in the currency's own decimals: "49.9" → "49.90" for EUR, 5000 or
 * "5000.00" → "5000" for JPY. Throws RangeError for negative, non-numeric or over-precise values ("5000.50" JPY).
 * @param {string | number} amount
 * @param {string} [currency]
 */
export function formatAmount(amount, currency = 'USD') {
  if (currencyDecimals(currency) !== 0) return normalizeAmount(amount);
  let value = amount;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new RangeError('The amount must be a positive number.');
    if (value >= 1e13) throw new RangeError('The amount is too large.');
    value = Math.round(value).toFixed(0);
  }
  const match = typeof value === 'string' ? /^\s*([0-9]{1,13})(?:\.0*)?\s*$/.exec(value) : null;
  if (!match) throw new RangeError(`An amount in ${currency} must be a whole number such as "5000": ${currency} has no decimals.`);
  return match[1].replace(/^0+/, '') || '0';
}

/**
 * A saved "exchange-rate buffer" setting as whole basis points, 0 to 500. Takes a percentage ("1", "1.5", 2) and
 * returns basis points (100, 150, 200); anything else is 0.
 */
export function fxBufferBps(percent) {
  const value = typeof percent === 'string' ? Number(percent.trim().replace(',', '.') || NaN) : percent;
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(MAX_FX_BUFFER_BPS, Math.max(0, Math.round(value * 100)));
}

/**
 * About what an amount is in US dollars at a rate from fxQuote(), for a line shown to the buyer before the checkout
 * exists. An estimate: the checkout's own `usd_amount`, fixed when it is created, is what is charged.
 * @returns {string | null} Two decimals, or null when the inputs don't make an amount.
 */
export function estimateUsd(amount, rate, bufferBps = 0) {
  const value = Number(amount);
  if (typeof rate !== 'string' || !FX_RATE.test(rate) || amount === '' || amount === null || !Number.isFinite(value) || value <= 0) return null;
  const usd = value * Number(rate) * (1 + Math.min(MAX_FX_BUFFER_BPS, Math.max(0, Number(bufferBps) || 0)) / 10000);
  return Number.isFinite(usd) && usd > 0 ? (Math.round(Number(`${usd.toFixed(8)}e2`)) / 100).toFixed(2) : null;
}

/** One line for buyers before they are redirected, or '' for a store priced in US dollars. */
export function fxNotice(currency, usdEstimate) {
  if (!currency || currency === 'USD') return '';
  return typeof usdEstimate === 'string' && /^[0-9]{1,13}\.[0-9]{2}$/.test(usdEstimate)
    ? `You'll be charged in US dollars: about $${usdEstimate}. You see the exact amount before you pay.`
    : "You'll be charged in US dollars. You see the exact amount before you pay.";
}
