import { number, viewPlan, softwareView, flag, turntablePlan } from "./sprite-projection.mjs";
import { encodePngRgba } from "./local-media.mjs";
import { encodeSpriteMp4 } from "./sprite-video.mjs";
import { MediaRef, bytesToDataUrl } from "./media.mjs";
import { gaussianModel, triangleModel } from "./sprite-model.mjs";
import { slicePixels } from "./sprite-slices.mjs";

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

async function encodeTurntable(draw, fields, signal) {
  const { duration, from, to, count } = turntablePlan(fields);
  async function* frames() {
    let lastYield = performance.now();
    for (let i = 0; i < count; i++) {
      // Give the editor and Node event loop time to deliver cancellation between frames.
      if (performance.now() - lastYield >= 16) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        lastYield = performance.now();
      }
      signal?.throwIfAborted();
      yield draw(from + ((to - from) * i) / (count - 1));
    }
  }
  return bytesToDataUrl(await encodeSpriteMp4(frames(), duration), "video/mp4");
}

export async function slice3d(node, inp, ctx) {
  if (!inp.model) throw new Error("Wire a 3D model into Slice 3D.");
  const fields = node.fields || {},
    size = number(fields, "resolution", 48, 16, 128, true),
    layers = number(fields, "slices", 48, 8, 128, true);
  const headless = typeof document === "undefined";
  const pixels = headless
    ? (await import("./sprite-image.mjs")).decodeSpriteBytes
    : (raw, mime) => imagePixels(new Blob([raw], { type: mime }));
  const bytes = await readMedia(inp.model, ctx);
  const model =
    bytes[0] === 112 && bytes[1] === 108 && bytes[2] === 121
      ? gaussianModel(bytes)
      : await triangleModel(bytes, pixels);
  const palette = number(fields, "palette", 16, 0, 64, true);
  const supplied = palette && inp.paletteImage ? await pixels(await readMedia(inp.paletteImage, ctx)) : null;
  ctx?.signal?.throwIfAborted();
  const sliced = slicePixels(
    model,
    { size, layers, axis: fields.upAxis || "auto", outline: flag(fields.outline, true), palette },
    supplied,
  );
  if (headless) {
    const sheet = { width: sliced.width, height: sliced.height, data: sliced.rgba };
    return {
      sheet: await frameUrl(sheet),
      layout: JSON.stringify(sliced.layout),
      image: await frameUrl(softwareView(sheet, {})(35)),
    };
  }
  const el = canvas(size * layers, size);
  el.getContext("2d").putImageData(new ImageData(sliced.rgba, sliced.width, sliced.height), 0, 0);
  const view = stackView(el, {});
  view.draw(35);
  return { sheet: png(el), layout: JSON.stringify(sliced.layout), image: png(view.el) };
}

export async function renderSpriteStack(node, inp, ctx) {
  if (!inp.sheet) throw new Error("Wire the Slice 3D sheet into Sprite stack render.");
  const fields = node.fields || {},
    bytes = await readMedia(inp.sheet, ctx);
  const yaw = number(fields, "yaw", 35, -3600, 3600);
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
