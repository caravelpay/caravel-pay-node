# Changelog

## 1.2.1 (2026-11-10)

- Documentation only: the fee is described as the 2% Caravel fee, and the README states who pays what (the buyer pays the
  order total, most card providers keep their own fee out of it, the Caravel fee is 2% of the order total). No code change
  apart from the version number.
- `package.json` names the source repository and the support address.

## 1.2.0 (2026-11-10)

- Other currencies: `createCheckout()` and the payment-link calls take your store's own `currency` (EUR, GBP, SEK, JPY and more:
  `CURRENCIES`). The amount is converted to US dollars when the checkout is created; the checkout keeps your `amount` and
  `currency` and adds `usd_amount` and `fx_rate` (`usdAmount()`, `fxRate()`).
- `formatAmount()` writes a platform total in the currency's own decimals ("45.00", or "5000" for JPY).
- `fxQuote()` returns today's indicative rate, and `estimateUsd()` / `fxNotice()` make the line
  "You'll be charged in US dollars: about $48.60" for your checkout page.
- Optional `fx_buffer_bps` on `createCheckout()`: your margin on the converted amount (0 to 500).
- A checkout answered for another amount or currency than requested is refused. US dollar requests are unchanged.

## 1.1.0 (2026-11-10)

- Who pays the fees: `fee_mode` (`seller`, `split`, `buyer`) on `createCheckout()`, `connect()` and the payment-link calls;
  `FEE_MODES`, `FEE_MODE_LABELS`, `feeMode()`, `buyerTotalEstimate()`, `normalizeFeeMode()` and `feeModeNotice()`.
  A request that names a mode must be answered in that mode. Requests without `fee_mode` are unchanged.

## 1.0.0 (2026-11-09)

- First release: connect, create/get/list checkouts, GET merchant, payment links (create signed or without keys, get, deactivate),
  signed requests, webhook verification (±300 s, path + query, constant time), optional retries.
