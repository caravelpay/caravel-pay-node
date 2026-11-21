import { createHmac, timingSafeEqual } from 'node:crypto';

/** Allowed clock difference for signed requests and webhooks, in seconds. */
export const TOLERANCE = 300;

const toBytes = body => (typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body.buffer, body.byteOffset, body.byteLength));

/** The exact string that is signed: `${timestamp}\n${METHOD}\n${path}\n${body}`. */
export function stringToSign(timestamp, method, path, body) {
  return `${timestamp}\n${String(method).toUpperCase()}\n${path}\n${typeof body === 'string' ? body : toBytes(body).toString('utf8')}`;
}

/**
 * Lowercase hex HMAC-SHA256, keyed with the secret as ASCII. `body` may be a string or the raw
 * bytes (Buffer / Uint8Array); bytes are signed exactly as received.
 */
export function computeSignature(secret, timestamp, method, path, body = '') {
  return createHmac('sha256', String(secret))
    .update(`${timestamp}\n${String(method).toUpperCase()}\n${path}\n`, 'utf8')
    .update(toBytes(body))
    .digest('hex');
}

/** The three Caravel-* request headers. */
export function signatureHeaders(merchantId, secret, method, path, body = '', timestamp = Math.floor(Date.now() / 1000)) {
  const ts = String(timestamp);
  return {
    'Caravel-Merchant': merchantId,
    'Caravel-Timestamp': ts,
    'Caravel-Signature': computeSignature(secret, ts, method, path, body),
  };
}

/** Constant-time check of a received signature (64 lowercase hex characters). */
export function signatureMatches(signature, secret, timestamp, method, path, body = '') {
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(computeSignature(secret, timestamp, method, path, body), 'ascii'), Buffer.from(signature, 'ascii'));
}

/** True when `timestamp` is unix seconds within `tolerance` of `now`. */
export function isFresh(timestamp, now = Math.floor(Date.now() / 1000), tolerance = TOLERANCE) {
  return typeof timestamp === 'string' && /^[0-9]{1,12}$/.test(timestamp) && Math.abs(now - Number(timestamp)) <= tolerance;
}

/**
 * The signed path of a URL: pathname plus search (WHATWG URL rules, so an empty query is dropped).
 * A value starting with a single "/" is a path that may carry a query.
 */
export function signedPath(url) {
  if (typeof url !== 'string' || url === '') throw new TypeError('Expected an http(s) URL or a path starting with "/".');
  let parsed;
  if (/^\/(?!\/)/.test(url) || url === '/') parsed = new URL(url, 'https://placeholder.invalid');
  else if (/^https?:\/\//i.test(url)) parsed = new URL(url);
  else throw new TypeError('Expected an http(s) URL or a path starting with "/".');
  return parsed.pathname + parsed.search;
}
