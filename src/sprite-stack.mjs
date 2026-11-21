import { number, viewPlan, softwareView, flag, turntablePlan } from "./sprite-projection.mjs";
import { encodePngRgba } from "./local-media.mjs";
import { encodeSpriteMp4 } from "./sprite-video.mjs";
import { MediaRef, bytesToDataUrl } from "./media.mjs";
import { gaussianModel, trianglePoses } from "./sprite-model.mjs";
import { CHARACTER_SLICE_DEFAULTS, expandModelBounds, slicePixels } from "./sprite-slices.mjs";
import { readStackApng, writeStackApng } from "./sprite-sequence.mjs";
import { decodePngPixels } from "./png-decoder.mjs";

function canvas(width, height) {
  if (typeof document === "undefined") throw new Error("Sprite stacking requires a browser with Canvas 2D.");
  const el = document.createElement("canvas");
  el.width = width;
  el.height = height;
  return el;
}
async function bitmap(blob) {
  if (typeof createImageBitmap === "function") return createImageBitmap(blob);
  const url = URL.createObjectURL(blob),
    img = new Image();
  try {
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}
async function imagePixels(blob) {
  const img = await bitmap(blob);
  try {
    const ctx = canvas(img.width, img.height).getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, img.width, img.height);
  } finally {
    img.close?.();
  }
}
async function readMedia(value, ctx) {
  const media = new MediaRef(String(value), { fetch: ctx?.fetch });
  return media.bytes({ signal: ctx?.signal });
}
function png(el) {
  const result = el.toDataURL("image/png");
  if (!result.startsWith("data:image/png")) throw new Error("The atlas exceeds this browser’s canvas limit.");
  return result;
}

function stackView(sheet, fields) {
  const { tile, layers, scale, rise, squash, w, h } = viewPlan(sheet, fields);
  const el = canvas(w, h),
    ctx = el.getContext("2d", { willReadFrequently: flag(fields.turntable, false) });
  function draw(yaw) {
    ctx.resetTransform();
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    const a = (yaw * Math.PI) / 180,
      c = Math.cos(a) * scale,
      s = Math.sin(a) * scale;
    for (let l = 0; l < layers; l++) {
      ctx.setTransform(c, s * squash, -s, c * squash, w / 2, h / 2 + ((layers - 1) / 2 - l) * rise * scale);
      ctx.drawImage(sheet, l * tile, 0, tile, tile, -tile / 2, -tile / 2, tile, tile);
    }
    ctx.resetTransform();
  }
  return { el, ctx, draw };
}

async function frameUrl(frame) {
  return bytesToDataUrl(await encodePngRgba(frame.width, frame.height, frame.data), "image/png");
}

// Long clips can spend several frames entirely in synchronous pixel code.
function frameCheckpoint(signal) {
  let lastYield = performance.now();
  return async () => {
    if (performance.now() - lastYield >= 16) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
    signal?.throwIfAborted();
  };
}

async function encodeViews(count, duration, drawFrame, signal) {
  const check = frameCheckpoint(signal);
  async function* frames() {
    for (let i = 0; i < count; i++) {
      await check();
      yield drawFrame(i);
    }
  }
  return bytesToDataUrl(await encodeSpriteMp4(frames(), duration), "video/mp4");
}

function encodeTurntable(draw, fields, signal) {
  const { duration, from, to, count } = turntablePlan(fields);
  return encodeViews(count, duration, (i) => draw(from + ((to - from) * i) / (count - 1)), signal);
}

export async function slice3d(node, inp, ctx) {
  if (!inp.model) throw new Error("Wire a 3D model into Slice 3D.");
  const fields = node.fields || {};
  const defaults = fields.preset === "character" ? CHARACTER_SLICE_DEFAULTS : {};
  const size = number(fields, "resolution", defaults.resolution ?? 48, 16, 128, true);
  const layers = number(fields, "slices", defaults.slices ?? 48, 8, 128, true);
  const palette = number(fields, "palette", defaults.palette ?? 16, 0, 64, true);
  const frames = number(fields, "frames", 1, 1, 64, true);
  const clip = fields.clip ?? "";
  const headless = typeof document === "undefined";
  const pixels = headless
    ? (await import("./sprite-image.mjs")).decodeSpriteBytes
    : (raw, mime) => imagePixels(new Blob([raw], { type: mime }));
  const bytes = await readMedia(inp.model, ctx);
  let poses;
  if (bytes[0] === 112 && bytes[1] === 108 && bytes[2] === 121) {
    if (frames > 1 || clip)
      throw new Error("Gaussian PLY has no animation clips. Clear clip and set frames to 1 for a static sheet.");
    const model = gaussianModel(bytes);
    poses = { pose: () => model };
  } else {
    poses = await trianglePoses(bytes, pixels, { clip, frames });
  }
  const check = frameCheckpoint(ctx?.signal);
  const firstModel = poses.pose(0);
  const bounds = expandModelBounds(firstModel);
  for (let i = 1; i < frames; i++) {
    await check();
    expandModelBounds(poses.pose(i), bounds);
  }
  const supplied = palette && inp.paletteImage ? await pixels(await readMedia(inp.paletteImage, ctx)) : null;
  const options = { size, layers, axis: fields.upAxis || "auto", outline: flag(fields.outline, true), palette };
  await check();
  const first = slicePixels(firstModel, options, supplied, bounds);
  const sheet = { width: first.width, height: first.height, data: first.rgba };
  if (frames > 1) {
    async function* pngFrames() {
      yield encodePngRgba(first.width, first.height, first.rgba);
      for (let i = 1; i < frames; i++) {
        await check();
        const frame = slicePixels(poses.pose(i), options, supplied, bounds);
        yield encodePngRgba(frame.width, frame.height, frame.rgba);
      }
    }
    const animation = poses.animation;
    const encoded = await writeStackApng(frames, animation.duration / frames, pngFrames());
    return {
      sheet: bytesToDataUrl(encoded, "image/png"),
      image: await frameUrl(softwareView(sheet, {})(35)),
      layout: JSON.stringify({ ...first.layout, animation }),
    };
  }
  if (headless) {
    return {
      sheet: await frameUrl(sheet),
      layout: JSON.stringify(first.layout),
      image: await frameUrl(softwareView(sheet, {})(35)),
    };
  }
  const el = canvas(size * layers, size);
  el.getContext("2d").putImageData(new ImageData(first.rgba, first.width, first.height), 0, 0);
  const view = stackView(el, {});
  view.draw(35);
  return { sheet: png(el), layout: JSON.stringify(first.layout), image: png(view.el) };
}

// Keep only the current decoded atlas. Long gait loops can reuse one pose for
// several output frames, or skip poses when the turntable fps is lower.
async function renderSequence(sequence, fields, yaw, signal) {
  let previous = -1, draw;
  async function pose(index, angle) {
    if (previous !== index) {
      const { w, h, rgba } = await decodePngPixels(sequence.png(index), { maxDim: 128, allowSpriteStrip: true });
      draw = softwareView({ width: w, height: h, data: rgba }, fields);
      previous = index;
    }
    return draw(angle);
  }
  const first = await pose(0, yaw);
  const image = await frameUrl(first);
  if (!flag(fields.turntable, false)) {
    const video = await encodeViews(sequence.length, sequence.duration, i => i === 0 ? first : pose(i, yaw), signal);
    return { image, video };
  }
  const { duration, from, to, count } = turntablePlan(fields);
  const video = await encodeViews(count, duration, i => {
    const time = i * duration / count;
    const index = Math.floor(time * sequence.length / sequence.duration) % sequence.length;
    return pose(index, from + (to - from) * i / (count - 1));
  }, signal);
  return { image, video };
}

export async function renderSpriteStack(node, inp, ctx) {
  if (!inp.sheet) throw new Error("Wire the Slice 3D sheet into Sprite stack render.");
  const fields = node.fields || {},
    bytes = await readMedia(inp.sheet, ctx);
  const yaw = number(fields, "yaw", 35, -3600, 3600);
  const sequence = readStackApng(bytes);
  if (sequence) return renderSequence(sequence, fields, yaw, ctx?.signal);
  if (typeof document === "undefined") {
    const { decodeSpriteBytes } = await import("./sprite-image.mjs");
    const sheet = await decodeSpriteBytes(bytes);
    const draw = softwareView(sheet, fields);
    const image = await frameUrl(draw(yaw));
    if (!flag(fields.turntable, false)) return { image };
    return { image, video: await encodeTurntable(draw, fields, ctx?.signal) };
  }
  const sheet = await bitmap(new Blob([bytes]));
  try {
    const view = stackView(sheet, fields);
    view.draw(yaw);
    const image = png(view.el);
    if (!flag(fields.turntable, false)) return { image };
    const draw = (angle) => {
      view.draw(angle);
      return view.ctx.getImageData(0, 0, view.el.width, view.el.height);
    };
    return { image, video: await encodeTurntable(draw, fields, ctx?.signal) };
  } finally {
    sheet.close?.();
  }
}
