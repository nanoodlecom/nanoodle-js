import { NanoodleError } from "./errors.mjs";
import { catItem, chatModelCan, pricingAdvertisesRefs } from "./catalog.mjs";
import { IMG_PORT_RE, EDIT_IMG_RE, REF_PORT_RE, CLIP_PORT_RE, VID_PORT_RE, optionalNode } from "./graph.mjs";
import { MEDIA_INLINE_MAX } from "./media.mjs";
import {
  resizeCropImage, trimAudioToWav, extractAudioToWav,
  extractVideoFrames, concatVideos, muxSoundtrack, maskToSource, fitImageInline,
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

/**
 * Shrink an inline image under the ~4.4 MB request-body budget before a paid send —
 * over it, NanoGPT 413s (FUNCTION_PAYLOAD_TOO_LARGE, verified live; there is no upload
 * endpoint), so a downscaled image beats a dead node. Modern image models routinely
 * return 4K PNGs (~13 MB as base64), which killed every generate→animate/edit chain.
 * Browser hosts may inject ctx.fitImage (canvas path); default is local-media's
 * (pure-JS for PNG, ffmpeg otherwise). http(s) URLs and already-fitting images pass
 * through untouched.
 */
async function fitImage(url, ctx, what) {
  if (url == null) return url;
  const fit = (ctx && ctx.fitImage) || fitImageInline;
  const out = await fit(url, mediaOpts(ctx));
  if (out !== url && ctx && ctx.progress) ctx.progress(what + " resized to fit the ~4 MB send limit");
  return out;
}

function collectPorts(inp, re) {
  return Object.keys(inp)
    .filter((k) => re.test(k))
    .sort((a, b) => portIdx(a) - portIdx(b))
    .map((k) => inp[k])
    .filter(Boolean);
}
