import { NanoodleError } from "./errors.mjs";

const MAX_TIMEOUT_MS = 2_147_483_647;

export function normalizeTimeoutMs(value, label) {
  const ms = typeof value === "string" ? Number(value) : value ?? 0;
  // A nonzero decimal string can round down to zero during conversion.
  const underflow = ms === 0 && typeof value === "string" && /[1-9]/.test(value.split(/[eE]/, 1)[0]);
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_TIMEOUT_MS || underflow) {
    throw new NanoodleError(`${label} expects milliseconds between 0 and ${MAX_TIMEOUT_MS}`, { code: "invalid-timeout" });
  }
  return ms === 0 ? null : ms;
}

// Keep the absolute deadline alongside the real signal. The timer wakes idle
// work, while I/O and completion checks also catch an overdue timer when
// synchronous code or a chain of microtasks keeps the event loop busy.
const checks = new WeakMap();

export function startDeadline(controller, timeoutMs, message, parentSignal) {
  const until = timeoutMs == null ? Infinity : performance.now() + timeoutMs;
  const expire = () => controller.abort(new NanoodleError(message, { code: "timeout" }));
  const signal = controller.signal;
  checks.set(signal, () => {
    enforceDeadline(parentSignal);
    if (!signal.aborted && performance.now() >= until) expire();
  });
  return timeoutMs == null ? null : setTimeout(expire, Math.ceil(timeoutMs));
}

export function enforceDeadline(signal) {
  checks.get(signal)?.();
}

export function abortReason(signal) {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new NanoodleError(reason != null ? String(reason) : "run aborted", { code: "aborted" });
}

export function throwIfAborted(signal) {
  enforceDeadline(signal);
  if (signal?.aborted) throw abortReason(signal);
}
