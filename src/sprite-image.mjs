import { decodePng } from "./local-media.mjs";
import { decodeJpeg } from "./jpeg-decoder.mjs";
import { decodeGif } from "./gif-decoder.mjs";

// All sprite inputs (textures, palettes and the renderer's strip) use the same
// straight-alpha pixel layout, independent of their on-disk encoding.
export async function decodeSpriteBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes[0] === 137 && bytes[1] === 80) {
    const { w, h, rgba } = await decodePng(bytes, true);
    return { width: w, height: h, data: rgba };
  }
  if (bytes[0] === 255 && bytes[1] === 216) return decodeJpeg(bytes);
  if (bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70) return decodeGif(bytes);
  throw new Error("Unsupported sprite image encoding. Expected PNG, JPEG or GIF.");
}
