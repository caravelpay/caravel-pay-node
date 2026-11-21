import { CaravelUnexpectedResponseError } from './errors.js';
import { FX_RATE, MAX_FX_BUFFER_BPS, currencyDecimals, isSupportedCurrency } from './currency.js';

export const STATUSES = Object.freeze(['awaiting_payment', 'confirming', 'paid', 'underpaid', 'expired', 'review']);
export const CHECKOUT_ID = /^chk_[A-Za-z0-9_-]{4,128}$/;
const AMOUNT = /^[0-9]{1,13}\.[0-9]{2}$/;
/** `amount` in the checkout's own currency: two decimals, or none (JPY, KRW). */
const OWN_AMOUNT = /^[0-9]{1,13}(?:\.[0-9]{2})?$/;
const TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
/** Who pays the fees: seller (the default), split (the buyer covers the card provider's fee) or buyer (both fees). */
export const FEE_MODES = Object.freeze(['seller', 'split', 'buyer']);

const fail = what => { throw new CaravelUnexpectedResponseError(`Caravel Pay returned a checkout with ${what}.`); };

function assertPayout(payout) {
  if (!payout || typeof payout !== 'object'
    || typeof payout.amount !== 'string' || !/^[0-9]{1,30}(?:\.[0-9]{1,18})?$/.test(payout.amount)
    || typeof payout.asset !== 'string' || !/^[A-Za-z][A-Za-z0-9.]{0,15}$/.test(payout.asset)
    || typeof payout.tx_hash !== 'string' || !TX_HASH.test(payout.tx_hash)) fail('a malformed payout');
}

/**
 * Validate a checkout object; unknown fields are kept. Throws CaravelUnexpectedResponseError.
 * @param {unknown} value
 * @param {string} [expectedId]
 */
export function validateCheckout(value, expectedId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CaravelUnexpectedResponseError('Caravel Pay returned something other than a checkout object.');
  if (typeof value.id !== 'string' || !CHECKOUT_ID.test(value.id) || (expectedId !== undefined && value.id !== expectedId)) fail('an unexpected id');
  if (!STATUSES.includes(value.status)) fail('an unknown status');
  const currency = typeof value.currency === 'string' ? value.currency : '';
  if (typeof value.amount !== 'string' || !/^[A-Z]{3}$/.test(currency) || !(currency === 'USD' ? AMOUNT : OWN_AMOUNT).test(value.amount)
    || (isSupportedCurrency(currency) && (currencyDecimals(currency) === 0) !== !value.amount.includes('.'))) fail('a malformed amount or currency');
  // Another currency: the order total in US dollars and the rate are fixed with the checkout and always present.
  // A US dollar checkout carries neither.
  const converted = currency !== 'USD';
  if (converted !== (value.usd_amount != null) || converted !== (value.fx_rate != null)
    || (converted && (typeof value.usd_amount !== 'string' || !AMOUNT.test(value.usd_amount) || typeof value.fx_rate !== 'string' || !FX_RATE.test(value.fx_rate)))
    || (value.fx_buffer_bps != null && (!converted || !Number.isInteger(value.fx_buffer_bps) || value.fx_buffer_bps < 1 || value.fx_buffer_bps > MAX_FX_BUFFER_BPS))) fail('malformed conversion fields');
  for (const field of ['checkout_url', 'order_id']) if (value[field] != null && typeof value[field] !== 'string') fail(`a malformed ${field}`);
  for (const field of ['expires_at', 'created_at']) if (value[field] != null && (typeof value[field] !== 'string' || !TIME.test(value[field]))) fail(`a malformed ${field}`);
  if (value.paid_amount != null && (typeof value.paid_amount !== 'string' || !AMOUNT.test(value.paid_amount))) fail('a malformed paid_amount');
  // Present only when the buyer pays a fee. ("seller" is accepted too, should the API ever name it.)
  if (value.fee_mode != null && !FEE_MODES.includes(value.fee_mode)) fail('an unknown fee_mode');
  if (value.buyer_total_estimate != null && (typeof value.buyer_total_estimate !== 'string' || !AMOUNT.test(value.buyer_total_estimate))) fail('a malformed buyer_total_estimate');
  if (value.payout != null) assertPayout(value.payout);
  if (value.payouts != null) {
    if (!Array.isArray(value.payouts)) fail('malformed payouts');
    value.payouts.forEach(assertPayout);
  }
  return value;
}

/** True when the full amount arrived and both payout transfers confirmed. */
export const isPaid = checkout => checkout?.status === 'paid';

/**
 * The order total in US dollars: `usd_amount` for a checkout priced in another currency (fixed when it was created),
 * `amount` for a US dollar checkout. `paid_amount`, `buyer_total_estimate` and the payout are US dollars or tokens:
 * compare them with this, never with `amount`.
 */
export function usdAmount(checkout) {
  const value = checkout?.usd_amount ?? (checkout?.currency === 'USD' ? checkout.amount : null);
  return typeof value === 'string' && AMOUNT.test(value) ? value : null;
}

/** US dollars for one unit of the checkout's currency when it was created; null for a US dollar checkout. */
export const fxRate = checkout => (typeof checkout?.fx_rate === 'string' && FX_RATE.test(checkout.fx_rate) ? checkout.fx_rate : null);

/** Who pays the fees for this checkout: "seller" when the object has no fee_mode, else "split" or "buyer". */
export const feeMode = checkout => (checkout?.fee_mode === 'split' || checkout?.fee_mode === 'buyer' ? checkout.fee_mode : 'seller');

/**
 * What the buyer is asked to pay before the card provider's own fee (split: the amount; buyer: the amount plus
 * the 2% Caravel fee). null for a seller checkout.
 */
export function buyerTotalEstimate(checkout) {
  const value = checkout?.buyer_total_estimate;
  return typeof value === 'string' && AMOUNT.test(value) ? value : null;
}

/** A saved setting as a mode: anything that isn't split or buyer is the default, seller. */
export const normalizeFeeMode = value => (value === 'split' || value === 'buyer' ? value : 'seller');

/** Labels for a "Who pays the fees" setting, in display order. */
export const FEE_MODE_LABELS = Object.freeze({
  seller: 'Seller pays everything (default)',
  split: 'Split: buyer pays the card fee',
  buyer: 'Buyer pays everything',
});

/** One line for buyers before they pay, or '' when the seller pays everything. */
export function feeModeNotice(mode) {
  const normalized = normalizeFeeMode(mode);
  if (normalized === 'split') return 'The card provider adds its fee to your total at payment. You see it before you pay.';
  if (normalized === 'buyer') return "A processing fee and the card provider's fee are added to your total at payment. You see them before you pay.";
  return '';
}

/** The payout transaction hash, lowercase, or null. */
export function txHash(checkout) {
  const hash = checkout?.payout?.tx_hash;
  return typeof hash === 'string' && TX_HASH.test(hash) ? hash.toLowerCase() : null;
}

/** Every payout transfer, oldest first. */
export function payouts(checkout) {
  if (Array.isArray(checkout?.payouts) && checkout.payouts.length > 1) return [...checkout.payouts];
  return checkout?.payout && typeof checkout.payout === 'object' ? [checkout.payout] : [];
}

/** A Polygonscan link for a transaction hash, or ''. */
export function explorerUrl(hash, prefix = 'https://polygonscan.com/tx/') {
  return typeof hash === 'string' && TX_HASH.test(hash) ? prefix + hash.toLowerCase() : '';
}
