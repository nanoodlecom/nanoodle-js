/**
 * render3d — local 3D rendering node support (Edge Styles S2).
 *
 * ONE scene implementation (render3d-assets/scene.html, three.js) renders a
 * GLB with the node's fields: camera azimuth/elevation/distance, a clip
 * plane (slice-3D), explode over the GLB's scene-graph parts, part
 * isolation, animation-clip stepping, turntable. In the browser app the
 * same module runs in-page; headless, this driver serves it to a local
 * Chromium (SwiftShader) and drives it over CDP with Node's built-in
 * WebSocket — no new dependencies. Chromium discovery mirrors the ffmpeg
 * contract: NANOODLE_CHROME / CHROME_PATH, the Playwright browser cache,
 * then PATH. Video mode assembles frames with ffmpeg (the local-media
 * heavy fallback, same as combine).
 */
import { NanoodleError } from "./errors.mjs";
import { abortReason, throwIfAborted } from "./deadline.mjs";
import { dataUrlBytes } from "./media.mjs";

let cp, fsp, os, path, http, loading;
function builtins() {
  return loading ??= Promise.all([
    import("node:child_process"), import("node:fs/promises"),
    import("node:os"), import("node:path"), import("node:http"),
  ]).then(modules => { [cp, fsp, os, path, http] = modules; });
}

const ASSET_DIR = new URL("./render3d-assets/", import.meta.url);
const SCENE_ASSETS = new Map([
  ["/scene.html", "text/html; charset=utf-8"],
  ["/three.module.js", "text/javascript"],
  ["/addons/loaders/GLTFLoader.js", "text/javascript"],
  ["/addons/environments/RoomEnvironment.js", "text/javascript"],
  ["/addons/utils/BufferGeometryUtils.js", "text/javascript"],
]);
const MAX_MODEL_BYTES = 64 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 120_000;

export async function findChromium() {
  await builtins();
  const { existsSync, readdirSync } = await import("node:fs");
  const env = process.env.NANOODLE_CHROME || process.env.CHROME_PATH;
  if (env && existsSync(env)) return env;
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  try {
    for (const d of readdirSync(cache).sort().reverse()) {
      for (const sub of ["chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux64/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const p = path.join(cache, d, sub);
        if (existsSync(p)) return p;
      }
    }
  } catch { /* no cache */ }
  for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
      const p = path.join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function noChromiumError() {
  return new NanoodleError(
    "render3d needs a Chromium binary (not found). Set NANOODLE_CHROME to one, " +
    "install Playwright's Chromium (npx playwright install chromium), or run this graph in the nanoodle browser app.");
}

/** Node fields (strings) → scene fields (typed). Exported for tests. */
export function render3dSceneFields(fields = {}) {
  const num = (v, def) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : def;
  };
  const out = {
    azimuth: num(fields.azimuth, 35),
    elevation: num(fields.elevation, 18),
    distance: num(fields.distance, 1.9),
    width: Math.max(16, Math.round(num(fields.width, 800))),
    height: Math.max(16, Math.round(num(fields.height, 600))),
    background: fields.background || "dark",
    explode: num(fields.explode, 0),
  };
  if (fields.clipAxis && fields.clipAxis !== "none") {
    out.clipAxis = fields.clipAxis;
    out.clipPos = num(fields.clipPos, 0);
  }
  if (fields.isolate !== undefined && fields.isolate !== null && String(fields.isolate).trim() !== "") {
    const raw = String(fields.isolate).trim();
    out.isolate = /^-?\d+$/.test(raw) ? parseInt(raw, 10) : raw;
  }
  if (fields.animClip != null && String(fields.animClip).trim() !== "") {
    out.animClip = /^-?\d+$/.test(String(fields.animClip).trim()) ? parseInt(fields.animClip, 10) : fields.animClip;
  }
  out.animTime = num(fields.animTime, 0);
  return out;
}

async function urlBytes(url, fetchFn, signal) {
  const oversized = () => new NanoodleError("render3d model exceeds 64 MiB");
  if (typeof url === "string" && url.startsWith("data:")) {
    if (url.length > MAX_MODEL_BYTES * 3 + 256) throw oversized();
    const { bytes } = dataUrlBytes(url);
    if (bytes.byteLength > MAX_MODEL_BYTES) throw oversized();
    return bytes;
  }
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new NanoodleError("render3d model must be a data: or HTTP(S) URL");
  const r = await (fetchFn || fetch)(url, { signal });
  if (!r.ok) throw new NanoodleError("render3d: could not download the model (" + r.status + ")");
  if (Number(r.headers.get("content-length")) > MAX_MODEL_BYTES) {
    await r.body?.cancel();
    throw oversized();
  }
  const parts = [];
  let total = 0;
  for await (const part of r.body ?? []) {
    throwIfAborted(signal);
    total += part.byteLength;
    if (total > MAX_MODEL_BYTES) throw oversized();
    parts.push(part);
  }
  return Buffer.concat(parts, total);
}

function serveScene(glbBytes) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const p = req.url === "/" ? "/scene.html" : req.url;
        const type = p === "/model.glb" ? "model/gltf-binary" : SCENE_ASSETS.get(p);
        if (req.method !== "GET" || !type) { res.writeHead(404); res.end(); return; }
        const body = p === "/model.glb" ? glbBytes : await fsp.readFile(new URL(p.slice(1), ASSET_DIR));
        res.writeHead(200, { "content-type": type, "x-content-type-options": "nosniff", "cache-control": "no-store" });
        res.end(body);
      } catch { res.writeHead(404); res.end(); }
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(server); });
  });
}

/** Minimal CDP client over the built-in WebSocket. */
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener("close", () => {
      for (const { rej } of this.pending.values()) rej(new NanoodleError("render3d: Chromium disconnected"));
      this.pending.clear();
    });
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    });
  }
  send(method, params = {}, sessionId) {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new NanoodleError("render3d: Chromium disconnected"));
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify(msg)); });
  }
}

async function launchScene(glbBytes, signal) {
  const exe = await findChromium();
  if (!exe) throw noChromiumError();
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), "nanoodle-render3d-profile-"));
  let server;
  try {
    server = await serveScene(glbBytes);
  } catch (error) {
    await fsp.rm(profile, { recursive: true, force: true });
    throw error;
  }
  const port = server.address().port;
  const child = cp.spawn(exe, [
    "--headless=new", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profile}`,
    "--no-sandbox", "--incognito", "--no-first-run", "--no-proxy-server", "--disable-background-networking",
    "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const exited = new Promise(resolve => child.once("close", resolve));
  let ws;
  let cleaning;
  const cleanup = () => cleaning ??= (async () => {
    signal.removeEventListener("abort", cleanup);
    try { ws?.close(); } catch { /* gone */ }
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    server.close();
    server.closeAllConnections();
    await exited;
    await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
  })();
  signal.addEventListener("abort", cleanup, { once: true });
  try {
    throwIfAborted(signal);
    const wsUrl = await new Promise((res, rej) => {
      let buf = "";
      const to = setTimeout(() => rej(new NanoodleError("render3d: Chromium did not start in time")), 30000);
      child.stderr.on("data", (d) => {
        buf = (buf + d).slice(-8192);
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
        if (m) { clearTimeout(to); res(m[1]); }
      });
      child.on("exit", () => { clearTimeout(to); rej(new NanoodleError("render3d: Chromium exited during startup")); });
      child.on("error", () => { clearTimeout(to); rej(new NanoodleError("render3d: could not launch Chromium")); });
    });
    throwIfAborted(signal);
    ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", rej, { once: true });
      ws.addEventListener("close", () => rej(new NanoodleError("render3d: Chromium disconnected")), { once: true });
    });
    const cdp = new Cdp(ws);
    const { targetId } = await cdp.send("Target.createTarget", { url: `http://127.0.0.1:${port}/scene.html` });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const evaluate = async (expression) => {
      // The target's first navigation can destroy the initial execution
      // context mid-evaluate (reported either as a protocol error or as
      // exceptionDetails); retry those, surface everything else.
      for (let attempt = 0; ; attempt++) {
        let r;
        try {
          r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
        } catch (e) {
          if (/Execution context was destroyed|Cannot find context/i.test(e.message || "") && attempt < 20) {
            await new Promise((done) => setTimeout(done, 250));
            continue;
          }
          throw e;
        }
        if (!r.exceptionDetails) return r.result && r.result.value;
        const desc = (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || "unknown";
        if (/Execution context was destroyed|Cannot find context/i.test(desc) && attempt < 20) {
          await new Promise((done) => setTimeout(done, 250));
          continue;
        }
        throw new NanoodleError("render3d scene error: " + desc);
      }
    };
    const ready = await evaluate(`new Promise((res) => { const t = setInterval(() => {
      if (window.__render3d && window.__render3d.error) { clearInterval(t); res("error:" + window.__render3d.error); }
      else if (window.__render3d && window.__render3d.ready) { clearInterval(t); res("ready"); }
    }, 50); })`);
    if (ready !== "ready") throw new NanoodleError("render3d: " + ready);
    return { evaluate, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

async function renderFrame(evaluate, sceneFields) {
  await evaluate(`window.__render3d.apply(${JSON.stringify(sceneFields)})`);
  const dataUrl = await evaluate(`document.getElementById("c").toDataURL("image/png")`);
  return Buffer.from(String(dataUrl).split(",")[1], "base64");
}

function runProc(bin, args, signal) {
  throwIfAborted(signal);
  return new Promise((res, rej) => {
    const child = cp.spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", (d) => { err = (err + d).slice(-1024); });
    child.on("error", () => rej(new NanoodleError("render3d video mode needs ffmpeg on PATH (not found). Install ffmpeg, or use image mode.")));
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) rej(abortReason(signal));
      else if (code === 0) res();
      else rej(new NanoodleError("ffmpeg failed: " + err.slice(-300)));
    });
  });
}

/**
 * Render a model. fields.mode "image" (default) → { image } PNG data URL.
 * fields.mode "video" → { video } MP4 data URL: frames sweep the turntable
 * (fields.turntable degrees, default 360) or the named clip's timeline,
 * at fields.fps over fields.duration seconds.
 */
export async function render3dMedia(modelUrl, fields = {}, { fetch: fetchFn, signal, onProgress } = {}) {
  await builtins();
  if (!modelUrl) throw new NanoodleError("render3d: no model input");
  const base = render3dSceneFields(fields);
  if (base.width > 2048 || base.height > 2048) throw new NanoodleError("render3d dimensions must be 16–2048 pixels");
  const mode = fields.mode === "video" ? "video" : "image";
  const fps = Math.round(Number(fields.fps ?? 24));
  const duration = Number(fields.duration ?? 2);
  const frames = Math.max(2, Math.round(fps * duration));
  if (mode === "video" && (!Number.isFinite(fps) || fps < 1 || fps > 60 ||
      !Number.isFinite(duration) || duration < 0.1 || duration > 10 || frames > 240 ||
      base.width * base.height * frames > 200_000_000 || base.width % 2 || base.height % 2)) {
    throw new NanoodleError("render3d video needs even dimensions, 1–60 fps, 0.1–10 seconds, at most 240 frames and 200 million pixels");
  }
  const deadline = AbortSignal.timeout(RENDER_TIMEOUT_MS);
  const renderSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let close;
  try {
    throwIfAborted(renderSignal);
    const glb = await urlBytes(typeof modelUrl === "object" ? modelUrl?.url : modelUrl, fetchFn, renderSignal);
    const { evaluate, cleanup } = await launchScene(glb, renderSignal);
    close = cleanup;
    if (mode === "image") {
      const png = await renderFrame(evaluate, base);
      return { image: "data:image/png;base64," + png.toString("base64") };
    }
    const turntable = fields.turntable === undefined ? 360 : parseFloat(fields.turntable) || 0;
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nanoodle-render3d-"));
    try {
      for (let i = 0; i < frames; i++) {
        throwIfAborted(renderSignal);
        const t = i / (frames - 1);
        const f = { ...base };
        if (turntable) f.azimuth = base.azimuth + turntable * t;
        if (base.animClip !== undefined) f.animTime = duration * t;
        if (fields.clipSweep === true || fields.clipSweep === "true") f.clipPos = 1.05 - 2.1 * t;
        if (onProgress && (i === 0 || i === frames - 1)) onProgress(`rendering frame ${i + 1}/${frames}…`);
        const png = await renderFrame(evaluate, f);
        await fsp.writeFile(path.join(dir, `frame-${String(i).padStart(3, "0")}.png`), png);
      }
      const outPath = path.join(dir, "out.mp4");
      await runProc("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", path.join(dir, "frame-%03d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", outPath], renderSignal);
      const mp4 = await fsp.readFile(outPath);
      return { video: "data:video/mp4;base64," + mp4.toString("base64") };
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    if (deadline.aborted) throw new NanoodleError("render3d exceeded the two-minute limit", { code: "timeout" });
    throw error;
  } finally { await close?.(); }
}
