import { NanoodleError } from "./errors.mjs";

// Keep the absolute deadline alongside the real signal. The timer wakes idle
// work, while I/O and completion checks also catch an overdue timer when
// synchronous code or a chain of microtasks keeps the event loop busy.
const checks = new WeakMap();

export function startDeadline(controller, timeoutMs, message, parentSignal) {
  const until = performance.now() + Number(timeoutMs);
  const expire = () => controller.abort(new NanoodleError(message, { code: "timeout" }));
  const signal = controller.signal;
  checks.set(signal, () => {
    enforceDeadline(parentSignal);
    if (!signal.aborted && performance.now() >= until) expire();
  });
  return setTimeout(expire, timeoutMs);
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
