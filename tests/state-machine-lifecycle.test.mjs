import test from 'node:test';
import assert from 'node:assert/strict';
import { Workflow, RunError } from '../src/index.mjs';
import { NanoClient } from '../src/client.mjs';
import { PNG_B64 } from './harness/mock-server.mjs';

const graph = (fields = {}) => ({ nodes: [{ id: 'n', type: 'image', fields: { prompt: 'hi', model: 'test', ...fields } }], links: [] });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const quote = (paymentId = 'pay_fixture') => json({ accepts: [{ scheme: 'nano', payTo: 'nano_test', paymentId, amount: '1' }] }, 402);
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

for (const scope of ['run', 'node']) {
  test(`${scope} deadline prevents submission after synchronous progress blocks the timer`, async (t) => {
    let now = 0, requests = 0;
    t.mock.method(performance, 'now', () => now);
    const wf = Workflow.fromJSON(graph(scope === 'node' ? { timeoutMs: 10 } : {}), { apiKey: 'k', fetch: async () => {
      requests++;
      return json({ data: [{ url: 'https://cdn.invalid/image.png' }] });
    } });
    await assert.rejects(wf.run({}, {
      ...(scope === 'run' ? { timeoutMs: 10 } : {}),
      onProgress: e => { if (e.type === 'node-start') now += 60; },
    }), e => {
      assert.ok(e instanceof RunError);
      assert.equal(e.result.nodes.n.status, 'error');
      assert.equal(e.result.errors[0].code, 'timeout');
      assert.match(e.message, new RegExp(`${scope} timed out after 10ms`));
      return true;
    });
    assert.equal(requests, 0);
  });
}

test('a response fulfilled after the deadline retains billing but cannot publish outputs', async (t) => {
  let now = 0;
  const requests = [];
  t.mock.method(performance, 'now', () => now);
  const wf = Workflow.fromJSON(graph(), { apiKey: 'k', fetch: async url => {
    requests.push(url);
    if (!String(url).includes('/generations')) return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } });
    return { ok: true, headers: new Headers(), json: async () => {
      now += 60;
      return { data: [{ url: '/api/images/content?job=1' }], cost: 0.2 };
    } };
  } });
  await assert.rejects(wf.run({}, { timeoutMs: 10 }), e => {
    assert.ok(e instanceof RunError);
    assert.equal(e.code, 'timeout');
    assert.deepEqual(e.result.outputs, {});
    assert.equal(e.result.costUsd, 0.2);
    return true;
  });
  assert.equal(requests.length, 1, 'an expired run must not fetch provider media');
});

test('an invoice decoded after the deadline never reaches the payment callback', async (t) => {
  let now = 0, payments = 0;
  t.mock.method(performance, 'now', () => now);
  const wf = Workflow.fromJSON(graph(), { apiKey: null, payment: async () => { payments++; }, fetch: async url => {
    if (String(url).includes('/complete/')) return json({ data: [{ url: 'https://cdn.invalid/image.png' }] });
    return { status: 402, json: async () => {
      now += 60;
      return { accepts: [{ scheme: 'nano', payTo: 'nano_test', paymentId: 'p', amount: '1' }] };
    } };
  } });
  await assert.rejects(wf.run({}, { timeoutMs: 10 }), e => e instanceof RunError && e.code === 'timeout');
  assert.equal(payments, 0);
});

for (const mode of ['run timeout', 'outer abort', 'node timeout during publication']) {
  test(`${mode} settles even when injected I/O ignores cancellation`, { timeout: 1500 }, async () => {
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const events = [];
    const controller = new AbortController();
    const wf = Workflow.fromJSON(graph(mode.startsWith('node') ? { timeoutMs: 30 } : {}), { apiKey: 'k', fetch: async url => {
      if (mode.startsWith('node') && String(url).includes('/generations')) return json({ data: [{ url: '/api/images/content?job=1' }], cost: 0.2 }); // an allowlisted provider content path (CONTENT_API_PATHS) so publication actually fetches it
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

for (const mode of ['abort', 'run timeout', 'node timeout']) {
  test(`x402 ${mode} waits for the entered callback and preserves the original recovery reference`, { timeout: 1500 }, async () => {
    const controller = new AbortController();
    const wallet = Promise.withResolvers(), entered = Promise.withResolvers(), stopped = Promise.withResolvers();
    const calls = [];
    const wf = Workflow.fromJSON(graph(mode === 'node timeout' ? { timeoutMs: 75 } : {}), {
      apiKey: null, baseUrl: 'https://provider.test',
      async payment(invoice) {
        assert.equal(arguments.length, 1);
        assert.equal(invoice.paymentId, 'pay_fixture');
        entered.resolve();
        // User callbacks can take time to return and can throw after broadcasting.
        return wallet.promise;
      },
      async fetch(url, init) {
        calls.push(new URL(url).pathname);
        init.signal.addEventListener('abort', () => stopped.resolve(), { once: true });
        return quote();
      },
    });
    let published = false;
    const run = wf.run({}, { signal: controller.signal, ...(mode === 'run timeout' ? { timeoutMs: 75 } : {}) });
    run.then(() => { published = true; }, () => { published = true; });
    try {
      await entered.promise;
      if (mode === 'abort') controller.abort(new Error('stop the run'));
      await stopped.promise;
      await nextTurn();
      assert.equal(published, false, 'terminal result waits for the wallet callback');
      if (mode === 'abort') wallet.reject(new Error('private wallet failure'));
      else wallet.resolve();
      await assert.rejects(run, e => {
        assert.ok(e instanceof RunError);
        const [payment] = e.result.payments;
        assert.deepEqual(payment, {
          paymentId: 'pay_fixture',
          statusUrl: 'https://provider.test/api/x402/status/pay_fixture',
          completeUrl: 'https://provider.test/api/x402/complete/pay_fixture',
          stage: 'payment',
          status: mode === 'abort' ? 'callback-failed' : 'callback-returned',
          redeemed: false,
          httpStatus: null,
          requestId: null,
          nodeId: 'n',
        });
        assert.match(e.result.nodes.n.error, /pay_fixture/);
        assert.doesNotMatch(JSON.stringify(e.result), /nano_test|private wallet failure/);
        assert.equal(e.result.errors[0].paymentId, payment.paymentId);
        return true;
      });
      assert.deepEqual(calls, ['/v1/images/generations']);
    } finally { wallet.resolve(); }
  });
}

test('x402 cancellation can finish while completion I/O hangs and never starts replay', { timeout: 1500 }, async () => {
  const controller = new AbortController();
  const completion = Promise.withResolvers(), started = Promise.withResolvers();
  let sends = 0, replays = 0;
  const wf = Workflow.fromJSON(graph(), { apiKey: null, async payment() { sends++; }, async fetch(url, init) {
    if (new URL(url).pathname.includes('/complete/')) {
      started.resolve();
      return completion.promise;
    }
    if (init.headers['x-x402-payment-id']) replays++;
    return quote();
  } });
  const run = wf.run({}, { signal: controller.signal });
  await started.promise;
  controller.abort(new Error('stop completion polling'));
  let snapshot, result;
  try {
    await assert.rejects(run, e => {
      result = e.result;
      const [payment] = result.payments;
      assert.equal(payment.stage, 'completion');
      assert.equal(payment.status, 'callback-returned');
      assert.equal(payment.redeemed, false);
      snapshot = JSON.stringify(result);
      return true;
    });
  } finally { completion.resolve(json({ status: 'completed' })); }
  await nextTurn();
  assert.equal(sends, 1);
  assert.equal(replays, 0);
  assert.equal(JSON.stringify(result), snapshot);
});

test('one failed Decide request stops its parallel paid order and drains the wallet', { timeout: 3000 }, async () => {
  const image = 'data:image/png;base64,' + PNG_B64;
  const wallet = Promise.withResolvers(), entered = Promise.withResolvers(), stopped = Promise.withResolvers();
  const calls = [];
  const wf = Workflow.fromJSON({
    nodes: [
      { id: 'a', type: 'upload', fields: { image } },
      { id: 'b', type: 'upload', fields: { image } },
      { id: 'd', type: 'decide', fields: { mode: 'pick', model: 'perplexity/pplx-decider-v1.2' } },
    ],
    links: [
      { from: { node: 'a', port: 'image' }, to: { node: 'd', port: 'img1' } },
      { from: { node: 'b', port: 'image' }, to: { node: 'd', port: 'img2' } },
    ],
  }, {
    apiKey: null,
    async payment() {
      entered.resolve();
      await wallet.promise;
    },
    async fetch(url, init) {
      calls.push(new URL(url).pathname);
      if (calls.length === 1) {
        init.signal.addEventListener('abort', () => stopped.resolve(), { once: true });
        return quote();
      }
      await entered.promise;
      return json({ error: 'other order unavailable' }, 500);
    },
  });
  let published = false;
  const run = wf.run();
  run.then(() => { published = true; }, () => { published = true; });
  try {
    await stopped.promise;
    await nextTurn();
    assert.equal(published, false);
    wallet.resolve();
    await assert.rejects(run, e => {
      assert.ok(e instanceof RunError);
      assert.match(e.message, /other order unavailable/);
      assert.equal(e.result.payments[0].nodeId, 'd');
      assert.equal(e.result.payments[0].status, 'callback-returned');
      assert.equal(e.result.payments[0].redeemed, false);
      return true;
    });
    assert.deepEqual(calls, ['/api/v1/decisions', '/api/v1/decisions']);
  } finally { wallet.resolve(); }
});

test('x402 records a redeemed payment when the provider returns the paid output', async () => {
  const wf = Workflow.fromJSON(graph(), { apiKey: null, payment: async () => {}, fetch: async url =>
    new URL(url).pathname.includes('/complete/') ? json({ data: [{ url: 'https://cdn.invalid/x.png' }] }) : quote(),
  });
  const result = await wf.run();
  const [payment] = result.payments;
  assert.equal(payment.paymentId, 'pay_fixture');
  assert.equal(payment.status, 'callback-returned');
  assert.equal(payment.stage, 'completion');
  assert.equal(payment.redeemed, true);
  assert.equal(result.get('Image').url, 'https://cdn.invalid/x.png');
});

for (const stage of ['completion', 'replay']) {
  test(`x402 ${stage} recovery metadata survives workflow wrapping`, async () => {
    const providerError = () => new Response('private provider error', { status: 502, headers: { 'x-request-id': 'request_fixture' } });
    let sends = 0;
    const wf = Workflow.fromJSON(graph(), { apiKey: null, async payment() { sends++; }, async fetch(url, init) {
      if (init.headers['x-x402-payment-id']) return providerError();
      if (new URL(url).pathname.includes('/complete/')) return stage === 'completion' ? providerError() : json({ status: 'completed' });
      return quote();
    } });
    await assert.rejects(wf.run(), e => {
      assert.ok(e instanceof RunError);
      assert.equal(e.result.payments[0].httpStatus, 502);
      assert.equal(e.result.payments[0].redeemed, false);
      const { paymentId, requestId, statusUrl, completeUrl, code, status } = e.result.errors[0];
      assert.deepEqual({ paymentId, requestId, code, status }, { paymentId: 'pay_fixture', requestId: 'request_fixture', code: 'x402', status: 502 });
      assert.match(statusUrl, /status\/pay_fixture$/);
      assert.match(completeUrl, /complete\/pay_fixture$/);
      assert.equal(e.result.errors[0].stage, stage);
      assert.match(e.message, /pay_fixture/);
      assert.doesNotMatch(e.message, /private provider error/);
      return true;
    });
    assert.equal(sends, 1);
  });
}

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
    await assert.rejects(kind === 'video' ? client.video('test', 'hi') : client.audio('test', 'hi'), {
      code: 'job-failed', message: /failed: cancelled/i,
    });
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

test('derived input and output keys stay unique when authored names contain suffixes', async () => {
  const wf = Workflow.fromJSON({ nodes: ['A', 'A', 'A 2', 'a 2'].map((name, i) => ({ id: `n${i}`, type: 'text', name, fields: { text: `stored${i}` } })), links: [] });
  assert.equal(new Set(wf.inputs.map(i => i.key.toLowerCase())).size, 4);
  assert.equal(new Set(wf.outputs.map(o => o.key.toLowerCase())).size, 4);
  const assigned = Object.fromEntries(wf.inputs.map((input, i) => [input.key, `input${i}`]));
  const result = await wf.run(assigned);
  for (let i = 0; i < 4; i++) {
    assert.equal(result.get(wf.outputs[i].key), `input${i}`);
    assert.equal(result.get(`n${i}`), `input${i}`);
  }
});

test('friendly output keys cannot overwrite another node ID alias', async () => {
  const wf = Workflow.fromJSON({ nodes: [
    { id: 'n1', type: 'text', name: 'Out', fields: { text: 'first' } },
    { id: 'n2', type: 'text', name: 'n1', fields: { text: 'second' } },
  ], links: [] });
  const result = await wf.run();
  assert.equal(result.get('n1'), 'first');
  assert.equal(result.get(wf.outputs[1].key), 'second');
});

test('prototype-named node identities and friendly keys are retained as own data', async () => {
  const wf = Workflow.fromJSON({ nodes: [{ id: '__proto__', type: 'text', name: '__proto__', fields: { text: 'stored' } }], links: [] });
  const result = await wf.run(JSON.parse('{"__proto__":"supplied"}'));
  assert.equal(result.get('__proto__'), 'supplied');
  assert.ok(Object.hasOwn(result.nodes, '__proto__'));
  assert.ok(Object.hasOwn(result.outputs, '__proto__'));
});
