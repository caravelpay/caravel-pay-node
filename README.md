# Caravel Pay for Node.js

- Docs: <https://caravelpay.app/docs/node-sdk>
- Download and checksums: <https://caravelpay.app/plugins/#node-sdk>
- Status: beta. New: tell us if anything looks off.
- Questions: [hello@caravelpay.app](mailto:hello@caravelpay.app)

`caravel-pay`: hosted card, Apple Pay, Google Pay and crypto checkouts that pay out to your own Polygon wallet, minus the 2% Caravel fee.

Your buyer pays the order total. Most card providers keep their own fee out of it, the Caravel fee is 2% of the order total, and you receive the rest.

- Node 18.17+, ESM, TypeScript types included, **zero dependencies** (built-in `fetch` and `node:crypto`).
- Every request signed for you.
- Webhook verification: constant-time HMAC, ±300 s window, callback path + query.
- Responses validated before you see them.
- Tested against the official signature vectors.

Docs: <https://caravelpay.app/docs/node-sdk> · API reference: <https://caravelpay.app/docs/>

## Install

```sh
npm install caravel-pay
```

The package is ESM. From CommonJS, use `await import('caravel-pay')`, or `require('caravel-pay')` on Node 20.19+ / 22.12+.

## Get API keys

There are no accounts or dashboards. One unsigned call returns a merchant id and secret. Run it once (`examples/connect.js`) and keep the result in your server's environment:

```js
import { connect } from 'caravel-pay';

const keys = await connect({ site_url: 'https://shop.example', payout_address: '0xYourPolygonWallet' });
// { merchant_id: 'mch_…', secret: '…', status: 'active', fee_rate: '2%' }
```

**Every call creates a new merchant.** To change the wallet or rotate the secret, connect again and keep the old credentials until the old merchant's open checkouts have finished, because their webhooks stay signed with the old secret.

## Create a checkout

```js
import { Caravel, normalizeAmount } from 'caravel-pay';

const caravel = new Caravel({ merchantId: process.env.CARAVEL_MERCHANT_ID, secret: process.env.CARAVEL_SECRET });

const checkout = await caravel.createCheckout({
  order_id: '1042',
  amount: normalizeAmount(order.total),      // "136.41"
  customer_email: 'buyer@example.com',       // optional
  return_url: 'https://shop.example/thanks',
  cancel_url: 'https://shop.example/cart',
  callback_url: 'https://shop.example/webhooks/caravel',
});
res.redirect(303, checkout.checkout_url);
```

The same `order_id` with the same details returns the same checkout, so retrying is safe. A checkout expires after 60 minutes. After that, use a new `order_id` such as `1042-2`.

## Handle the webhook

```js
import express from 'express';
import { CaravelSignatureError, isPaid, txHash, verifyWebhook } from 'caravel-pay';

app.post('/webhooks/caravel', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = verifyWebhook({
      body: req.body,                                   // raw bytes, not parsed JSON
      headers: req.headers,
      secret: process.env.CARAVEL_SECRET,               // or { [merchantId]: secret, … } or (id) => secret
      callbackUrl: 'https://shop.example/webhooks/caravel',
    });
  } catch (error) {
    if (error instanceof CaravelSignatureError) return res.sendStatus(error.status); // 401 or 400
    throw error;
  }
  // Re-fetch: the webhook says what to look at, the signed API says what is true.
  const checkout = await caravel.getCheckout(event.data.id);
  if (isPaid(checkout)) await markPaid(checkout.order_id, txHash(checkout));
  res.sendStatus(200);
});
```

- Remember `event.id` to skip duplicates: retries keep the same id.
- Answer 2xx only after you've stored the result. Anything else is retried for 24 hours.
- `headers` can be a plain object (Express, `node:http`) or a `Headers` instance (fetch-style frameworks). `body` can be a string, `Buffer` or `Uint8Array`.

`examples/express.js` is a complete app.

## Reference

| Call | API | Returns |
|---|---|---|
| `connect(params, options?)` / `Caravel.connect` | `POST /v1/connect` (unsigned, never retried) | `{merchant_id, secret, status, fee_rate}` |
| `caravel.createCheckout(params, { idempotencyKey? })` | `POST /v1/checkouts` | `{id, checkout_url, status, amount, currency, expires_at}` |
| `caravel.getCheckout(id)` | `GET /v1/checkouts/{id}` | the checkout, with `paid_amount` and `payout` once paid |
| `caravel.listCheckouts({ limit?, cursor? })` | `GET /v1/checkouts` | `{data, next_cursor}` |
| `caravel.allCheckouts({ limit? })` | pages through the list | async iterator of checkouts |
| `caravel.getMerchant()` | `GET /v1/merchant` | `{id, site_url, origins, payout_address, status, fee_rate}` |
| `caravel.createPaymentLink(params)` | `POST /v1/payment-links` (signed, never retried) | the payment link |
| `Caravel.createPaymentLinkWithoutKeys(params)` | `POST /v1/payment-links` unsigned, with `payout_address` | `{id, url}` |
| `caravel.getPaymentLink(id)` / `deactivatePaymentLink(id)` | `GET /v1/payment-links/{id}`, `POST …/deactivate` | the payment link |
| `caravel.request(method, path, body?)` | any signed endpoint | decoded JSON |
| `verifyWebhook({ body, headers, secret, callbackUrl, tolerance?, now?, merchantId? })` | | `{id, type, created, data, merchantId, known}` |
| `signTestEvent({ merchantId, secret, callbackUrl, body })` | | headers for a signed test event to your own endpoint |
| `computeSignature`, `signatureHeaders`, `signatureMatches`, `isFresh`, `signedPath` | | signing primitives |
| `STATUSES`, `validateCheckout`, `isPaid`, `txHash`, `payouts`, `explorerUrl` | | checkout helpers |
| `FEE_MODES`, `FEE_MODE_LABELS`, `feeMode`, `buyerTotalEstimate`, `normalizeFeeMode`, `feeModeNotice` | | who pays the fees |
| `caravel.fxQuote(currency, { amount })` | `GET /v1/fx-quote` | `currency`, `fx_rate`, `quoted_at`, and `usd_amount` with an amount |
| `CURRENCIES`, `isSupportedCurrency`, `formatAmount`, `estimateUsd`, `fxNotice`, `fxBufferBps` | | other currencies |
| `usdAmount`, `fxRate` | | a checkout's order total in US dollars and its rate |
| `normalizeAmount`, `toCents` (BigInt), `compareAmounts` | | exact two-decimal amounts |

Options for `new Caravel()` and `connect()`:
- `apiBase`: default `https://api.caravelpay.app`; `http://` only for localhost.
- `timeoutMs`: default 15000.
- `maxRetries`: default 0. When set, GETs and `createCheckout` are retried on network errors, 429 and 5xx, after `Retry-After` (≤ 10 s) or a 250 ms → 500 ms → 1 s backoff, and each retry is re-signed. `connect` and other POSTs are never retried.
- `userAgent`: a product token, put first.
- `fetch`: your own fetch implementation.

### Who pays the fees

By default you absorb both fees. Send `fee_mode` to pass them on:

```js
import { buyerTotalEstimate } from 'caravel-pay';

const checkout = await caravel.createCheckout({
  order_id: '1043',
  amount: '100.00',
  return_url: 'https://shop.example/thanks',
  cancel_url: 'https://shop.example/cart',
  callback_url: 'https://shop.example/webhooks/caravel',
  fee_mode: 'buyer',
});
checkout.amount;                 // "100.00": always your own order total
buyerTotalEstimate(checkout);    // "102.04": what the buyer pays before the card provider's fee
```

| `fee_mode` | card provider's fee | 2% Caravel fee | on a $100.00 order you receive |
|---|---|---|---|
| `seller` (default) | you | you | what arrives minus $2.00 |
| `split` | the buyer | you | $98.00 |
| `buyer` | the buyer | the buyer | $100.00 |

- Without `fee_mode`, your merchant default applies: `seller`, unless you passed `fee_mode` to `connect()`.
- A `seller` checkout carries no `fee_mode`; `feeMode(checkout)` returns `"seller"` for it.
- The mode is fixed when the checkout is created. The same `order_id` with another mode fails with `order_id_conflict`.
- Card surcharges are restricted in some countries (for example on consumer cards in the EU and the UK). Check your local rules before passing fees on.

### Other currencies

Price the checkout in your store's own currency. It is converted to US dollars once, when the checkout is created, and that amount is fixed for the checkout. Buyers are always charged in US dollars; you are always paid in USDC.

```js
import { formatAmount, usdAmount, fxRate, estimateUsd, fxNotice } from 'caravel-pay';

const checkout = await caravel.createCheckout({
  order_id: '1044',
  amount: formatAmount(order.total, 'EUR'),   // "45.00"; formatAmount(5000, 'JPY') is "5000"
  currency: 'EUR',
  return_url: 'https://shop.example/thanks',
  cancel_url: 'https://shop.example/cart',
  callback_url: 'https://shop.example/webhooks/caravel',
});
checkout.amount;        // "45.00", and checkout.currency is "EUR": exactly what you sent
usdAmount(checkout);    // "48.60": your order total in US dollars, fixed for this checkout
fxRate(checkout);       // "1.08": US dollars for one euro when it was created
```

- Supported besides USD: EUR, GBP, CAD, AUD, NZD, SEK, NOK, DKK, CHF, PLN, CZK, HUF, RON, HKD, SGD, MXN, BRL, ZAR, ILS, INR, THB, MYR, PHP, TRY (two decimals) and JPY, KRW (no decimals). `CURRENCIES` has the list.
- Mark an order paid from the checkout's `status`. Compare `amount` and `currency` with what you sent, in your own currency; `paid_amount` and the payout are US dollars and tokens, so compare those with `usdAmount(checkout)`.
- A retry with the same `order_id`, amount and currency returns the same checkout with its original rate.
- If no exchange rate can be confirmed, the API answers `503 service_unavailable` and creates nothing. Retry with the same `order_id`.
- To tell buyers what to expect before you redirect them, cache a rate for a few minutes and build the line:

```js
const quote = await caravel.fxQuote('EUR');                    // { currency: 'EUR', fx_rate: '1.08', quoted_at: … }
fxNotice('EUR', estimateUsd('45.00', quote.fx_rate));
// "You'll be charged in US dollars: about $48.60. You see the exact amount before you pay."
```

- Optional `fx_buffer_bps: 100` adds a 1% margin to the converted amount (0 to 500), to cover exchange-rate movement until you convert your USDC. `fxBufferBps('1.5')` turns a percentage setting into basis points.

### Statuses

| status | meaning | what to do |
|---|---|---|
| `awaiting_payment` | open, nothing arrived yet | wait |
| `confirming` | a payment is confirming | wait; don't ship yet |
| `paid` | full amount arrived and both payout transfers confirmed | mark paid with `txHash(checkout)` |
| `underpaid` | less than the amount arrived; the buyer can top up | hold, note `paid_amount` |
| `expired` | passed `expires_at` without payment | cancel if unpaid |
| `review` | needs a manual look | hold |

### Errors

All extend `CaravelError`. Argument mistakes throw `TypeError` (or `RangeError` for amounts) before any request is sent.

| Error | When |
|---|---|
| `CaravelApiError` | Non-2xx. `code` (for example `order_id_conflict`), `status`, `param`, `retryAfter`, `retryable` |
| `CaravelNetworkError` | No response (DNS, TLS, timeout, oversized). Retrying `createCheckout` with the same `order_id` is safe |
| `CaravelUnexpectedResponseError` | A 2xx with a malformed body. Treat as failed |
| `CaravelSignatureError` | A webhook failed verification. `reason`, `status` |

## Coming from PayGate's Node SDK

PayGate's SDK builds a payment URL from a wallet-forwarding address and verifies its callback. With Caravel Pay you create a **checkout** per order, redirect to its `checkout_url`, verify the signed webhook and **re-fetch the checkout** before marking the order paid. There is no amount-tolerance setting: `underpaid` is its own status. Payouts go to the wallet you connected, in the token the buyer paid with (card payments arrive as USDC), minus the 2% Caravel fee.

## Download

- [Latest release](https://github.com/caravelpay/caravel-pay-node/releases/latest): `caravel-pay-1.2.2.tgz`, with `SHA256SUMS`.
- The same file is at <https://caravelpay.app/plugins/#node-sdk>, and its checksum is in <https://caravelpay.app/download/SHA256SUMS>.

## Docs and support

- Guide: <https://caravelpay.app/docs/node-sdk>
- API reference: <https://caravelpay.app/docs/>
- Questions and bug reports: [hello@caravelpay.app](mailto:hello@caravelpay.app), or open an issue here.

## Licence

MIT. See `LICENSE`.
