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
