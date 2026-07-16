import { NanoodleError } from "./errors.mjs";
import { IMG_PORT_RE, EDIT_IMG_RE, REF_PORT_RE, CLIP_PORT_RE, VID_PORT_RE } from "./graph.mjs";
import { MEDIA_INLINE_MAX } from "./media.mjs";
import {
  resizeCropImage, trimAudioToWav, extractAudioToWav,
  extractVideoFrames, concatVideos, muxSoundtrack, maskToSource,
} from "./local-media.mjs";

function mdl(n) {
  const m = String((n.fields && n.fields.model) || "").trim();
  if (!m) throw new NanoodleError(`pick a model first (node ${n.id})`);
  return m; // model strings pass through VERBATIM — endpoint choice is by node TYPE
}

/** Local-media opts from the workflow ctx (custom fetch + AbortSignal). */
function mediaOpts(ctx) {
  if (!ctx) return {};
  return {
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
}

function portIdx(name) {
  const m = /(\d+)$/.exec(name);
  return m ? +m[1] : 1;
}

function collectPorts(inp, re) {
  return Object.keys(inp)
    .filter((k) => re.test(k))
    .sort((a, b) => portIdx(a) - portIdx(b))
    .map((k) => inp[k])
    .filter(Boolean);
}

function promptOf(n, inp, errMsg) {
  const raw = inp.prompt != null ? inp.prompt : n.fields.prompt != null ? n.fields.prompt : "";
  const p = String(raw).trim();
  if (!p && errMsg) throw new NanoodleError(errMsg);
  return p;
}

/**
 * Wired audio data: URL → OpenAI-style inline input_audio part (base64 body, no data: prefix).
 * Callers must inline https URLs first (ctx.fetchMedia) — the spec mandates base64 bytes, and
 * shipping a raw URL string as "base64 data" makes a paid call with garbage audio.
 */
function audioInputPart(url) {
  if (typeof url !== "string" || !url) return null;
  if (!/^data:/i.test(url)) {
    throw new NanoodleError("audio input must be a data: URL — download the clip and inline it before building the chat part");
  }
  if (url.length > MEDIA_INLINE_MAX) {
    throw new NanoodleError("audio clip is too large to inline (~4 MB send limit) — use a shorter clip");
  }
  const comma = url.indexOf(",");
  const head = comma >= 0 ? url.slice(0, comma) : "";
  const data = comma >= 0 ? url.slice(comma + 1) : url;
  const mt = head.match(/data:([^;]+)/);
  let fmt = ((mt && mt[1] ? mt[1].split("/")[1] : "") || "wav").toLowerCase();
  if (fmt === "mpeg" || fmt === "mp3") fmt = "mp3";
  else if (fmt === "x-wav" || fmt === "wave") fmt = "wav";
  return { type: "input_audio", input_audio: { data, format: fmt } };
}

function llmOpts(n) {
  const f = n.fields, o = {};
  if (f.temperature != null && f.temperature !== "") o.temperature = +f.temperature;
  if (f.maxTokens) o.max_tokens = +f.maxTokens;
  if (f.format === "JSON") o.response_format = { type: "json_object" };
  if (f.reasoningEffort && f.reasoningEffort !== "default") o.reasoning_effort = f.reasoningEffort;
  if (f.showThinking === true || f.showThinking === "true") o.showThinking = true;
  return o;
}

/* ---------- LoRA (image/video style adapters) — verbatim behavior from the app runtime ----------
   HuggingFace + any direct .safetensors URL; the URL is forwarded to NanoGPT and pulled
   server-side. CivitAI links are signed/login-gated, so we reject them with guidance BEFORE
   the paid call instead of eating a charged 422. */
function normalizeLoraUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) return "";
  if (/\b(civitai\.com|civitai\.red|civit\.ai)\b/i.test(u)) {
    throw new NanoodleError("CivitAI links can't be fetched directly — download the .safetensors and re-host it (e.g. on HuggingFace), then paste that URL.");
  }
  if (/(^|\/\/|\.)huggingface\.co\//i.test(u)) {
    u = u.replace("/blob/", "/resolve/");
    if (!/\/resolve\/.+\.safetensors(\?|$)/i.test(u)) {
      throw new NanoodleError("Link the .safetensors file on HuggingFace: open it and use Copy download link (…/resolve/main/your-lora.safetensors).");
    }
    return u;
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(u)) {
    throw new NanoodleError("That looks like a HuggingFace repo id — open the .safetensors file and copy its download link (…/resolve/main/your-lora.safetensors).");
  }
  if (!/^https?:\/\//i.test(u)) {
    throw new NanoodleError("LoRA must be a direct https URL to a .safetensors file (HuggingFace or any host).");
  }
  return u;
}

function loraFamily(model) {
  const m = String(model || "");
  if (/spicy/i.test(m)) return null;
  if (/p-image/i.test(m)) return "pimage";
  if (/klein/i.test(m)) return "flux2klein";
  if (/flux-2/i.test(m)) return "flux2dev";
  if (/z-image/i.test(m)) return "zimage";
  if (/ltx/i.test(m)) return "ltx";
  if (/lora/i.test(m)) return "flux";
  return null;
}

function loraKind(type) { return (type === "image" || type === "edit" || type === "inpaint") ? "image" : "video"; }

function imageTakesLora(id) {
  id = String(id || "");
  if (/inpaint/i.test(id)) return false;
  if (/klein/i.test(id)) return true;
  return /(^|[-\/])lora($|[-\/])/i.test(id);
}

// name-based check (video by family, image by allow-list) — the editor already gated LoRA
// input to truly lora-capable models, so this stays in lockstep without a live catalog
function modelTakesLora(kind, id) {
  if (!id || loraFamily(id) == null) return false;
  return kind === "video" ? true : imageTakesLora(id);
}

function loraCap(model) {
  switch (loraFamily(model)) {
    case "flux2dev": return 4;
    case "flux2klein": case "zimage": case "ltx": return 3;
    default: return 1; // flux-lora, pimage — single slot
  }
}

function nodeLoras(n) {
  if (Array.isArray(n.fields.loras)) return n.fields.loras;
  if ((n.fields.loraUrl || "").trim() || (n.fields.loraStrength || "") !== "") {
    return [{ url: n.fields.loraUrl || "", strength: n.fields.loraStrength || "" }]; // legacy single-slot fields
  }
  return [];
}

function loraBodyFor(model, items) {
  const fam = loraFamily(model), sc = (v) => (isNaN(v) ? 1 : v);
  if (fam === "pimage") return { lora_weights: items[0].url, lora_scale: sc(items[0].scale) };
  if (fam === "flux2dev" || fam === "flux2klein" || fam === "zimage" || fam === "ltx") {
    const b = {};
    items.forEach((it, i) => { b["lora_url_" + (i + 1)] = it.url; b["lora_scale_" + (i + 1)] = sc(it.scale); });
    return b;
  }
  if (items.length === 1) return { lora_url: items[0].url, lora_strength: sc(items[0].scale) };
  return { loras: items.map((it) => ({ path: it.url, scale: sc(it.scale) })) };
}

/** LoRA body params for a node (SPEC-engine "+ LoRA params"): {} when the model takes none. */
export function loraParams(n) {
  if (!modelTakesLora(loraKind(n.type), n.fields.model)) return {};
  const rows = nodeLoras(n).filter((r) => r && (r.url || "").trim());
  if (!rows.length) return {};
  const items = rows.slice(0, loraCap(n.fields.model)).map((r) => ({
    url: normalizeLoraUrl(r.url),
    scale: (r.strength == null || r.strength === "") ? 1 : Number(r.strength),
  }));
  return loraBodyFor(n.fields.model, items);
}

/* ---------- custom-civitai AIR normalization/validation (pre-charge, mirrors the app) ---------- */
function normalizeCustomCivitaiAir(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^civitai:\d+@\d+/i.test(s)) return s.replace(/^civitai:/i, "civitai:");
  if (/^persona:\d+@\d+/i.test(s)) return s.replace(/^persona:/i, "persona:");
  if (/^runware:[^\s@]+@[^\s@]+$/i.test(s)) return s.replace(/^runware:/i, "runware:");
  const bare = /^(\d+)@(\d+)$/.exec(s);
  if (bare) return "civitai:" + bare[1] + "@" + bare[2];
  const mid = /civitai\.com\/models\/(\d+)/i.exec(s);
  const vid = /[?&]modelVersionId=(\d+)/i.exec(s);
  if (mid && vid) return "civitai:" + mid[1] + "@" + vid[1];
  return s;
}

function isValidCustomAir(air) {
  return /^(civitai:\d+@\d+|persona:\d+@\d+|runware:[^\s@]+@[^\s@]+)$/i.test(air);
}

/** Per-call image extras: LoRA params + fixed seed (when numeric) + custom-civitai AIR. */
function imgExtra(n) {
  const e = loraParams(n);
  const s = n.fields.seed;
  if (s != null && String(s).trim() !== "" && !isNaN(Number(s))) e.seed = Number(s);
  if (n.fields.model === "custom-civitai") {
    const air = normalizeCustomCivitaiAir(n.fields.customCivitaiAir);
    if (!air) throw new NanoodleError("select a CivitAI model — pick a preset or paste an AIR (civitai:/runware:/persona:…)");
    if (!isValidCustomAir(air)) {
      throw new NanoodleError("AIR must look like civitai:MODEL@VERSION, runware:id@rev, or persona:MODEL@VERSION");
    }
    e.customCivitaiAir = air;
  }
  return e;
}

/** Video dims under the standard wire names (no catalog in v1 → no per-model renames). */
function videoDims(n) {
  const out = {};
  const f = n.fields;
  if (f.resolution != null && f.resolution !== "") out.resolution = f.resolution;
  if (f.aspect != null && f.aspect !== "") out.aspect_ratio = f.aspect;
  if (f.duration != null && f.duration !== "") out.duration = f.duration;
  return out;
}

function videoSourceOpts(url) {
  return /^https?:/i.test(url) ? { videoUrl: url } : { videoDataUrl: url };
}

function audioSourceOpts(url) {
  return /^https?:/i.test(url) ? { audioUrl: url } : { audioDataUrl: url };
}

const nonEmpty = (v) => v != null && String(v).trim() !== "";

/**
 * Faithful to the app's collectAudioParams: only-when-nonempty, defaults omitted,
 * then fields.extraJson merged verbatim last. (Catalog gating: skipped in v1.)
 */
function audioParams(n) {
  const f = n.fields, body = {};
  const num = (v) => { const x = Number(v); return isNaN(x) ? null : x; };
  if (n.type === "music") {
    if (nonEmpty(f.lyrics)) body.lyrics = f.lyrics;
    if (f.instrumental === true || f.instrumental === "true") body.instrumental = true;
    if (nonEmpty(f.duration) && num(f.duration) != null) body.duration = num(f.duration);
    if (nonEmpty(f.negative_prompt)) body.negative_prompt = f.negative_prompt;
    if (nonEmpty(f.seed) && num(f.seed) != null) body.seed = num(f.seed);
    if (nonEmpty(f.response_format) && f.response_format !== "mp3") body.response_format = f.response_format;
  } else if (n.type === "tts") {
    if (nonEmpty(f.voice)) body.voice = f.voice;
    if (nonEmpty(f.speed) && num(f.speed) != null && num(f.speed) !== 1) body.speed = num(f.speed); // omit when 1
    if (nonEmpty(f.instructions)) body.instructions = f.instructions;
    if (nonEmpty(f.response_format) && f.response_format !== "mp3") body.response_format = f.response_format;
  } else if (n.type === "remix") {
    if (nonEmpty(f.lyrics)) body.lyrics = f.lyrics;
    if (nonEmpty(f.duration) && num(f.duration) != null) body.duration = num(f.duration);
    if (nonEmpty(f.response_format) && f.response_format !== "mp3") body.response_format = f.response_format;
  }
  if ((f.extraJson || "").trim()) {
    try { Object.assign(body, JSON.parse(f.extraJson)); }
    catch { throw new NanoodleError("advanced params: invalid JSON in extraJson"); }
  }
  // Re-enforce the surface-one-track contract AFTER extraJson (twin of the app runtime): advanced
  // params can reintroduce number_of_songs / generation_count / n and bill N songs while the runner
  // only keeps the single returned URL. Drop every song-count key (omit = one track at the model
  // default). remix shares the extraJson escape hatch and surfaces one URL too — same clamp.
  if (n.type === "music" || n.type === "remix") {
    for (const k of Object.keys(body)) {
      if (/^(number_of_songs|n|num_songs|song_count|generation_count|generation_count_parameter)$/i.test(k)
        || /generation_count|num_?songs|song_?count/i.test(k)) delete body[k];
    }
  }
  return body;
}

function chatMessages(n, prompt, imgs, audioPart) {
  const messages = [];
  if ((n.fields.system || "").trim()) messages.push({ role: "system", content: n.fields.system.trim() });
  messages.push(imgs.length || audioPart
    ? {
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...imgs.map((url) => ({ type: "image_url", image_url: { url } })),
          ...(audioPart ? [audioPart] : []),
        ],
      }
    : { role: "user", content: prompt });
  return messages;
}

function guardRefsSize(imgs) {
  if (imgs.reduce((s, u) => s + (u ? u.length : 0), 0) > MEDIA_INLINE_MAX) {
    throw new NanoodleError("reference images too large (~4 MB combined limit) — use fewer or smaller images");
  }
}

/**
 * Per-node executors. Each: async run(node, inp, ctx) → out map keyed by output port name.
 * `node.fields` already carries wired field overrides + user inputs + settings.
 * ctx = { chat, chatImage, image, video, audio, transcribe, progress } (cost/poll wired by the engine).
 */
export const RUNNERS = {
  async text(n) { return { text: n.fields.text || "" }; },

  async upload(n) {
    if (!n.fields.image) throw new NanoodleError("no image — this Image input has no image");
    return { image: n.fields.image };
  },
  async aupload(n) {
    if (!n.fields.audio) throw new NanoodleError("no audio — this Audio input has no clip");
    return { audio: n.fields.audio };
  },
  async vupload(n) {
    if (!n.fields.video) throw new NanoodleError("no video — this Video input has no clip");
    return { video: n.fields.video };
  },

  async choice(n) {
    const opts = String(n.fields.options || "").split("\n").map((s) => s.trim()).filter(Boolean);
    const sel = n.fields.selected;
    const val = sel != null && opts.indexOf(sel) >= 0 ? sel : opts[0] || "";
    if (!val) throw new NanoodleError("no options — this Choice has no options to pick from");
    return { text: val };
  },

  async join(n, inp) {
    const sep = (n.fields.sep != null ? n.fields.sep : " ").replace(/\\n/g, "\n");
    return { text: [inp.a, inp.b].filter((v) => v != null && v !== "").join(sep) };
  },

  // ---- local media (pure-JS first like the browser; ffmpeg soft fallback) ----

  async resize(n, inp, ctx) {
    if (!inp.image) throw new NanoodleError("no image input");
    const media = mediaOpts(ctx);
    return {
      image: await resizeCropImage(inp.image, n.fields.mode || "fit", n.fields.width, n.fields.height, media),
    };
  },

  async vframes(n, inp, ctx) {
    if (!inp.video) throw new NanoodleError("no video input");
    const media = mediaOpts(ctx);
    return extractVideoFrames(inp.video, {
      count: n.fields.frames,
      gap: n.fields.gap,
      dir: n.fields.dir || "end",
      ...media,
      onProgress: ctx && ctx.progress,
    });
  },

  async combine(n, inp, ctx) {
    // Browser wires vid1..; some docs/saves use clip1.. — accept both, ordered by port number
    // (not CLIP-then-VID, which reorders mixed graphs).
    const keys = Object.keys(inp)
      .filter((k) => CLIP_PORT_RE.test(k) || VID_PORT_RE.test(k))
      .sort((a, b) => portIdx(a) - portIdx(b) || a.localeCompare(b));
    const clips = [];
    const seen = new Set();
    for (const k of keys) {
      const v = inp[k];
      if (!v || seen.has(v)) continue;
      seen.add(v);
      clips.push(v);
    }
    if (clips.length < 2) throw new NanoodleError("wire at least two clips to combine");
    const dedup = n.fields.dedup == null ? true
      : !(n.fields.dedup === false || n.fields.dedup === "false" || n.fields.dedup === 0 || n.fields.dedup === "0");
    const media = mediaOpts(ctx);
    return { video: await concatVideos(clips, dedup, { ...media, onProgress: ctx && ctx.progress }) };
  },

  async soundtrack(n, inp, ctx) {
    if (!inp.video) throw new NanoodleError("no video input");
    if (!inp.audio) throw new NanoodleError("no audio input");
    const loop = n.fields.loop === true || n.fields.loop === "true" || n.fields.loop === 1 || n.fields.loop === "1";
    const media = mediaOpts(ctx);
    return { video: await muxSoundtrack(inp.video, inp.audio, loop, { ...media, onProgress: ctx && ctx.progress }) };
  },

  async trim(n, inp, ctx) {
    if (!inp.audio) throw new NanoodleError("no audio input");
    const start = parseFloat(n.fields.start) || 0;
    const length = parseFloat(n.fields.length);
    return { audio: await trimAudioToWav(inp.audio, start, Number.isFinite(length) ? length : 30, 16000, mediaOpts(ctx)) };
  },

  async extractaudio(n, inp, ctx) {
    if (!inp.video) throw new NanoodleError("no video input");
    const start = parseFloat(n.fields.start) || 0;
    const lenRaw = parseFloat(n.fields.length);
    const length = (Number.isFinite(lenRaw) && lenRaw > 0) ? lenRaw : 0;
    return { audio: await extractAudioToWav(inp.video, start, length, 16000, mediaOpts(ctx)) };
  },

  async llm(n, inp, ctx) {
    const prompt = promptOf(n, inp, "no prompt");
    const imgs = collectPorts(inp, IMG_PORT_RE);
    // hosted audio (music/tts nodes return https CDN URLs verbatim) → download + inline as base64:
    // the chat input_audio part carries bytes, never a URL
    const audioSrc = inp.audio && /^https?:/i.test(inp.audio) ? await ctx.fetchMedia(inp.audio) : inp.audio;
    const audioPart = audioSrc ? audioInputPart(audioSrc) : null;
    const messages = chatMessages(n, prompt, imgs, audioPart);
    return { text: await ctx.chat(messages, mdl(n), llmOpts(n)) };
  },

  async vision(n, inp, ctx) {
    if (!inp.image) throw new NanoodleError("no image input");
    const q = (n.fields.q || "Describe this image.").trim();
    const messages = [{
      role: "user",
      content: [{ type: "text", text: q }, { type: "image_url", image_url: { url: inp.image } }],
    }];
    return { text: await ctx.chat(messages, mdl(n), {}) };
  },

  async image(n, inp, ctx) {
    const prompt = promptOf(n, inp, "no prompt");
    const want = Math.max(1, parseInt(n.fields.variations, 10) || 1);
    const urls = await ctx.image({ prompt, model: mdl(n), size: n.fields.size || "1024x1024", extra: imgExtra(n), n: want, multi: true });
    const sel = Math.min(Math.max(0, parseInt(n.fields.sel, 10) || 0), urls.length - 1);
    return { image: urls[sel], images: urls };
  },

  async edit(n, inp, ctx) {
    const imgs = collectPorts(inp, EDIT_IMG_RE);
    if (!imgs.length) throw new NanoodleError("no image input");
    const prompt = promptOf(n, inp);
    if (!prompt && !/upscal/i.test(n.fields.model || "")) throw new NanoodleError("no edit instruction");
    guardRefsSize(imgs);
    const src = imgs.length > 1 ? imgs : imgs[0]; // array → multi-image composite; string → single edit
    return { image: await ctx.image({ prompt, model: mdl(n), size: n.fields.size || "1024x1024", imageDataUrl: src, extra: imgExtra(n) }) };
  },

  async draw(n, inp, ctx) {
    const prompt = promptOf(n, inp, "no prompt");
    const imgs = collectPorts(inp, IMG_PORT_RE);
    guardRefsSize(imgs);
    const messages = chatMessages(n, prompt, imgs, null);
    const res = await ctx.chatImage(messages, mdl(n), {});
    const sel = Math.min(Math.max(0, parseInt(n.fields.sel, 10) || 0), res.images.length - 1);
    const showThinking = n.fields.showThinking !== false && n.fields.showThinking !== "false";
    const text = showThinking && res.reasoning
      ? "```thinking\n" + res.reasoning + "\n```\n\n" + (res.text || "")
      : res.text;
    return { image: res.images[sel], images: res.images, text };
  },

  async inpaint(n, inp, ctx) {
    const source = inp.image != null ? inp.image : n.fields.image;
    const rawMask = inp.mask != null ? inp.mask : n.fields.mask;
    if (!source) throw new NanoodleError("no image — supply the image to repaint");
    if (!rawMask) throw new NanoodleError("no mask — supply a B/W mask (white = repaint)");
    const prompt = promptOf(n, inp, "no prompt — say what to paint into the masked area");
    // Match play.html maskToSource: composite mask onto black at the source's pixel size.
    const mask = await maskToSource(rawMask, source, mediaOpts(ctx));
    return { image: await ctx.image({ prompt, model: mdl(n), size: n.fields.size || "1024x1024", imageDataUrl: source, maskDataUrl: mask, extra: imgExtra(n) }) };
  },

  async tvideo(n, inp, ctx) {
    const prompt = promptOf(n, inp, "no prompt");
    const opts = { ...videoDims(n), lora: loraParams(n), extra: n.fields.modelOpts || {} };
    const refs = collectPorts(inp, REF_PORT_RE);
    if (refs.length) { opts.refImages = refs; opts.refKey = "reference_images"; }
    return { video: await ctx.video(mdl(n), prompt, opts, null) };
  },

  async ivideo(n, inp, ctx) {
    if (!inp.image) throw new NanoodleError("no image input");
    const prompt = promptOf(n, inp);
    const opts = { ...videoDims(n), lora: loraParams(n), extra: n.fields.modelOpts || {} };
    if (inp.endframe) opts.last_image = inp.endframe;
    return { video: await ctx.video(mdl(n), prompt, opts, inp.image) };
  },

  async vedit(n, inp, ctx) {
    if (!inp.video) throw new NanoodleError("no video input");
    const prompt = promptOf(n, inp);
    const opts = { ...videoSourceOpts(inp.video), ...videoDims(n), lora: loraParams(n), extra: n.fields.modelOpts || {} };
    return { video: await ctx.video(mdl(n), prompt, opts, null) };
  },

  async lipsync(n, inp, ctx) {
    if (!inp.image) throw new NanoodleError("no image input");
    if (!inp.audio) throw new NanoodleError("no audio input");
    const prompt = promptOf(n, inp);
    const opts = { ...audioSourceOpts(inp.audio), ...videoDims(n), extra: n.fields.modelOpts || {} };
    return { video: await ctx.video(mdl(n), prompt, opts, inp.image) };
  },

  async music(n, inp, ctx) {
    const text = promptOf(n, inp, "no prompt — describe the track");
    return { audio: await ctx.audio(mdl(n), text, audioParams(n)) };
  },

  async tts(n, inp, ctx) {
    const text = promptOf(n, inp, "no text — give the Speech node something to say");
    return { audio: await ctx.audio(mdl(n), text, audioParams(n)) };
  },

  async remix(n, inp, ctx) {
    if (!inp.audio) throw new NanoodleError("no audio — wire a source track into the audio port");
    const text = promptOf(n, inp, "no prompt — describe the cover / extension first");
    const params = audioParams(n);
    // https source rides as-is (providers take hosted URLs); local data: is inlined
    if (/^https?:/i.test(inp.audio)) params.audio = inp.audio;
    else {
      if (inp.audio.length > MEDIA_INLINE_MAX) {
        throw new NanoodleError("source audio is too large to inline (~4 MB send limit) — use a shorter clip");
      }
      params.audio = inp.audio;
    }
    return { audio: await ctx.audio(mdl(n), text, params) };
  },

  async transcribe(n, inp, ctx) {
    if (!inp.audio) throw new NanoodleError("no audio input");
    return { text: await ctx.transcribe(mdl(n), inp.audio, (n.fields.language || "auto").trim()) };
  },
};
