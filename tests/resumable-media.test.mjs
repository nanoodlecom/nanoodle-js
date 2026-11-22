import { test } from "node:test";
import assert from "node:assert/strict";
import { runResumableMedia } from "../src/browser.mjs";

const terminalError = () => Object.assign(new Error("failed"), { code: "job-failed" });

test("poll and delivery failures retain the accepted job and completed URL", async () => {
  const jobs = new Map();
  const job = { id: "paid-audio", refundToken: "refundable" };
  const opts = { jobs, key: "node", sig: "input", idField: "job", resolve: async url => url };
  await assert.rejects(runResumableMedia({
    ...opts,
    run: async ({ resume, onRunId }) => {
      assert.equal(resume, undefined);
      onRunId(job);
      throw new Error("401 from status poll");
    },
  }), /401 from status poll/);
  assert.equal(jobs.get("node").job, job);

  await assert.rejects(runResumableMedia({
    ...opts,
    run: async ({ resume }) => {
      assert.equal(resume, job);
      return "provider-url";
    },
    resolve: async () => { throw new Error("delivery unavailable"); },
  }), /delivery unavailable/);
  assert.deepEqual(jobs.get("node"), {
    job, sig: "input", njs: true, resultUrl: "provider-url",
  });

  const url = await runResumableMedia({
    ...opts,
    run: () => assert.fail("a completed output only needs delivery"),
  });
  assert.equal(url, "provider-url");
  assert.equal(jobs.has("node"), false);
});

test("only owned, non-cancelled terminal failures retire an accepted job", async () => {
  const accepted = { runId: "paid-video", sig: "input", njs: true };
  const jobs = new Map([["node", accepted]]);
  let failures = 0;
  const opts = {
    jobs, key: "node", sig: "input", idField: "runId",
    run: async () => { throw terminalError(); },
    onTerminalFailure: () => failures++,
  };
  await assert.rejects(runResumableMedia({ ...opts, signal: AbortSignal.abort() }), { code: "job-failed" });
  assert.equal(jobs.get("node"), accepted);
  assert.equal(failures, 0);
  await assert.rejects(runResumableMedia(opts), { code: "job-failed" });
  assert.equal(jobs.has("node"), false);
  assert.equal(failures, 1);
});

test("delivery that finishes after Stop preserves the ready URL", async () => {
  const jobs = new Map();
  const controller = new AbortController();
  const result = await runResumableMedia({
    jobs, key: "node", sig: "input", idField: "runId", signal: controller.signal,
    run: async () => "provider-url",
    resolve: async url => {
      controller.abort();
      return url;
    },
  });
  assert.equal(result, "provider-url");
  assert.equal(jobs.get("node").resultUrl, "provider-url");
});

test("late acceptance and delivery cannot replace a newer attempt's slot", async () => {
  const jobs = new Map();
  const opts = { jobs, key: "node", idField: "runId", resolve: async url => url };
  let acceptOlder, completeOlder, acceptNewer, failNewer;
  const older = runResumableMedia({
    ...opts, sig: "old-input",
    run: ({ onRunId }) => new Promise(resolve => {
      acceptOlder = onRunId;
      completeOlder = resolve;
    }),
  });
  const newer = runResumableMedia({
    ...opts, sig: "new-input",
    run: ({ onRunId }) => new Promise((resolve, reject) => {
      acceptNewer = onRunId;
      failNewer = reject;
    }),
  });
  acceptOlder("old-paid-job");
  assert.equal(jobs.has("node"), false);
  acceptNewer("new-paid-job");
  const latest = jobs.get("node");
  completeOlder("old-provider-url");
  assert.equal(await older, "old-provider-url");
  assert.equal(jobs.get("node"), latest);

  failNewer(new Error("poll unavailable"));
  await assert.rejects(newer, /poll unavailable/);
  assert.equal(jobs.get("node").runId, "new-paid-job");
});
