import { decodeBitmap, decodeIcon } from "./sprite-bitmap.mjs";
import { MAX_IMAGE_DIM } from "./local-media.mjs";
import { decodePngPixels } from "./png-decoder.mjs";
import { pngOrientation, orientImage } from "./sprite-orientation.mjs";

// ftyp lists a major brand, a minor version, then compatible brands. AVIF
// assets can use mif1 as the major brand and advertise avif only in the list.
function isAvifImage(bytes) {
  if (bytes.length < 16 || bytes[4] !== 102 || bytes[5] !== 116 || bytes[6] !== 121 || bytes[7] !== 112)
    return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = view.getUint32(0), start = 8;
  if (end === 1) {
    if (bytes.length < 24 || view.getUint32(8) !== 0) return false;
    end = view.getUint32(12);
    start = 16;
  }
  end = Math.min(end || bytes.length, bytes.length);
  for (let i = start; i + 4 <= end; i += 4) {
    if (i === start + 4) continue;
    if (bytes[i] === 97 && bytes[i + 1] === 118 && bytes[i + 2] === 105 &&
        (bytes[i + 3] === 102 || bytes[i + 3] === 115)) return true;
  }
  return false;
}

// Node loads the maintained decoder only for formats that need it. Its native
// binaries are installed with the npm package. The editor uses native bitmaps.
async function decodeRaster(bytes, format) {
  const { default: sharp } = await import("sharp");
  try {
    const limitInputPixels = format === "JPEG" ? 16_777_216 : MAX_IMAGE_DIM ** 2;
    const image = sharp(bytes, { pages: 1, failOn: "error", limitInputPixels });
    const meta = await image.metadata();
    if (meta.height > MAX_IMAGE_DIM || meta.width > (meta.height <= 128 ? 16384 : MAX_IMAGE_DIM))
      throw new Error("dimensions exceed the sprite image limit");
    // libavif interpolates 4:2:0 chroma the way the editor does. Metadata is
    // bounded above before the WebAssembly decoder allocates its pixel buffer.
    if (format === "AVIF") {
      const { decodeAvif } = await import("./sprite-avif.mjs");
      return await decodeAvif(bytes);
    }
    // JPEG respects EXIF orientation. The editor displays WebP in stored orientation.
    if (format === "JPEG") image.autoOrient();
    const { info, data } = await image.toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
  } catch (error) {
    throw new Error("Invalid " + format + " sprite image: " + error.message, { cause: error });
  }
}

// All sprite inputs (textures, palettes and the renderer's strip) use the same
// straight-alpha pixel layout, independent of their on-disk encoding.
export async function decodeSpriteBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes[0] === 66 && bytes[1] === 77) return decodeBitmap(bytes);
  if (bytes[0] === 0 && bytes[1] === 0 && (bytes[2] === 1 || bytes[2] === 2) && bytes[3] === 0)
    return decodeIcon(bytes, decodeSpriteBytes);
  if (bytes[0] === 137 && bytes[1] === 80) {
    const { w, h, rgba } = await decodePngPixels(bytes, {
      maxDim: MAX_IMAGE_DIM,
      allowSpriteStrip: true,
      firstAnimationFrame: true,
    });
    return orientImage({ width: w, height: h, data: rgba }, pngOrientation(bytes));
  }
  if (bytes[0] === 255 && bytes[1] === 216) return decodeRaster(bytes, "JPEG");
  if (bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70) return decodeRaster(bytes, "GIF");
  if (isAvifImage(bytes)) return decodeRaster(bytes, "AVIF");
  if (bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 &&
      bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return decodeRaster(bytes, "WebP");
  throw new Error("Unsupported sprite image encoding. Expected PNG, JPEG, GIF, WebP, AVIF, BMP, ICO or CUR.");
}
