// Native hosts expose UTF-8, image codecs and cancellation. Input values are
// passed as function arguments. Only this packaged program is evaluated.
function toBase64(bytes) { return new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength).toBase64(); }
function fromBase64(text) { return Uint8Array.fromBase64(text); }
class TextDecoder {
  decode(bytes) {
    return nativeUtf8(toBase64(bytes));
  }
}
class TextEncoder {
  encode(text) {
    return fromBase64(nativeEncodeUtf8(text));
  }
}
function dataUrlBytes(url) {
  const comma = url.indexOf(","),
    head = url.slice(5, comma),
    body = url.slice(comma + 1);
  if (!url.startsWith("data:") || comma < 0) throw Error("Expected an embedded glTF resource.");
  return {
    mime: head.split(";")[0],
    bytes: /;base64/i.test(head) ? fromBase64(body) : new TextEncoder().encode(decodeURIComponent(body)),
  };
}
function readPixels(encoded) {
  const image = JSON.parse(nativeImage(encoded));
  if (image.error) throw Error(image.error);
  const data = fromBase64(image.rgba);
  if (data.length !== image.width * image.height * 4) throw Error("Invalid decoded image dimensions.");
  return { width: image.width, height: image.height, data };
}
function packImage(image) {
  return { width: image.width, height: image.height, rgba: toBase64(image.data) };
}
let sheet, settings, plan;
async function run(type, fieldJson, source, paletteImage) {
  settings = JSON.parse(fieldJson);
  if (type === "slice-3d") {
    const size = number(settings, "resolution", 48, 16, 128, true),
      layers = number(settings, "slices", 48, 8, 128, true);
    const bytes = fromBase64(source);
    const model =
      bytes[0] === 112 && bytes[1] === 108 && bytes[2] === 121
        ? gaussianModel(bytes)
        : await triangleModel(bytes, (raw) => readPixels(toBase64(raw)));
    const palette = number(settings, "palette", 16, 0, 64, true);
    const sliced = slicePixels(
      model,
      { size, layers, axis: settings.upAxis || "auto", outline: flag(settings.outline, true), palette },
      palette && paletteImage ? readPixels(paletteImage) : null,
    );
    sheet = { width: sliced.width, height: sliced.height, data: sliced.rgba };
    return {
      sheet: packImage(sheet),
      layout: JSON.stringify(sliced.layout),
      image: packImage(softwareFrame(sheet, {}, 35)),
    };
  }
  if (type !== "sprite-stack-render") throw Error("Unknown sprite node.");
  sheet = readPixels(source);
  const image = packImage(softwareFrame(sheet, settings, number(settings, "yaw", 35, -3600, 3600)));
  plan = flag(settings.turntable, false) ? turntablePlan(settings) : null;
  return { image, plan };
}
globalThis.startSprite = (type, fields, source, palette) => {
  globalThis.spriteResult = null;
  run(type, fields, source, palette).then(
    (out) => {
      globalThis.spriteResult = JSON.stringify({ out });
    },
    (err) => {
      globalThis.spriteResult = JSON.stringify({ error: String(err.message || err) });
    },
  );
};
globalThis.spriteFrame = (i) =>
  JSON.stringify(
    packImage(softwareFrame(sheet, settings, plan.from + ((plan.to - plan.from) * i) / (plan.count - 1))),
  );
