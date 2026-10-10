/**
 * 🔌 Custom endpoint — POST a NanoGPT-shaped body to a URL the graph names.
 * Twin of the editor/play helpers (index.html runEndpoint). The request goes
 * straight to that URL: never the NanoGPT client, never the API key.
 * Custom auth is only fields.auth. http is allowed for loopback and LAN;
 * a public host must be https.
 */
import { NanoodleError } from "./errors.mjs";
import { b64ImageMime, bytesToDataUrl } from "./media.mjs";

export const ENDPOINT_DEF_URL = "http://127.0.0.1:8787/v1/chat/completions";
export const ENDPOINT_MODES = ["chat", "image", "video", "audio", "json"];

export function endpointMode(n) {
  const m = String((n && n.fields && n.fields.mode) || "chat").toLowerCase();
  return ENDPOINT_MODES.includes(m) ? m : "chat";
}

export function endpointOutPort(n) {
  const m = endpointMode(n);
  if (m === "image") return { name: "image", type: "image" };
  if (m === "video") return { name: "video", type: "video" };
  if (m === "audio") return { name: "audio", type: "audio" };
  return { name: "text", type: "text" };
}

function endpointIsLoopbackHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function endpointIsPrivateIPv4(host) {
  const p = String(host || "").split(".");
  if (p.length !== 4) return false;
  if (!p.every((x) => /^\d+$/.test(x) && +x >= 0 && +x <= 255)) return false;
  const a = +p[0], b = +p[1];
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

export function endpointUrlOk(url) {
  const s = String(url || "").trim();
  if (!s) return "URL required — set the custom endpoint URL";
  let u;
  try { u = new URL(s); } catch {
    return "that URL isn’t allowed — use http://localhost, 127.0.0.1, a LAN host, or https";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return "that URL isn’t allowed — use http://localhost, 127.0.0.1, a LAN host, or https";
  }
  if (u.username || u.password) {
    return "that URL isn’t allowed — don’t put credentials in the URL; use the Authorization field";
  }
  if (u.protocol === "https:") return true;
  const host = u.hostname;
  if (endpointIsLoopbackHost(host) || endpointIsPrivateIPv4(host) || /\.local$/i.test(host)) return true;
  return "that URL isn’t allowed — http is only for localhost, 127.0.0.1, or a LAN host; use https for a public host";
}

function endpointHeaders(auth) {
  const headers = { "Content-Type": "application/json" };
  const a = String(auth || "").trim();
  if (a) headers.Authorization = /\s/.test(a) ? a : ("Bearer " + a);
  return headers;
}

function endpointPrompt(n, inp) {
  inp = inp || {};
  const v = inp.prompt != null ? inp.prompt : (inp.text != null ? inp.text : (n.fields && n.fields.prompt));
  return String(v == null ? "" : v).trim();
}

function endpointIsPath(s) {
  const raw = String(s == null ? "" : s).trim();
  if (!raw || raw.charAt(0) !== "/") return false;
  if (raw.length < 2) return false;
  if (/[\s\u00b7|\u2022]/.test(raw)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return false;
  return true;
}

function endpointJoinPath(base, path) {
  const u = new URL(String(base || "").trim());
  let p = String(path || "").trim();
  if (p.charAt(0) !== "/") p = "/" + p;
  const q = p.indexOf("?");
  if (q >= 0) { u.pathname = p.slice(0, q); u.search = p.slice(q); }
  else { u.pathname = p; u.search = ""; }
  return u.toString();
}

function endpointParseRoute(s) {
  const raw = String(s == null ? "" : s).trim();
  const out = {};
  if (!raw) return out;
  const low = raw.toLowerCase();
  if (ENDPOINT_MODES.includes(low)) { out.mode = low; return out; }
  let mode = "", rest = raw;
  for (const prefix of ENDPOINT_MODES) {
    if (!low.startsWith(prefix)) continue;
    const after = raw.slice(prefix.length);
    const ch = after.charAt(0);
    if (ch === "\u00b7" || ch === "|" || ch === ":" || ch === "\u2022" || ch === "-" || /\s/.test(ch)) {
      mode = prefix;
      rest = after.replace(/^[\s\u00b7|\u2022:\-]+/, "");
      break;
    }
  }
  rest = String(rest || "").replace(/\s+\([^)]*\)\s*$/, "").trim();
  let url = "";
  const m = rest.match(/https?:\/\/[^\s)]+/i);
  if (m) url = m[0].replace(/[.,;]+$/, "");
  if (mode) out.mode = mode;
  if (url) out.url = url;
  else if (endpointIsPath(rest)) out.path = rest;
  else if (!mode && endpointIsPath(raw)) out.path = raw;
  return out;
}

export function endpointResolveTarget(n, inp) {
  inp = inp || {};
  const hasFieldUrl = n && n.fields && Object.prototype.hasOwnProperty.call(n.fields, "url");
  const fieldUrl = hasFieldUrl ? n.fields.url : ENDPOINT_DEF_URL;
  const urlRaw = (inp.url != null && String(inp.url).trim() !== "") ? inp.url : fieldUrl;
  const modeRaw = (inp.mode != null && String(inp.mode).trim() !== "") ? inp.mode : (n && n.fields && n.fields.mode);
  const parsedUrl = endpointParseRoute(urlRaw);
  const parsedMode = endpointParseRoute(modeRaw);
  const parsedField = endpointParseRoute(fieldUrl);
  const path = parsedUrl.path || parsedMode.path;
  let resolvedUrl = parsedUrl;
  if (path && !parsedUrl.url) {
    const base = parsedField.url || String(fieldUrl == null ? "" : fieldUrl).trim();
    if (base && !endpointIsPath(base)) {
      try { resolvedUrl = { mode: parsedUrl.mode, url: endpointJoinPath(base, path) }; } catch { /* leave the raw path to fail urlOk */ }
    }
  }
  let url = resolvedUrl.url || String(urlRaw == null ? "" : urlRaw).trim();
  let mode;
  if (resolvedUrl.url && resolvedUrl.mode) mode = resolvedUrl.mode;
  else if (parsedMode.url && parsedMode.mode) { url = parsedMode.url; mode = parsedMode.mode; }
  else mode = parsedMode.mode || resolvedUrl.mode || (n && n.fields && n.fields.mode) || "chat";
  mode = ENDPOINT_MODES.includes(String(mode).toLowerCase()) ? String(mode).toLowerCase() : "chat";
  return { url, mode };
}

function endpointModel(n) {
  const m = String((n.fields && n.fields.model) || "").trim();
  return m || "local";
}

export function endpointRequestBody(mode, n, inp) {
  inp = inp || {};
  const model = endpointModel(n);
  if (mode === "chat") {
    const prompt = endpointPrompt(n, inp);
    const messages = [];
    const sys = String((n.fields && n.fields.system) || "").trim();
    if (sys) messages.push({ role: "system", content: sys });
    const imgs = inp.image ? (Array.isArray(inp.image) ? inp.image : [inp.image]) : [];
    const aud = inp.audio
      ? { type: "input_audio", input_audio: { data: String(inp.audio).replace(/^data:[^,]*,/, ""), format: "wav" } }
      : null;
    if (imgs.length || aud) {
      const parts = [{ type: "text", text: prompt || "" }];
      for (const url of imgs) parts.push({ type: "image_url", image_url: { url } });
      if (aud) parts.push(aud);
      messages.push({ role: "user", content: parts });
    } else {
      messages.push({ role: "user", content: prompt });
    }
    return { model, messages, temperature: 0.8 };
  }
  if (mode === "image") {
    const ib = { model, size: (n.fields && n.fields.size) || "1024x1024", n: 1, response_format: "b64_json" };
    const ip = endpointPrompt(n, inp);
    if (ip) ib.prompt = ip;
    if (inp.image) ib.imageDataUrl = inp.image;
    return ib;
  }
  if (mode === "video") {
    const vb = { model, prompt: endpointPrompt(n, inp) };
    if (inp.image) vb.imageDataUrl = inp.image;
    if (inp.video) {
      if (/^https?:/i.test(inp.video)) vb.videoUrl = inp.video;
      else vb.videoDataUrl = inp.video;
    }
    return vb;
  }
  if (mode === "audio") {
    const ab = { model, input: endpointPrompt(n, inp) };
    if (inp.audio) {
      if (/^https?:/i.test(inp.audio)) ab.audioUrl = inp.audio;
      else ab.audioDataUrl = inp.audio;
    }
    return ab;
  }
  const jb = {};
  if (inp.text != null && inp.text !== "") jb.text = inp.text;
  else {
    const tp = endpointPrompt(n, inp);
    if (tp) jb.text = tp;
  }
  if (inp.image) jb.image = inp.image;
  if (inp.video) jb.video = inp.video;
  if (inp.audio) jb.audio = inp.audio;
  return jb;
}

function endpointShapeHint(mode) {
  if (mode === "chat") return "OpenAI chat JSON { choices:[{ message:{ content } }] }";
  if (mode === "image") return "{ data:[{ b64_json }] } or { data:[{ url }] }";
  if (mode === "video") return '{ "url" } or NanoGPT { output: { video: { url } } }';
  if (mode === "audio") return '{ "url" } or a binary audio body';
  return '{ "text" } or { "data": ... }';
}

function endpointApiMessage(body) {
  try {
    const j = JSON.parse(String(body || "").replace(/^\d{3}:\s*/, ""));
    const err = j && j.error;
    let msg = (typeof err === "string" && err)
      || (err && typeof err.message === "string" && err.message)
      || (j && typeof j.message === "string" && j.message)
      || (j && typeof j.detail === "string" && j.detail)
      || (j && typeof j.title === "string" && j.title);
    msg = String(msg || "").replace(/\s+/g, " ").trim();
    return msg || null;
  } catch { return null; }
}

function endpointHttpError(status, body) {
  const extracted = endpointApiMessage(body);
  let hint = "";
  if (status === 404) hint = "check the custom endpoint URL";
  else if (status === 401 || status === 403) hint = "check the Authorization field";
  else if (status === 405) hint = "this endpoint must accept POST";
  else if (status === 413) hint = "payload too large; send a smaller body";
  else if (status === 415) hint = "send JSON (Content-Type: application/json)";
  if (extracted) return extracted + (hint ? " — " + hint : "");
  if (/<html|<body|<!doctype/i.test(String(body || ""))) {
    return status + " — the URL returned a web page, not JSON; check the custom endpoint URL";
  }
  if (hint) return status + " — " + hint;
  if (!String(body || "").replace(/\s+/g, "").trim()) {
    return status + " — the endpoint returned an error with no body; check the URL and mode";
  }
  if (/^\s*[{\[]/.test(String(body || ""))) {
    return status + " — the endpoint rejected the request (check URL, mode, and the posted JSON)";
  }
  return status + ": " + String(body).replace(/\s+/g, " ").trim().slice(0, 160);
}

function endpointNotJsonError(mode, ct, raw) {
  const sample = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (/<html|<body|<!doctype/i.test(raw || "") || /text\/html/i.test(ct || "")) {
    return "the endpoint returned a web page, not JSON — check the URL (it must POST " + endpointShapeHint(mode) + ")";
  }
  return "response is not JSON — return " + endpointShapeHint(mode) + (sample ? " (got: " + sample + ")" : "");
}

function endpointParseChat(j) {
  const msg = (j && j.choices && j.choices[0] && j.choices[0].message) || {};
  const txt = msg.content;
  if (txt == null) throw new NanoodleError("no text in response — return " + endpointShapeHint("chat"));
  return { text: typeof txt === "string" ? txt : txt.map((p) => p.text || "").join("") };
}

function endpointParseImage(j) {
  const urls = ((j && j.data) || []).map((d) => {
    if (d.b64_json) return "data:" + b64ImageMime(d.b64_json) + ";base64," + d.b64_json;
    return d.url;
  }).filter(Boolean);
  if (!urls.length) throw new NanoodleError("no image in response — return " + endpointShapeHint("image"));
  return { image: urls[0], images: urls };
}

function endpointParseVideo(j) {
  const out = (j && j.data && j.data.output) || (j && j.output) || {};
  const url = (j && (j.url || j.videoUrl))
    || (out.video && out.video.url)
    || out.url
    || (Array.isArray(out.video) ? (out.video[0] && out.video[0].url) : null)
    || (j && j.data && j.data.url);
  if (!url) throw new NanoodleError('no video url in response — return { "url" } or NanoGPT { output: { video: { url } } }');
  return { video: url };
}

function endpointParseAudioJson(j) {
  const url = (j && (j.url || j.audioUrl)) || (j && j.data && (j.data.url || j.data.audioUrl));
  if (!url) throw new NanoodleError('no audio url in response — return { "url" } or a binary audio body');
  return { audio: url };
}

function endpointLooksLikeEcho(j) {
  if (!j || typeof j !== "object") return false;
  const h = j.headers;
  if (!h || typeof h !== "object" || Array.isArray(h)) return false;
  if (!Object.prototype.hasOwnProperty.call(j, "data") && !Object.prototype.hasOwnProperty.call(j, "json")) return false;
  return j.url != null || j.origin != null || j.method != null;
}

function endpointJsonModeText(v) {
  if (typeof v === "string") {
    const s = v.trim();
    if (s) {
      try {
        const p = JSON.parse(s);
        if (p && typeof p === "object") return endpointJsonModeText(p);
      } catch { /* plain text */ }
    }
    return v;
  }
  if (v && typeof v === "object") {
    if (endpointLooksLikeEcho(v)) {
      const inner = (Object.prototype.hasOwnProperty.call(v, "json") && v.json != null) ? v.json : v.data;
      if (inner !== v) return endpointJsonModeText(inner);
    }
    if (v.text != null) return String(v.text);
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }
  return v == null ? "" : String(v);
}

function endpointParseJsonMode(j) {
  if (j && j.text != null && !endpointLooksLikeEcho(j)) return { text: String(j.text) };
  if (endpointLooksLikeEcho(j)) {
    return { text: endpointJsonModeText((Object.prototype.hasOwnProperty.call(j, "json") && j.json != null) ? j.json : j.data) };
  }
  if (j && Object.prototype.hasOwnProperty.call(j, "data")) return { text: endpointJsonModeText(j.data) };
  throw new NanoodleError('json mode expected { "text" } or { "data": ... } — not a chat/completions wrapper');
}

async function endpointParseResponse(mode, r) {
  const ct = (r.headers && r.headers.get && r.headers.get("content-type")) || "";
  if (mode === "audio" && !/json/i.test(ct)) {
    const bytes = new Uint8Array(await r.arrayBuffer());
    let mime = ct.split(";")[0].trim().toLowerCase();
    if (!mime || mime === "application/octet-stream" || mime === "binary/octet-stream") mime = "audio/mpeg";
    return { audio: bytesToDataUrl(bytes, mime) };
  }
  let raw = "";
  try { raw = await r.text(); } catch { raw = ""; }
  if (!String(raw).trim()) {
    throw new NanoodleError("empty response — the endpoint returned no body; check the URL and mode");
  }
  let j;
  try { j = JSON.parse(raw); } catch {
    throw new NanoodleError(endpointNotJsonError(mode, ct, raw));
  }
  if (mode === "chat") return endpointParseChat(j);
  if (mode === "image") return endpointParseImage(j);
  if (mode === "video") return endpointParseVideo(j);
  if (mode === "audio") return endpointParseAudioJson(j);
  return endpointParseJsonMode(j);
}

function endpointUrlIsLocal(url) {
  try {
    const u = new URL(String(url || "").trim());
    const host = u.hostname;
    return endpointIsLoopbackHost(host) || endpointIsPrivateIPv4(host) || /\.local$/i.test(host);
  } catch { return false; }
}

function endpointFetchIsOpaque(e) {
  const m = ((e && e.message) || String(e)).trim();
  if (/^(TypeError: )?(Failed to fetch|Load failed|NetworkError)/i.test(m)) return true;
  return !!(e && e.name === "TypeError" && /fetch|network|cors/i.test(m));
}

function endpointFetchError(e, url) {
  if (!endpointFetchIsOpaque(e)) return (e && e.message) || String(e);
  if (!endpointUrlIsLocal(url)) return "blocked by CORS — your server needs Access-Control-Allow-Origin";
  return "blocked — CORS (Access-Control-Allow-Origin + OPTIONS) or Chrome local-network permission";
}

/**
 * POST the mode's body and parse the reply.
 * @param {{ fetch?: typeof fetch, signal?: AbortSignal }} [io]
 */
export async function runEndpoint(n, inp, io = {}) {
  const target = endpointResolveTarget(n, inp || {});
  const url = target.url;
  const ok = endpointUrlOk(url);
  if (ok !== true) throw new NanoodleError(ok);
  const mode = target.mode;
  const body = endpointRequestBody(mode, n, inp || {});
  const headers = endpointHeaders(n.fields && n.fields.auth);
  const doFetch = io.fetch || globalThis.fetch;
  let r;
  try {
    r = await doFetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: io.signal });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new NanoodleError(endpointFetchError(e, url));
  }
  if (!r.ok) {
    let errBody = "";
    try { errBody = (await r.text()).slice(0, 800); } catch { /* ignore */ }
    throw new NanoodleError(endpointHttpError(r.status, errBody));
  }
  return endpointParseResponse(mode, r);
}
