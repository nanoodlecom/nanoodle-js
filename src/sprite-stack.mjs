import { number, viewPlan, softwareFrame, flag, turntablePlan } from "./sprite-projection.mjs";
import { decodeSpriteImage, frameUrl, encodeTurntable } from "./sprite-cpu.mjs";
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
  const bytes = await media.bytes({ signal: ctx?.signal });
  return new Blob([bytes], { type: media.mime || "application/octet-stream" });
}
function png(el) {
  const result = el.toDataURL("image/png");
  if (!result.startsWith("data:image/png")) throw new Error("The atlas exceeds this browser’s canvas limit.");
  return result;
}

function stackView(sheet, fields) {
  const { tile, layers, scale, rise, squash, w, h } = viewPlan(sheet, fields);
  const el = canvas(w, h),
    ctx = el.getContext("2d");
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
  return { el, draw };
}

// Match the editor's MP4-first canvas export, falling back to WebM where available.
async function recordTurntable(view, fields, signal) {
  if (typeof MediaRecorder === "undefined" || !view.el.captureStream)
    throw new Error("Turntable export requires MediaRecorder and canvas.captureStream.");
  const mime = [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error("No supported MP4 or WebM recorder in this browser.");
  const { fps, duration, from, to, count: frames } = turntablePlan(fields);
  view.draw(from);
  let stream = view.el.captureStream(0);
  if (typeof stream.getVideoTracks()[0]?.requestFrame !== "function") {
    stream.getTracks().forEach((track) => track.stop());
    stream = view.el.captureStream(fps);
  }
  const [track] = stream.getVideoTracks();
  let rec;
  try {
    rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    const stopped = new Promise((resolve, reject) => {
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.onerror = (e) => reject(e.error || new Error("Turntable recording failed."));
      rec.onstop = resolve;
    });
    const start = performance.now();
    async function animate() {
      rec.start();
      for (let frame = 0; frame < frames; frame++) {
        signal?.throwIfAborted();
        view.draw(from + ((to - from) * frame) / (frames - 1));
        track.requestFrame?.();
        const deadline = start + ((frame + 1) * duration * 1000) / frames;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - performance.now())));
        if (rec.state === "inactive") break;
      }
      if (rec.state !== "inactive") rec.stop();
    }
    await Promise.all([animate(), stopped]);
    signal?.throwIfAborted();
    const blob = new Blob(chunks, { type: rec.mimeType.split(";")[0] });
    if (!blob.size) throw new Error("The browser produced an empty turntable recording.");
    return bytesToDataUrl(new Uint8Array(await blob.arrayBuffer()), blob.type);
  } finally {
    if (rec && rec.state !== "inactive") rec.stop();
    stream.getTracks().forEach((t) => t.stop());
  }
}

export async function slice3d(node, inp, ctx) {
  if (!inp.model) throw new Error("Wire a 3D model into Slice 3D.");
  const fields = node.fields || {},
    size = number(fields, "resolution", 48, 16, 128, true),
    layers = number(fields, "slices", 48, 8, 128, true);
  const pixels =
    typeof document === "undefined" ? (blob) => decodeSpriteImage(blob, ctx?.signal) : imagePixels;
  const modelBlob = await readMedia(inp.model, ctx),
    bytes = new Uint8Array(await modelBlob.arrayBuffer());
  const model =
    bytes[0] === 112 && bytes[1] === 108 && bytes[2] === 121
      ? gaussianModel(bytes)
      : await triangleModel(bytes, (raw, mime) => pixels(new Blob([raw], { type: mime })));
  const palette = number(fields, "palette", 16, 0, 64, true);
  const supplied = palette && inp.paletteImage ? await pixels(await readMedia(inp.paletteImage, ctx)) : null;
  ctx?.signal?.throwIfAborted();
  const sliced = slicePixels(
    model,
    { size, layers, axis: fields.upAxis || "auto", outline: flag(fields.outline, true), palette },
    supplied,
  );
  if (typeof document === "undefined") {
    const sheet = { width: sliced.width, height: sliced.height, data: sliced.rgba };
    return {
      sheet: await frameUrl(sheet),
      layout: JSON.stringify(sliced.layout),
      image: await frameUrl(softwareFrame(sheet, {}, 35)),
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
    blob = await readMedia(inp.sheet, ctx);
  const yaw = number(fields, "yaw", 35, -3600, 3600);
  if (typeof document === "undefined") {
    const sheet = await decodeSpriteImage(blob, ctx?.signal);
    const image = await frameUrl(softwareFrame(sheet, fields, yaw));
    if (!flag(fields.turntable, false)) return { image };
    return { image, video: await encodeTurntable(sheet, fields, ctx?.signal) };
  }
  const sheet = await bitmap(blob);
  try {
    const view = stackView(sheet, fields);
    view.draw(yaw);
    const image = png(view.el);
    if (!flag(fields.turntable, false)) return { image };
    return { image, video: await recordTurntable(view, fields, ctx?.signal) };
  } finally {
    sheet.close?.();
  }
}
