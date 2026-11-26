// Type definitions for caravel-pay 1.1.0

export declare const VERSION: string;
export declare const DEFAULT_API_BASE: string;
export declare const TOLERANCE: number;
export declare const MAX_WEBHOOK_BODY: number;
export declare const WEBHOOK_USER_AGENT: 'CaravelPay-Webhooks/1';

export type CheckoutStatus = 'awaiting_payment' | 'confirming' | 'paid' | 'underpaid' | 'expired' | 'review';
export type EventType = 'checkout.paid' | 'checkout.underpaid' | 'checkout.expired' | 'checkout.review';
export type MerchantStatus = 'active' | 'pending_review' | 'paused';
export declare const STATUSES: readonly CheckoutStatus[];
export declare const EVENT_TYPES: readonly EventType[];
export declare const CHECKOUT_ID: RegExp;
/**
 * Who pays the fees. seller (default): you absorb the card provider's fee and the 2% Caravel fee. split: the card
 * provider's fee is added to the buyer's total. buyer: the 2% Caravel fee is added too, so you receive the full amount.
 */
export type FeeMode = 'seller' | 'split' | 'buyer';
export declare const FEE_MODES: readonly FeeMode[];
export declare const FEE_MODE_LABELS: Readonly<Record<FeeMode, string>>;

export interface Payout {
  /** Amount of `asset` sent to your wallet. */
  amount: string;
  asset: 'USDC' | 'USDC.e' | 'POL' | 'PYUSD' | 'USDT' | 'ETH' | (string & {});
  /** Transaction hash of the transfer to your wallet. */
  tx_hash: string;
}

/** A currency a checkout can be priced in. Anything but USD is converted to US dollars when the checkout is created. */
export type Currency = 'USD' | 'EUR' | 'GBP' | 'CAD' | 'AUD' | 'NZD' | 'SEK' | 'NOK' | 'DKK' | 'CHF' | 'PLN' | 'CZK' | 'HUF' | 'RON' | 'HKD' | 'SGD' | 'MXN' | 'BRL' | 'ZAR'
  | 'ILS' | 'INR' | 'THB' | 'MYR' | 'PHP' | 'TRY' | 'JPY' | 'KRW' | (string & {});
/** Supported currencies and their decimals (2, or 0 for JPY and KRW). */
export declare const CURRENCIES: Readonly<Record<string, 0 | 2>>;
export declare const MAX_FX_BUFFER_BPS: 500;

/** GET /v1/fx-quote response: an indicative conversion. */
export interface FxQuote {
  currency: Currency;
  /** Present when you asked about an amount. */
  amount?: string;
  /** US dollars for one unit of `currency` right now. */
  fx_rate: string;
  /** With amount: what it is in US dollars at fx_rate (including your margin, if any). */
  usd_amount?: string;
  fx_buffer_bps?: number;
  quoted_at: string;
}

/** POST /v1/checkouts response. */
export interface CheckoutCreated {
  id: string;
  checkout_url: string;
  status: CheckoutStatus;
  /** Always your own order total, in every fee mode, in your own `currency`. */
  amount: string;
  /** As you sent it: "USD", or the currency your store prices in. */
  currency: Currency;
  expires_at: string;
  /** Only when `currency` isn't USD: your order total in US dollars, fixed when the checkout was created. */
  usd_amount?: string;
  /** With usd_amount: US dollars for one unit of `currency` when the checkout was created, 8 significant digits. */
  fx_rate?: string;
  /** Only when you sent a margin above 0 for this checkout. */
  fx_buffer_bps?: number;
  /** Present only when the buyer pays a fee. A seller checkout has no fee_mode. */
  fee_mode?: 'split' | 'buyer';
  /** With fee_mode: what the buyer pays before the card provider's own fee ("102.04" for a 100.00 buyer-mode checkout). */
  buyer_total_estimate?: string;
}

/** GET /v1/checkouts/{id}, list items and webhook `data`. */
export interface Checkout extends CheckoutCreated {
  order_id: string;
  created_at: string;
  paid_amount: string;
  payout?: Payout;
  payouts?: Payout[];
  [field: string]: unknown;
}

export interface CheckoutList {
  data: Checkout[];
  next_cursor: string | null;
}

export interface Merchant {
  id: string;
  site_url: string;
  origins: string[];
  payout_address: string | null;
  status: MerchantStatus;
  fee_rate: string;
  /** Your default for who pays the fees on new checkouts. */
  fee_mode?: FeeMode;
  paused_reason?: string | null;
  [field: string]: unknown;
}

export interface ConnectParams {
  /** Your site's HTTPS address; return, cancel and callback URLs must be on it. */
  site_url: string;
  /** The Polygon wallet that receives payouts. */
  payout_address: string;
  email?: string;
  /** Defaults to "api". */
  platform?: 'api' | 'woocommerce';
  plugin_version?: string;
  /** Your default for who pays the fees on new checkouts. Defaults to "seller". */
  fee_mode?: FeeMode;
}

export interface ConnectResult {
  merchant_id: string;
  /** Shown only once. Store it on your server. */
  secret: string;
  status: MerchantStatus;
  fee_rate: string;
}

export interface CreateCheckoutParams {
  order_id: string | number;
  /** In the currency's own decimals: two for most ("136.41"), none for JPY and KRW ("5000"). formatAmount() does it. */
  amount: string;
  /** Defaults to "USD". Another supported currency is converted to US dollars when the checkout is created. */
  currency?: Currency;
  /** Your margin on the converted amount, 0 to 500 basis points (100 is 1%). Only with a currency other than USD. */
  fx_buffer_bps?: number;
  customer_email?: string;
  return_url: string;
  cancel_url: string;
  callback_url: string;
  /** Who pays the fees for this checkout. Without it your merchant default applies. */
  fee_mode?: FeeMode;
}

export interface ClientOptions {
  /** Default https://api.caravelpay.app; http:// only for localhost. */
  apiBase?: string;
  /** Default 15000. */
  timeoutMs?: number;
  /** Default 0. Retries GETs and createCheckout on network errors, 429 and 5xx. */
  maxRetries?: number;
  /** A product token put before the SDK's, like "MyShop/2.1". */
  userAgent?: string;
  fetch?: typeof globalThis.fetch;
  /** Unix seconds (tests). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CaravelOptions extends ClientOptions {
  merchantId: string;
  secret: string;
}

export interface IdempotencyOptions {
  /** Optional Idempotency-Key header, 8 to 128 printable ASCII characters. */
  idempotencyKey?: string;
}

export declare class Caravel {
  static readonly VERSION: string;
  /** POST /v1/connect (unsigned). Every call creates a NEW merchant; never retried. */
  static connect(params: ConnectParams, options?: ClientOptions): Promise<ConnectResult>;
  constructor(options: CaravelOptions);
  readonly merchantId: string;
  readonly apiBase: string;
  createCheckout(params: CreateCheckoutParams, options?: IdempotencyOptions): Promise<CheckoutCreated>;
  getCheckout(id: string): Promise<Checkout>;
  listCheckouts(params?: { limit?: number; cursor?: string | null }): Promise<CheckoutList>;
  allCheckouts(params?: { limit?: number }): AsyncGenerator<Checkout, void, undefined>;
  getMerchant(): Promise<Merchant>;
  /** GET /v1/fx-quote: today's indicative conversion to US dollars. Not a promise: a checkout's rate is fixed when it is created. */
  fxQuote(currency: Currency, options?: { amount?: string; bufferBps?: number }): Promise<FxQuote>;
  /** POST /v1/payment-links, signed. Never retried. */
  createPaymentLink(params: CreatePaymentLinkParams): Promise<PaymentLink>;
  /** POST /v1/payment-links without API keys. Never retried. */
  static createPaymentLinkWithoutKeys(params: CreatePaymentLinkParams & { payout_address: string }, options?: ClientOptions): Promise<{ id: string; url: string }>;
  getPaymentLink(id: string): Promise<PaymentLink>;
  deactivatePaymentLink(id: string): Promise<PaymentLink>;
  request(method: 'GET' | 'POST', path: string, body?: Record<string, unknown> | null): Promise<Record<string, unknown>>;
}

export interface CreatePaymentLinkParams {
  /** "25.00", or null to let the buyer choose between min_amount and max_amount. */
  amount: string | null;
  /** Only with a null amount. Required in a currency other than USD. */
  min_amount?: string;
  /** Only with a null amount. Required in a currency other than USD. */
  max_amount?: string;
  /** Defaults to "USD". A link in another currency is converted for each checkout, at the moment the buyer continues. */
  currency?: Currency;
  /** Plain text, up to 80 characters, shown as "Note from the seller". */
  description?: string;
  /** Default true. false closes the link after one paid checkout. */
  reusable?: boolean;
  /** Signed links only. */
  return_url?: string;
  /** Signed links only. */
  callback_url?: string;
  /** Who pays the fees for this link's checkouts. Without it the link follows its merchant's default. */
  fee_mode?: FeeMode;
}

export interface PaymentLink {
  id: string;
  url: string;
  status: 'active' | 'completed' | 'deactivated';
  amount: string | null;
  min_amount: string | null;
  max_amount: string | null;
  currency: Currency;
  description: string | null;
  reusable: boolean;
  return_url: string | null;
  callback_url: string | null;
  payments_count: number;
  checkouts_count: number;
  created_at: string;
  deactivated_at: string | null;
  [field: string]: unknown;
}

export declare function connect(params: ConnectParams, options?: ClientOptions): Promise<ConnectResult>;
export declare function validApiBase(base: string): boolean;

export type SecretSource = string | Record<string, string> | ((merchantId: string) => string | null | undefined);
export type HeadersInput = Headers | Record<string, string | string[] | undefined>;

export interface WebhookEvent {
  id: string;
  type: EventType | (string & {});
  created: string;
  data: Checkout;
  /** The merchant id that signed it (Caravel-Merchant). */
  merchantId: string;
  /** True for the four checkout.* types this SDK version knows. */
  known: boolean;
}

export declare function verifyWebhook(input: {
  body: string | Uint8Array;
  headers: HeadersInput;
  secret: SecretSource;
  callbackUrl: string | string[];
  tolerance?: number;
  now?: number;
  merchantId?: string;
}): WebhookEvent;

export declare function signTestEvent(input: {
  merchantId: string;
  secret: string;
  callbackUrl: string;
  body: string | Uint8Array;
  timestamp?: number;
}): Record<string, string>;

export declare function stringToSign(timestamp: string, method: string, path: string, body: string | Uint8Array): string;
export declare function computeSignature(secret: string, timestamp: string, method: string, path: string, body?: string | Uint8Array): string;
export declare function signatureHeaders(merchantId: string, secret: string, method: string, path: string, body?: string | Uint8Array, timestamp?: number): {
  'Caravel-Merchant': string;
  'Caravel-Timestamp': string;
  'Caravel-Signature': string;
};
export declare function signatureMatches(signature: string, secret: string, timestamp: string, method: string, path: string, body?: string | Uint8Array): boolean;
export declare function isFresh(timestamp: string, now?: number, tolerance?: number): boolean;
export declare function signedPath(url: string): string;

export declare function validateCheckout(value: unknown, expectedId?: string): Checkout;
export declare function isPaid(checkout: Partial<Checkout> | null | undefined): boolean;
export declare function txHash(checkout: Partial<Checkout> | null | undefined): string | null;
export declare function payouts(checkout: Partial<Checkout> | null | undefined): Payout[];
export declare function explorerUrl(hash: string | null | undefined, prefix?: string | null, asset?: string | null): string;
/** "seller" when the checkout has no fee_mode. */
export declare function feeMode(checkout: Partial<CheckoutCreated> | null | undefined): FeeMode;
export declare function buyerTotalEstimate(checkout: Partial<CheckoutCreated> | null | undefined): string | null;
/** A saved setting as a mode: anything that isn't split or buyer is "seller". */
export declare function normalizeFeeMode(value: unknown): FeeMode;
/** One line for buyers before they pay, or '' for seller. */
export declare function feeModeNotice(mode: unknown): string;

/** The order total in US dollars: usd_amount, or amount for a US dollar checkout. Compare paid_amount with this. */
export declare function usdAmount(checkout: Partial<CheckoutCreated> | null | undefined): string | null;
/** US dollars for one unit of the checkout's currency when it was created; null for a US dollar checkout. */
export declare function fxRate(checkout: Partial<CheckoutCreated> | null | undefined): string | null;
export declare function isSupportedCurrency(code: unknown): boolean;
export declare function currencyDecimals(code: string): 0 | 2;
/** A platform total in the currency's own decimals: "49.90" for EUR, "5000" for JPY. */
export declare function formatAmount(amount: string | number, currency?: string): string;
/** A percentage setting ("1.5") as whole basis points (150), 0 to 500. */
export declare function fxBufferBps(percent: unknown): number;
/** About what an amount is in US dollars at a rate from fxQuote(); null when the inputs don't make an amount. */
export declare function estimateUsd(amount: string | number, rate: string, bufferBps?: number): string | null;
/** One line for buyers before they are redirected, or '' for a US dollar store. */
export declare function fxNotice(currency: string, usdEstimate?: string | null): string;

export declare function normalizeAmount(amount: string | number): string;
export declare function toCents(amount: string | number): bigint;
export declare function compareAmounts(a: string | number, b: string | number): -1 | 0 | 1;

export declare class CaravelError extends Error {}
export declare class CaravelApiError extends CaravelError {
  readonly status: number;
  readonly code: string;
  readonly param: string | null;
  readonly retryAfter: number | null;
  readonly retryable: boolean;
}
export declare class CaravelNetworkError extends CaravelError {}
export declare class CaravelUnexpectedResponseError extends CaravelError {}
export declare class CaravelSignatureError extends CaravelError {
  static readonly BODY_TOO_LARGE: 'body_too_large';
  static readonly UNKNOWN_MERCHANT: 'unknown_merchant';
  static readonly TIMESTAMP_EXPIRED: 'timestamp_expired';
  static readonly INVALID_SIGNATURE: 'invalid_signature';
  static readonly MALFORMED_EVENT: 'malformed_event';
  readonly reason: 'body_too_large' | 'unknown_merchant' | 'timestamp_expired' | 'invalid_signature' | 'malformed_event';
  /** 400 for a malformed event, otherwise 401. */
  readonly status: 400 | 401;
}
