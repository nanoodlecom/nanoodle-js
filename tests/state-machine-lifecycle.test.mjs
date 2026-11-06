import test from 'node:test';
import assert from 'node:assert/strict';
import { Workflow, RunError } from '../src/index.mjs';
import { NanoClient } from '../src/client.mjs';

const graph = (fields = {}) => ({ nodes: [{ id: 'n', type: 'image', fields: { prompt: 'hi', model: 'test', ...fields } }], links: [] });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

for (const mode of ['run timeout', 'outer abort', 'node timeout during publication']) {
  test(`${mode} settles even when injected I/O ignores cancellation`, { timeout: 1500 }, async () => {
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const events = [];
    const controller = new AbortController();
    const wf = Workflow.fromJSON(graph(mode.startsWith('node') ? { timeoutMs: 30 } : {}), { apiKey: 'k', fetch: async url => {
      if (mode.startsWith('node') && String(url).includes('/generations')) return json({ data: [{ url: '/api/content/job' }], cost: 0.2 });
      started();
      return held;
    } });
    const run = wf.run({}, { ...(mode === 'run timeout' ? { timeoutMs: 30 } : {}), signal: controller.signal, onProgress: e => events.push(e) });
    await ready;
    if (mode === 'outer abort') controller.abort(new Error('stop now'));
    let result;
    try {
      await assert.rejects(run, e => {
        assert.ok(e instanceof RunError);
        assert.equal(e.result.nodes.n.status, 'error');
        assert.match(e.message, /timed out|stop now/);
        result = e.result;
        return true;
      });
      const snapshot = JSON.stringify(result);
      const eventCount = events.length;
      release(mode.startsWith('node') ? new Response('bytes') : json({ data: [{ url: 'https://cdn.invalid/image.png' }], cost: 0.9 }));
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(JSON.stringify(result), snapshot);
      assert.equal(events.length, eventCount);
    } finally { release(json({ data: [{ url: 'https://cdn.invalid/image.png' }] })); }
  });
}

test('abort inside node-start listener prevents submission even with a node timer', async () => {
  let requests = 0;
  const ac = new AbortController();
  const wf = Workflow.fromJSON(graph({ timeoutMs: 100 }), { apiKey: 'k', fetch: async () => { requests++; return json({ data: [{ url: 'https://cdn.invalid/x.png' }] }); } });
  await assert.rejects(wf.run({}, { signal: ac.signal, onProgress: e => { if (e.type === 'node-start') ac.abort(new Error('stop')); } }), /stop/);
  assert.equal(requests, 0);
});

test('cancelled invoice body never reaches the payment callback', async () => {
  const ac = new AbortController();
  let payments = 0;
  const client = new NanoClient({ payment: async () => { payments++; }, fetch: async () => ({ status: 402, json: async () => {
    ac.abort(new Error('cancel before payment'));
    return { accepts: [{ scheme: 'nano', payTo: 'nano_test', paymentId: 'p', amount: '1' }] };
  } }) });
  await assert.rejects(client.chat([], 'test', {}, { signal: ac.signal }), /cancel before payment/);
  assert.equal(payments, 0);
});

for (const kind of ['video', 'audio']) {
  test(`${kind} polling stops on permanent auth error and retries a transient HTTP JSON error`, async () => {
    for (const status of [401, 503]) {
      let polls = 0;
      const client = new NanoClient({ apiKey: 'k', pollIntervals: { video: 1, audio: 1 }, timeouts: { video: 100, audio: 100 }, fetch: async (url, init) => {
        if (init.method === 'POST') return json({ runId: 'job' });
        polls++;
        if (polls === 1) return json({ status: 'COMPLETED', output: { url: 'https://cdn.invalid/untrusted.mp4' }, audioUrl: 'https://cdn.invalid/untrusted.mp3' }, status);
        return json({ status: 'COMPLETED', output: { url: 'https://cdn.invalid/ok.mp4' }, audioUrl: 'https://cdn.invalid/ok.mp3' });
      } });
      const call = kind === 'video' ? client.video('test', 'hi') : client.audio('test', 'hi');
      if (status === 401) { await assert.rejects(call, e => e.code === 'auth'); assert.equal(polls, 1); }
      else { assert.match(await call, /\/ok\./); assert.equal(polls, 2); }
    }
  });
  test(`${kind} cancelled is a terminal provider state`, async () => {
    let polls = 0;
    const client = new NanoClient({ apiKey: 'k', pollIntervals: { video: 1, audio: 1 }, timeouts: { video: 100, audio: 100 }, fetch: async (url, init) => {
      if (init.method === 'POST') return json({ runId: 'job' });
      polls++; return json({ status: 'cancelled' });
    } });
    await assert.rejects(kind === 'video' ? client.video('test', 'hi') : client.audio('test', 'hi'), /failed: cancelled/i);
    assert.equal(polls, 1);
  });
}

test('duplicate persisted node identities are rejected before execution', () => {
  assert.throws(() => Workflow.fromJSON({ nodes: [graph().nodes[0], graph().nodes[0]], links: [] }), /duplicate node id/);
});

for (const kind of ['video', 'audio']) {
  test(`${kind} finite polling deadline bounds a hung response body`, { timeout: 1500 }, async () => {
    let release;
    const body = new Promise(resolve => { release = resolve; });
    const client = new NanoClient({ apiKey: 'k', pollIntervals: { video: 1, audio: 1 }, timeouts: { video: 25, audio: 25 }, fetch: async (url, init) => {
      if (init.method === 'POST') return json({ runId: 'job' });
      return { ok: true, json: () => body };
    } });
    try { await assert.rejects(kind === 'video' ? client.video('test', 'hi') : client.audio('test', 'hi'), new RegExp(`${kind} timed out`)); }
    finally { release({ status: 'failed' }); }
  });
}

for (const contentType of ['application/json', '']) {
  test(`unreadable x402 completion (${contentType || 'missing MIME'}) never replays generation`, async () => {
    let posts = 0, payments = 0;
    const client = new NanoClient({ payment: async () => { payments++; }, fetch: async url => {
      if (String(url).includes('/complete/')) return { ok: true, status: 200, headers: new Headers({ 'content-type': contentType }), json: async () => { throw new Error('truncated'); } };
      posts++;
      return json({ accepts: [{ scheme: 'nano', payTo: 'nano_test', paymentId: 'p', amount: '1' }] }, 402);
    } });
    await assert.rejects(client.chat([], 'test'), e => e.code === 'x402' && e.paymentId === 'p');
    assert.equal(payments, 1); assert.equal(posts, 1);
  });
}

test('expired invoice never reaches payment callback', async () => {
  let payments = 0;
  const client = new NanoClient({ payment: async () => { payments++; }, fetch: async () => json({ accepts: [{ scheme: 'nano', payTo: 'nano_test', paymentId: 'p', amount: '1', expiresAt: Date.now() - 10000 }] }, 402) });
  await assert.rejects(client.chat([], 'test'), e => e.code === 'x402-expired');
  assert.equal(payments, 0);
});

test('lipsync cannot trim-retry after an accepted job fails polling', async () => {
  const { RUNNERS } = await import('../src/browser.mjs');
  let submits = 0, trims = 0;
  const client = new NanoClient({ apiKey: 'k', pollIntervals: { video: 1 }, fetch: async (url, init) => {
    if (init.method === 'POST') { submits++; return json({ runId: 'accepted-job' }); }
    return new Response('INVALID_AUDIO_DURATION audio duration up to 30 seconds', { status: 400 });
  } });
  await assert.rejects(RUNNERS.lipsync({ id: 'n', fields: { model: 'test' } }, { image: 'data:image/png;base64,eA==', audio: 'https://cdn.invalid/audio.mp3' }, {
    video: (...args) => client.video(...args), trimAudio: async () => { trims++; return 'data:audio/wav;base64,eA=='; }
  }), e => e.runId === 'accepted-job');
  assert.equal(submits, 1); assert.equal(trims, 0);
});
