import { CaravelApiError, CaravelNetworkError, CaravelUnexpectedResponseError } from './errors.js';
import { CHECKOUT_ID, FEE_MODES, feeMode, validateCheckout } from './checkout.js';
import { FX_RATE, MAX_FX_BUFFER_BPS } from './currency.js';
import { signatureHeaders } from './signature.js';

export const VERSION = '1.2.1';
export const DEFAULT_API_BASE = 'https://api.caravelpay.app';
const MAX_RESPONSE_BYTES = 1048576;
const MAX_RETRY_WAIT_MS = 10000;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const OPTIONS = new Set(['merchantId', 'secret', 'apiBase', 'timeoutMs', 'maxRetries', 'userAgent', 'fetch', 'now', 'sleep']);
const CONNECT_FIELDS = ['site_url', 'payout_address', 'email', 'platform', 'plugin_version', 'fee_mode'];
const CHECKOUT_FIELDS = ['order_id', 'amount', 'currency', 'customer_email', 'return_url', 'cancel_url', 'callback_url', 'fee_mode', 'fx_buffer_bps'];
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,128}$/;
const LINK_FIELDS = ['amount', 'min_amount', 'max_amount', 'currency', 'description', 'reusable', 'return_url', 'callback_url', 'fee_mode'];

/** fee_mode, when given, must be one of the three modes (who pays the fees). */
function assertFeeMode(params) {
  const mode = params?.fee_mode;
  if (mode !== undefined && mode !== null && !FEE_MODES.includes(mode)) throw new TypeError('fee_mode must be "seller", "split" or "buyer".');
}
const LINK_ID = /^lnk_[A-Za-z0-9]{8,64}$/;

function paymentLinkBody(params, allowed) {
  onlyFields(params, allowed, 'payment link');
  assertFeeMode(params);
  const input = { currency: 'USD', ...params };
  const body = {};
  for (const field of allowed) {
    if (!(field in input)) continue;
    const value = input[field];
    if (field === 'reusable') {
      if (typeof value !== 'boolean') throw new TypeError('reusable must be true or false.');
    } else if (field === 'amount') {
      if (value !== null && typeof value !== 'string') throw new TypeError('amount must be a string with two decimals, like "25.00", or null to let the buyer choose.');
    } else if (value === null || value === undefined) {
      continue;
    } else if (typeof value !== 'string') {
      throw new TypeError(`${field} must be a string.`);
    }
    body[field] = value;
  }
  if (!('amount' in body)) throw new TypeError('amount is required: a string like "25.00", or null to let the buyer choose.');
  return body;
}

function paymentLink(link, full, expectedId) {
  if (!link || typeof link.id !== 'string' || !LINK_ID.test(link.id) || (expectedId !== undefined && link.id !== expectedId)
    || typeof link.url !== 'string' || !/^https?:\/\//i.test(link.url) || (full && typeof link.status !== 'string')) {
    throw new CaravelUnexpectedResponseError('Caravel Pay returned an unexpected payment link.');
  }
  return link;
}

function assertLinkId(id) {
  if (typeof id !== 'string' || !LINK_ID.test(id)) throw new TypeError('The payment link id must look like lnk_M5TW3NHJ6DK7Q2ZX4PRB.');
}

function onlyFields(values, allowed, what) {
  for (const key of Object.keys(values ?? {})) if (!allowed.includes(key)) throw new TypeError(`Unknown ${what} field "${key}".`);
}

/** An origin: https, or http on localhost; no path, credentials, query or fragment. */
export function validApiBase(base) {
  let url;
  try { url = new URL(base); } catch { return false; }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '') || /[\s\\]/.test(base) || /[?#]/.test(base)) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

function config(options) {
  onlyFields(options, [...OPTIONS], 'option');
  const apiBase = String(options.apiBase ?? DEFAULT_API_BASE).trim().replace(/\/+$/, '');
  if (!validApiBase(apiBase)) throw new TypeError('apiBase must be an https origin such as https://api.caravelpay.app (http only on localhost).');
  let userAgent = `CaravelPay-Node/${VERSION} Node/${process.versions.node}`;
  if (options.userAgent) {
    if (typeof options.userAgent !== 'string' || !/^[\x20-\x7e]{1,100}$/.test(options.userAgent)) throw new TypeError('userAgent must be up to 100 printable ASCII characters.');
    userAgent = `${options.userAgent} ${userAgent}`;
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('No fetch available: use Node 18+ or pass options.fetch.');
  for (const name of ['now', 'sleep']) if (options[name] !== undefined && typeof options[name] !== 'function') throw new TypeError(`${name} must be a function.`);
  return {
    apiBase,
    userAgent,
    fetch: fetchImpl,
    timeoutMs: Math.min(120000, Math.max(1000, Number(options.timeoutMs ?? 15000) || 15000)),
    maxRetries: Math.min(5, Math.max(0, Math.trunc(Number(options.maxRetries ?? 0)) || 0)),
    now: options.now ?? (() => Math.floor(Date.now() / 1000)),
    sleep: options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
  };
}

const backoff = attempt => {
  const base = 250 * 2 ** Math.min(attempt, 5);
  return base + Math.floor(Math.random() * (base / 4 + 1));
};

function encode(body) {
  if (body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0) return '{}';
  return JSON.stringify(body);
}

async function readCapped(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new CaravelNetworkError(`The Caravel Pay response was larger than ${MAX_RESPONSE_BYTES} bytes.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function send(cfg, method, path, body, extraHeaders, credentials, retryable) {
  method = String(method).toUpperCase();
  if (method !== 'GET' && method !== 'POST') throw new TypeError('Only GET and POST are supported.');
  if (typeof path !== 'string' || !/^\/v1\/[\x21-\x7e]*$/.test(path) || path.includes('#') || path.includes('..')) {
    throw new TypeError('The path must start with /v1/ and contain printable ASCII only.');
  }
  for (let attempt = 0; ; attempt++) {
    const headers = { Accept: 'application/json', 'User-Agent': cfg.userAgent };
    if (body !== '') headers['Content-Type'] = 'application/json';
    if (credentials) Object.assign(headers, signatureHeaders(credentials[0], credentials[1], method, path, body, cfg.now()));
    Object.assign(headers, extraHeaders);
    let response;
    let raw;
    try {
      response = await cfg.fetch(cfg.apiBase + path, {
        method, headers, body: body === '' ? undefined : body, redirect: 'manual', signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      raw = await readCapped(response);
    } catch (error) {
      const failure = error instanceof CaravelNetworkError ? error : new CaravelNetworkError(`Caravel Pay could not be reached (${error?.name ?? 'Error'}: ${error?.message ?? error}).`, { cause: error });
      if (retryable && attempt < cfg.maxRetries) { await cfg.sleep(backoff(attempt)); continue; }
      throw failure;
    }
    let decoded = null;
    if (/^\s*\{/.test(raw)) { try { decoded = JSON.parse(raw); } catch { decoded = null; } }
    if (response.status >= 200 && response.status < 300) {
      if (!decoded || typeof decoded !== 'object') throw new CaravelUnexpectedResponseError(`Caravel Pay returned HTTP ${response.status} without a JSON object.`);
      return decoded;
    }
    const error = CaravelApiError.fromResponse(response.status, decoded, response.headers.get('retry-after'));
    if (retryable && attempt < cfg.maxRetries && RETRY_STATUSES.has(response.status)) {
      const wait = error.retryAfter !== null ? error.retryAfter * 1000 : backoff(attempt);
      if (wait <= MAX_RETRY_WAIT_MS) { await cfg.sleep(wait); continue; }
    }
    throw error;
  }
}

function idempotencyHeader(options) {
  onlyFields(options, ['idempotencyKey'], 'option');
  if (options?.idempotencyKey === undefined) return {};
  if (typeof options.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(options.idempotencyKey)) throw new TypeError('idempotencyKey must be 8 to 128 printable ASCII characters.');
  return { 'Idempotency-Key': options.idempotencyKey };
}

/**
 * Caravel Pay API client. Every request except connect is signed.
 *
 *   const caravel = new Caravel({ merchantId: 'mch_…', secret: process.env.CARAVEL_SECRET });
 */
export class Caravel {
  static VERSION = VERSION;
  #merchantId;
  #secret;
  #cfg;

  /**
   * @param {object} options merchantId, secret, apiBase, timeoutMs (15000), maxRetries (0; retries GETs and
   *   createCheckout on network errors, 429 and 5xx), userAgent (product token put first), fetch, now, sleep.
   */
  constructor(options = {}) {
    const { merchantId, secret } = options;
    if (typeof merchantId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(merchantId)) throw new TypeError('merchantId must look like mch_7Q2KZX4PRB.');
    if (typeof secret !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(secret)) throw new TypeError('secret must be the one POST /v1/connect returned.');
    this.#merchantId = merchantId;
    this.#secret = secret;
    this.#cfg = config(options);
  }

  /**
   * POST /v1/connect (unsigned): create a merchant. Every call creates a NEW merchant; never retried.
   * @returns {Promise<{merchant_id: string, secret: string, status: string, fee_rate: string}>}
   */
  static async connect(params, options = {}) {
    onlyFields(params, CONNECT_FIELDS, 'connect');
    assertFeeMode(params);
    const input = { platform: 'api', ...params };
    const body = {};
    for (const field of CONNECT_FIELDS) {
      if (input[field] === undefined || input[field] === null) continue;
      if (typeof input[field] !== 'string') throw new TypeError(`${field} must be a string.`);
      body[field] = input[field];
    }
    for (const field of ['site_url', 'payout_address']) if (!body[field]) throw new TypeError(`${field} is required.`);
    const result = await send(config(options), 'POST', '/v1/connect', encode(body), {}, null, false);
    if (typeof result.merchant_id !== 'string' || !/^mch_[A-Za-z0-9]{4,60}$/.test(result.merchant_id)
      || typeof result.secret !== 'string' || !/^[\x21-\x7e]{16,256}$/.test(result.secret)
      || typeof result.status !== 'string' || typeof result.fee_rate !== 'string') {
      throw new CaravelUnexpectedResponseError('Caravel Pay returned an unexpected connect response.');
    }
    return { merchant_id: result.merchant_id, secret: result.secret, status: result.status, fee_rate: result.fee_rate };
  }

  get merchantId() { return this.#merchantId; }
  get apiBase() { return this.#cfg.apiBase; }

  #call(method, path, body, headers, retryable) {
    return send(this.#cfg, method, path, body, headers, [this.#merchantId, this.#secret], retryable);
  }

  /**
   * POST /v1/checkouts. The same order_id with the same details returns the same checkout.
   * fee_mode ("seller", "split" or "buyer") says who pays the fees; without it your merchant default applies.
   * currency may be your store's own (see CURRENCIES): the amount is then in that currency's decimals ("45.00" for
   * EUR, "5000" for JPY) and is converted to US dollars now; the answer keeps your amount and currency and adds
   * usd_amount and fx_rate. fx_buffer_bps (an integer, 0 to 500) is your margin on the converted amount.
   */
  async createCheckout(params, options = {}) {
    onlyFields(params, CHECKOUT_FIELDS, 'checkout');
    assertFeeMode(params);
    const input = { currency: 'USD', ...params };
    if (Number.isInteger(input.order_id)) input.order_id = String(input.order_id);
    if (input.amount !== undefined && typeof input.amount !== 'string') throw new TypeError('amount must be a string with two decimals, like "136.41". normalizeAmount() converts platform totals.');
    const body = {};
    for (const field of CHECKOUT_FIELDS) {
      if (input[field] === undefined || input[field] === null) continue;
      if (field === 'fx_buffer_bps') {
        // Your margin on a converted amount. 0 is the default and is not sent, so a request without one is unchanged.
        if (!Number.isInteger(input[field]) || input[field] < 0 || input[field] > MAX_FX_BUFFER_BPS) throw new TypeError(`fx_buffer_bps must be an integer from 0 to ${MAX_FX_BUFFER_BPS} (100 is 1%).`);
        if (input[field] !== 0) {
          if (input.currency === 'USD') throw new TypeError('fx_buffer_bps only applies to a currency other than USD.');
          body[field] = input[field];
        }
        continue;
      }
      if (typeof input[field] !== 'string') throw new TypeError(`${field} must be a string.`);
      body[field] = input[field];
    }
    const checkout = validateCheckout(await this.#call('POST', '/v1/checkouts', encode(body), idempotencyHeader(options), true));
    if (typeof checkout.checkout_url !== 'string' || !/^https?:\/\//i.test(checkout.checkout_url)) throw new CaravelUnexpectedResponseError('Caravel Pay returned a checkout without a checkout_url.');
    // A request that names a mode must be answered in that mode: never redirect a buyer to a checkout
    // that charges fees differently from what was asked.
    if (body.fee_mode !== undefined && feeMode(checkout) !== body.fee_mode) throw new CaravelUnexpectedResponseError('Caravel Pay returned a checkout with another fee_mode than requested.');
    // The same goes for the price: the answer must be for the amount and currency that were sent.
    if (body.amount !== undefined && (checkout.amount !== body.amount || checkout.currency !== body.currency)) throw new CaravelUnexpectedResponseError('Caravel Pay returned a checkout for another amount or currency than requested.');
    return checkout;
  }

  /**
   * GET /v1/fx-quote: today's indicative conversion of another currency to US dollars, for telling a buyer what they
   * will be charged before you redirect them. Not a promise: the rate of a checkout is fixed when it is created.
   * Cache the rate for a few minutes (estimateUsd() applies it to an amount) instead of calling this per page view.
   * @param {string} currency A supported currency other than USD.
   * @param {{ amount?: string, bufferBps?: number }} [options] An amount adds usd_amount to the answer.
   */
  async fxQuote(currency, { amount, bufferBps = 0, ...rest } = {}) {
    onlyFields(rest, [], 'quote');
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) || currency === 'USD') throw new TypeError('currency must be a three-letter code other than USD, like "EUR".');
    if (!Number.isInteger(bufferBps) || bufferBps < 0 || bufferBps > MAX_FX_BUFFER_BPS || (bufferBps !== 0 && amount === undefined)) throw new TypeError(`bufferBps must be 0 to ${MAX_FX_BUFFER_BPS}, and needs an amount.`);
    if (amount !== undefined && (typeof amount !== 'string' || !/^[0-9]{1,12}(?:\.[0-9]{2})?$/.test(amount))) throw new TypeError('amount must be a string in the currency\'s own decimals, like "45.00" or "5000". formatAmount() converts platform totals.');
    const query = new URLSearchParams({ currency, ...(amount !== undefined ? { amount } : {}), ...(bufferBps !== 0 ? { fx_buffer_bps: String(bufferBps) } : {}) });
    const quote = await this.#call('GET', `/v1/fx-quote?${query}`, '', {}, true);
    if (!quote || quote.currency !== currency || typeof quote.fx_rate !== 'string' || !FX_RATE.test(quote.fx_rate)
      || (amount !== undefined && (typeof quote.usd_amount !== 'string' || !/^[0-9]{1,13}\.[0-9]{2}$/.test(quote.usd_amount)))) throw new CaravelUnexpectedResponseError('Caravel Pay returned an unexpected exchange-rate quote.');
    return quote;
  }

  /** GET /v1/checkouts/{id}: the current status. Use this, not the webhook body, before marking paid. */
  async getCheckout(id) {
    if (typeof id !== 'string' || !CHECKOUT_ID.test(id)) throw new TypeError('The checkout id must look like chk_8Qe2TnV4kR.');
    return validateCheckout(await this.#call('GET', `/v1/checkouts/${id}`, '', {}, true), id);
  }

  /** GET /v1/checkouts: one page, newest first. */
  async listCheckouts({ limit, cursor, ...rest } = {}) {
    onlyFields(rest, [], 'list');
    const query = new URLSearchParams();
    if (limit !== undefined) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('limit must be an integer from 1 to 100.');
      query.set('limit', String(limit));
    }
    if (cursor !== undefined && cursor !== null) {
      if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) throw new TypeError('cursor must be a next_cursor from a previous page.');
      query.set('cursor', cursor);
    }
    const qs = query.toString();
    const page = await this.#call('GET', `/v1/checkouts${qs ? `?${qs}` : ''}`, '', {}, true);
    if (!Array.isArray(page.data) || !('next_cursor' in page) || (page.next_cursor !== null && typeof page.next_cursor !== 'string')) {
      throw new CaravelUnexpectedResponseError('Caravel Pay returned an unexpected checkout list.');
    }
    return { data: page.data.map(item => validateCheckout(item)), next_cursor: page.next_cursor };
  }

  /** Every checkout, newest first, fetching pages as you iterate. */
  async *allCheckouts({ limit = 100 } = {}) {
    let cursor = null;
    do {
      const page = await this.listCheckouts(cursor ? { limit, cursor } : { limit });
      yield* page.data;
      cursor = page.next_cursor;
    } while (cursor);
  }

  /** GET /v1/merchant: site, origins, payout wallet, status and fee rate. */
  async getMerchant() {
    const merchant = await this.#call('GET', '/v1/merchant', '', {}, true);
    if (typeof merchant.id !== 'string' || typeof merchant.status !== 'string' || !Array.isArray(merchant.origins)) {
      throw new CaravelUnexpectedResponseError('Caravel Pay returned an unexpected merchant object.');
    }
    return merchant;
  }

  /** POST /v1/payment-links, signed: a link paying out to this merchant's wallet. Never retried (each call creates one). */
  async createPaymentLink(params) {
    const body = paymentLinkBody(params, LINK_FIELDS);
    return paymentLink(await this.#call('POST', '/v1/payment-links', encode(body), {}, false), true);
  }

  /** POST /v1/payment-links without API keys: needs payout_address; returns only { id, url }; no webhooks. Never retried. */
  static async createPaymentLinkWithoutKeys(params, options = {}) {
    const body = paymentLinkBody(params, ['payout_address', ...LINK_FIELDS.filter(f => f !== 'return_url' && f !== 'callback_url')]);
    if (typeof body.payout_address !== 'string' || !body.payout_address) throw new TypeError('payout_address is required without API keys.');
    const link = paymentLink(await send(config(options), 'POST', '/v1/payment-links', encode(body), {}, null, false), false);
    return { id: link.id, url: link.url };
  }

  /** GET /v1/payment-links/{id}. */
  async getPaymentLink(id) {
    assertLinkId(id);
    return paymentLink(await this.#call('GET', `/v1/payment-links/${id}`, '', {}, true), true, id);
  }

  /** POST /v1/payment-links/{id}/deactivate (idempotent, so retried per maxRetries). */
  async deactivatePaymentLink(id) {
    assertLinkId(id);
    return paymentLink(await this.#call('POST', `/v1/payment-links/${id}/deactivate`, '{}', {}, true), true, id);
  }

  /** Any signed call, for endpoints this version doesn't wrap. GETs follow maxRetries; POSTs aren't retried. */
  async request(method, path, body = null) {
    const verb = String(method).toUpperCase();
    return this.#call(verb, path, body === null || body === undefined ? '' : encode(body), {}, verb === 'GET');
  }
}

/** POST /v1/connect; see Caravel.connect. */
export const connect = (params, options) => Caravel.connect(params, options);
