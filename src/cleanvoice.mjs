/**
 * 🎧 Clean voice — strip background noise / music, keep the voice.
 * Twin of the editor/play block (nanoodle #709). NanoGPT's noise_reduction
 * models (ElevenLabs Audio Isolation, VEED Clean Audio) ride
 * POST /api/v1/audio/speech with { model, audio:<public URL>, duration }
 * and answer 202 + runId (charged up front) → GET /api/tts/status → hosted audio.
 * The source MUST be a public http(s) URL: data: and blob: are refused before
 * any request. duration is only a quote; the server re-measures and bills that.
 */
import { NanoodleError } from "./errors.mjs";

export const CLEANVOICE_DEFAULT_MODEL = "elevenlabs/audio-isolation"; // $0.121/min
export const CLEANVOICE_FALLBACK_SECS = 60; // length unknown → quote a minute
const CLEANVOICE_VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi)(\?|#|$)/i;

/** Which file to clean: a wired audio clip, else a wired video, else the pasted link. */
export function cleanVoiceSource(inp, f) {
  const a = inp && typeof inp.audio === "string" ? inp.audio.trim() : "";
  const v = inp && typeof inp.video === "string" ? inp.video.trim() : "";
  const link = String((f && f.url) || "").trim();
  const url = a || v || link;
  const video = a ? false : (v ? true : CLEANVOICE_VIDEO_EXT.test(link));
  if (!url) throw new NanoodleError("no audio — wire audio or a video in, or paste a public link to the recording");
  if (!/^https?:\/\//i.test(url)) {
    throw new NanoodleError(
      "Clean voice needs a hosted file — NanoGPT downloads it from a public link, and a clip uploaded or made in your browser has none. Wire a generated video or track, or paste a public https link to the recording.");
  }
  return { url, video };
}

/** Duration quote NanoGPT requires (0.6–3600 s); unknown → CLEANVOICE_FALLBACK_SECS. */
export function cleanVoiceSeconds(secs) {
  const s = +secs;
  if (!isFinite(s) || s <= 0) return CLEANVOICE_FALLBACK_SECS;
  return Math.min(3600, Math.max(0.6, Math.round(s * 100) / 100));
}

export function cleanVoiceExtra(url, secs) {
  return { audio: url, duration: cleanVoiceSeconds(secs) };
}

/** Seconds the cost forecast assumes: the wired source node's duration knob, else 30 s. */
export function cleanVoiceEstSeconds(srcFields) {
  const d = parseFloat(srcFields && srcFields.duration);
  return (isFinite(d) && d > 0) ? d : 30;
}

/** NanoGPT's 400s, reworded into the fix. Unrelated errors (and aborts) pass through. */
export function cleanVoiceError(e) {
  if (e && (e.name === "AbortError" || e.code === "aborted")) return e;
  const m = String((e && e.message) || e || "");
  if (/verify the source (audio )?duration/i.test(m)) {
    return new NanoodleError("NanoGPT couldn't read this file's length — use MP3, WAV, M4A/AAC or MP4 (OGG isn't accepted).");
  }
  if (/unable to download/i.test(m)) {
    return new NanoodleError("NanoGPT couldn't download the file — the link must be public (no sign-in, not expired).");
  }
  if (/public http\(?s?\)? source/i.test(m)) {
    return new NanoodleError("Clean voice needs a public https link — clips uploaded in the browser can't reach it.");
  }
  return e;
}

/**
 * The source's length from media metadata. Browsers can read it without CORS;
 * Node has no media element, so this resolves null and the quote falls back to
 * CLEANVOICE_FALLBACK_SECS (the server re-measures before billing).
 */
export function cleanVoiceMediaSeconds(url, isVideo) {
  return new Promise((res) => {
    const doc = globalThis.document;
    if (!doc || typeof doc.createElement !== "function") { res(null); return; }
    let el = null;
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      try { el.removeAttribute("src"); el.load(); } catch { /* element may already be gone */ }
      res(v);
    };
    try { el = doc.createElement(isVideo ? "video" : "audio"); }
    catch { res(null); return; }
    el.preload = "metadata";
    el.muted = true;
    el.onloadedmetadata = () => {
      const d = el.duration;
      fin(isFinite(d) && d > 0 ? d : null);
    };
    el.onerror = () => fin(null);
    setTimeout(() => fin(null), 10000);
    el.src = url;
  });
}

/** send(model, extra) → audio URL (the runtime's audio submit + poll). */
export async function cleanVoiceRun(model, inp, f, send) {
  const src = cleanVoiceSource(inp, f);
  const secs = await cleanVoiceMediaSeconds(src.url, src.video);
  try {
    return { audio: await send(model || CLEANVOICE_DEFAULT_MODEL, cleanVoiceExtra(src.url, secs)) };
  } catch (e) {
    throw cleanVoiceError(e);
  }
}
