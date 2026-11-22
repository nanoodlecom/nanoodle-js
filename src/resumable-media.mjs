// Track the newest attempt separately from accepted jobs. A new attempt cannot
// discard a paid job merely by starting, but older callbacks lose write authority.
const attemptsByRegistry = new WeakMap();

/**
 * Run or resume a provider media job using the browser host's job registry.
 * `idField` is "runId" for video or "job" for audio's full submission record.
 * Retain accepted work through poll failures and finished URLs through delivery
 * failures. Only a terminal provider job failure or successful delivery retires it.
 */
export async function runResumableMedia({
  jobs, key, sig, idField, signal, run, resolve, onTerminalFailure,
}) {
  let attempts;
  let owner;
  const attempt = {};
  if (key) {
    attempts = attemptsByRegistry.get(jobs);
    if (!attempts) {
      attempts = new Map();
      attemptsByRegistry.set(jobs, attempts);
    }
    attempts.set(key, attempt);
    owner = jobs.get(key);
  }
  const ownsSlot = () => attempts?.get(key) === attempt && jobs.get(key) === owner;
  let accepted = owner?.njs && owner.sig === sig ? owner : undefined;
  function remember(entry) {
    accepted = entry;
    if (ownsSlot()) {
      jobs.set(key, entry);
      owner = entry;
    }
  }

  try {
    let url = accepted?.resultUrl;
    if (!url) {
      try {
        url = await run({
          resume: accepted?.[idField],
          onRunId: id => remember({ sig, njs: true, [idField]: id }),
        });
      } catch (error) {
        if (accepted && error?.code === "job-failed" && !signal?.aborted && ownsSlot()) {
          jobs.delete(key);
          onTerminalFailure?.();
        }
        throw error;
      }
    }
    remember({ ...accepted, sig, njs: true, resultUrl: url });
    const result = await resolve(url);
    // The host may drop a result that finishes after Stop. Keep it resumable.
    if (!signal?.aborted && ownsSlot()) jobs.delete(key);
    return result;
  } finally {
    if (attempts?.get(key) === attempt) attempts.delete(key);
  }
}
