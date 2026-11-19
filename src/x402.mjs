import { NanoodleError } from "./errors.mjs";

/**
 * x402 accountless payments (NanoGPT) — request with `x-x402: true` and no key,
 * get HTTP 402 with payment options, pay in Nano (XNO), call the complete URL,
 * receive the original response.
 *
 * The library NEVER holds funds or keys: the actual send happens inside the
 * user-supplied `payment` callback (their own wallet, signer, or a human
 * scanning a QR). Wire shape live-verified against nano-gpt.com 2026-07-12
 * (tests/fixtures/x402/402.json is a real captured response).
 */

/** Reject anything that isn't a callback — a seed/private key must never reach this library. */
export function assertPaymentOption(payment) {
  if (payment == null) return;
  if (typeof payment !== "function") {
    throw new NanoodleError(
      "payment must be a callback function — nanoodle never accepts wallet seeds or private keys. " +
      "Do the send inside your callback with your own wallet/signer (it receives the invoice: " +
      "{ payTo, amountRaw, uri, ... }).", { code: "x402" });
  }
}

/** ISO string or unix seconds → epoch ms (null when absent/unparsable). */
function toMs(v) {
  if (v == null) return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v; // seconds vs ms
  const t = Date.parse(v);
  return isNaN(t) ? null : t;
}

/**
 * Pull the Nano payment option out of a 402 response body.
 * Looks in the x402-standard `accepts` array first, then the NanoGPT
 * `payment.accepted` list. Returns a frozen invoice for the payment callback.
 */
export function parseNanoInvoice(body, baseUrl) {
  const pay = body && body.payment;
  const pool = [
    ...(Array.isArray(body && body.accepts) ? body.accepts : []),
    ...(Array.isArray(pay && pay.accepted) ? pay.accepted : []),
  ];
  const nano = pool.find((a) => a && a.scheme === "nano" && /^nano_[a-z0-9]+$/.test(String(a.payTo || "")));
  if (!nano) return null;
  const paymentId = nano.paymentId || (pay && pay.paymentId) || null;
  const abs = (u) => (u ? new URL(u, baseUrl).href : null);
  const amountRaw = String(nano.maxAmountRequired || nano.amount || "");
  const usd = nano.maxAmountRequiredUSD != null ? Number(nano.maxAmountRequiredUSD)
    : nano.amountUsd != null ? Number(nano.amountUsd)
    : pay && pay.amountUsd != null ? Number(pay.amountUsd) : null;
  return Object.freeze({
    scheme: "nano",
    paymentId,
    payTo: nano.payTo,
    /** integer raw units (1 XNO = 10^30 raw), as a string */
    amountRaw,
    /** human string, e.g. "0.00018406 XNO" */
    amount: nano.maxAmountRequiredFormatted || nano.amountFormatted || null,
    amountUsd: usd != null && isFinite(usd) ? usd : null,
    /** ready-to-scan/click nano: URI */
    uri: "nano:" + nano.payTo + (amountRaw ? "?amount=" + amountRaw : ""),
    expiresAt: toMs(nano.expiresAt != null ? nano.expiresAt : pay && pay.expiresAt),
    statusUrl: abs(nano.statusUrl || nano.callbackUrl || (pay && pay.statusUrl) || (paymentId && "/api/x402/status/" + paymentId)),
    completeUrl: abs(nano.completeUrl || (pay && pay.completeUrl) || (paymentId && "/api/x402/complete/" + paymentId)),
    explorerUrl: (nano.extra && nano.extra.explorerUrl) || null,
    description: nano.description || null,
    requestHash: (pay && pay.requestHash) || body.requestHash || null,
  });
}

const RESULT_KEYS = ["choices", "data", "output", "runId", "url", "audioUrl", "transcription", "text"];

/**
 * Does a complete-endpoint body already carry the replayed API result?
 * A paid decision comes back as { answers, usage }. That is success. Treating
 * it as a bare receipt makes the client resend the original request, and the
 * API answers 402 because the payment was already consumed.
 */
export function looksLikeResult(j) {
  if (!j || typeof j !== "object") return false;
  if (RESULT_KEYS.some((k) => j[k] != null)) return true;
  return j.answers != null && j.usage != null && typeof j.usage === "object";
}
