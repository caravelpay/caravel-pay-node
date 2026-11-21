/** Base class of every error the SDK throws for API, network and webhook problems. */
export class CaravelError extends Error {
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
}

const clean = text => {
  const value = String(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return value.length > 300 ? value.slice(0, 300) : value;
};

/**
 * The API answered with a non-2xx status. Branch on `code`; `message` is for humans.
 */
export class CaravelApiError extends CaravelError {
  constructor(message, { status, code, param = null, retryAfter = null }) {
    super(message);
    /** HTTP status, for example 409. */
    this.status = status;
    /** Error code, for example "order_id_conflict". */
    this.code = code;
    /** The field, header or query parameter the error is about, or null. */
    this.param = param;
    /** Seconds to wait before retrying (Retry-After), or null. */
    this.retryAfter = retryAfter;
  }

  /** True for 429 and 5xx: the same request can succeed later. */
  get retryable() {
    return this.status === 429 || this.status >= 500;
  }

  /** @internal */
  static fromResponse(status, decoded, retryAfterHeader) {
    const error = decoded && typeof decoded === 'object' && decoded.error && typeof decoded.error === 'object' ? decoded.error : {};
    const code = typeof error.code === 'string' && /^[a-z0-9_]{1,64}$/.test(error.code) ? error.code : status >= 500 ? 'server_error' : `http_${status}`;
    let message = typeof error.message === 'string' ? clean(error.message) : '';
    if (!message) message = `Caravel Pay returned HTTP ${status} (${code}).`;
    const param = typeof error.param === 'string' && error.param ? clean(error.param) : null;
    let retryAfter = null;
    if (typeof retryAfterHeader === 'string' && /^\s*\d{1,6}\s*$/.test(retryAfterHeader)) retryAfter = Number(retryAfterHeader.trim());
    else if (Number.isInteger(error.retry_after) && error.retry_after >= 0) retryAfter = error.retry_after;
    return new CaravelApiError(message, { status, code, param, retryAfter });
  }
}

/**
 * No HTTP response: DNS, TLS, connection, timeout, or a response over the size limit.
 * Retrying createCheckout with the same order_id is safe.
 */
export class CaravelNetworkError extends CaravelError {
  constructor(message, { cause } = {}) {
    super(message);
    if (cause !== undefined) this.cause = cause;
  }
}

/** A 2xx response whose body is not what the API documents. Treat it as a failed request. */
export class CaravelUnexpectedResponseError extends CaravelError {}

/** A webhook failed verification. Answer with `status` and do nothing else. */
export class CaravelSignatureError extends CaravelError {
  static BODY_TOO_LARGE = 'body_too_large';
  static UNKNOWN_MERCHANT = 'unknown_merchant';
  static TIMESTAMP_EXPIRED = 'timestamp_expired';
  static INVALID_SIGNATURE = 'invalid_signature';
  static MALFORMED_EVENT = 'malformed_event';

  constructor(reason, message) {
    super(message);
    /** body_too_large, unknown_merchant, timestamp_expired, invalid_signature or malformed_event. */
    this.reason = reason;
  }

  /** 400 for a malformed event, otherwise 401. */
  get status() {
    return this.reason === CaravelSignatureError.MALFORMED_EVENT ? 400 : 401;
  }
}
