import { timingSafeEqual } from 'node:crypto';
import { CaravelSignatureError } from './errors.js';
import { CHECKOUT_ID } from './checkout.js';
import { TOLERANCE, computeSignature, isFresh, signatureHeaders, signedPath } from './signature.js';

export const MAX_WEBHOOK_BODY = 262144;
export const WEBHOOK_USER_AGENT = 'CaravelPay-Webhooks/1';
export const EVENT_TYPES = Object.freeze(['checkout.paid', 'checkout.underpaid', 'checkout.expired', 'checkout.review']);
const EVENT_ID = /^evt_[A-Za-z0-9_-]{4,128}$/;

function headerReader(headers) {
  if (headers && typeof headers.get === 'function') return name => headers.get(name) ?? '';
  const map = new Map();
  for (const [key, value] of Object.entries(headers ?? {})) {
    const name = key.toLowerCase().replace(/^http_/, '').replace(/_/g, '-');
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string') map.set(name, first.trim());
  }
  return name => map.get(name) ?? '';
}

function resolveSecret(secret, merchant, merchantId) {
  if (typeof secret === 'string') return !merchantId || merchantId === merchant ? secret : '';
  if (typeof secret === 'function') {
    const value = secret(merchant);
    return typeof value === 'string' ? value : '';
  }
  if (secret && typeof secret === 'object') return Object.hasOwn(secret, merchant) && typeof secret[merchant] === 'string' ? secret[merchant] : '';
  throw new TypeError('Pass the secret as a string, a { merchantId: secret } object or a function.');
}

const reject = (reason, message) => { throw new CaravelSignatureError(reason, message); };

/**
 * Verify a webhook from Caravel Pay and return its event.
 *
 * Checks body size, merchant, timestamp (±300 s), then the HMAC over
 * `${timestamp}\nPOST\n${callback path + query}\n${raw body}` in constant time, then the event shape.
 * Afterwards, re-fetch the checkout with getCheckout() before changing an order.
 *
 * @param {object} input
 * @param {string | Uint8Array} input.body The raw request body (express.raw(), not express.json()).
 * @param {Headers | Record<string, string | string[] | undefined>} input.headers
 * @param {string | Record<string, string> | ((merchantId: string) => string | null | undefined)} input.secret
 * @param {string | string[]} input.callbackUrl The callback_url you registered (or its path), or several forms.
 * @param {number} [input.tolerance] Seconds, default 300.
 * @param {number} [input.now] Unix seconds (tests).
 * @param {string} [input.merchantId] With a single secret, require this Caravel-Merchant.
 */
export function verifyWebhook({ body, headers, secret, callbackUrl, tolerance = TOLERANCE, now = Math.floor(Date.now() / 1000), merchantId } = {}) {
  if (typeof body !== 'string' && !(body instanceof Uint8Array)) throw new TypeError('body must be the raw request body (string or Buffer).');
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const urls = Array.isArray(callbackUrl) ? callbackUrl : [callbackUrl];
  if (!urls.length || urls.some(url => typeof url !== 'string' || !url)) throw new TypeError('Pass the callback URL (or its path) that you registered with the checkout.');
  const paths = [...new Set(urls.map(signedPath))];
  const header = headerReader(headers);

  if (bytes.length > MAX_WEBHOOK_BODY) reject(CaravelSignatureError.BODY_TOO_LARGE, 'The webhook body is too large.');
  const merchant = header('caravel-merchant');
  const key = merchant && /^[A-Za-z0-9_-]{1,64}$/.test(merchant) ? resolveSecret(secret, merchant, merchantId) : '';
  if (!key) reject(CaravelSignatureError.UNKNOWN_MERCHANT, 'The webhook is not for a known merchant.');
  const timestamp = header('caravel-timestamp');
  if (!isFresh(timestamp, now, tolerance)) reject(CaravelSignatureError.TIMESTAMP_EXPIRED, 'The webhook timestamp is missing or outside the allowed window.');
  const signature = header('caravel-signature');
  let valid = false;
  if (/^[0-9a-f]{64}$/.test(signature)) {
    const received = Buffer.from(signature, 'ascii');
    for (const path of paths) {
      // Compare every candidate, so timing doesn't reveal which one matched.
      if (timingSafeEqual(Buffer.from(computeSignature(key, timestamp, 'POST', path, bytes), 'ascii'), received)) valid = true;
    }
  }
  if (!valid) reject(CaravelSignatureError.INVALID_SIGNATURE, 'The webhook signature does not match.');

  let event = null;
  try { event = /^\s*\{/.test(bytes.toString('utf8')) ? JSON.parse(bytes.toString('utf8')) : null; } catch { event = null; }
  const headerEvent = header('caravel-event');
  if (!event || typeof event.id !== 'string' || !EVENT_ID.test(event.id) || typeof event.type !== 'string' || !/^[a-z_]{1,32}\.[a-z_]{1,32}$/.test(event.type)
    || !event.data || typeof event.data !== 'object' || Array.isArray(event.data) || typeof event.data.id !== 'string' || !CHECKOUT_ID.test(event.data.id)
    || (headerEvent && headerEvent !== event.id)) {
    reject(CaravelSignatureError.MALFORMED_EVENT, 'The webhook body is not a Caravel Pay event.');
  }
  return {
    id: event.id,
    type: event.type,
    created: typeof event.created === 'string' ? event.created : '',
    data: event.data,
    merchantId: merchant,
    /** True for the four checkout.* types this SDK version knows. */
    known: EVENT_TYPES.includes(event.type),
  };
}

/** Headers (and the path signed) for a test event to your own endpoint: what Caravel Pay sends. */
export function signTestEvent({ merchantId, secret, callbackUrl, body, timestamp = Math.floor(Date.now() / 1000) }) {
  const headers = signatureHeaders(merchantId, secret, 'POST', signedPath(callbackUrl), body, timestamp);
  headers['Content-Type'] = 'application/json';
  headers['User-Agent'] = WEBHOOK_USER_AGENT;
  try {
    const id = JSON.parse(typeof body === 'string' ? body : Buffer.from(body).toString('utf8'))?.id;
    if (typeof id === 'string') headers['Caravel-Event'] = id;
  } catch { /* not JSON: no Caravel-Event */ }
  return headers;
}

