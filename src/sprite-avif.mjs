import { readFile } from "node:fs/promises";
import decode, { init } from "@jsquash/avif/decode.js";
import { orientImage } from "./sprite-orientation.mjs";

// Resolve the decoder installed by npm without network access. Module
// initialization is shared by concurrent graphs and only runs on first use.
const wasmFile = new URL(import.meta.resolve("@jsquash/avif/codec/dec/avif_dec.wasm"));
await init(await WebAssembly.compile(await readFile(wasmFile)));

function boxes(buffer, start = 0) {
  const result = [];
  for (let i = start; i + 8 <= buffer.length; ) {
    let size = buffer.readUInt32BE(i), header = 8;
    if (size === 1) {
      if (i + 16 > buffer.length) break;
      size = Number(buffer.readBigUInt64BE(i + 8));
      header = 16;
    } else if (size === 0) size = buffer.length - i;
    if (size < header || i + size > buffer.length) break;
    result.push({ type: buffer.toString("latin1", i + 4, i + 8), data: buffer.subarray(i + header, i + size) });
    i += size;
  }
  return result;
}

// ISO BMFF properties can also belong to thumbnails and alpha items. Only
// the properties associated with the primary item describe its presentation.
function primaryProperties(bytes) {
  const find = (list, type) => list.find(box => box.type === type)?.data;
  const meta = find(boxes(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)), "meta");
  if (!meta) return [];
  const children = boxes(meta, 4);
  const pitm = find(children, "pitm"), iprp = find(children, "iprp");
  if (!pitm || !iprp) return [];
  const id = pitm.readUIntBE(4, pitm[0] === 0 ? 2 : 4);
  const tables = boxes(iprp), ipco = find(tables, "ipco");
  if (!ipco) return [];
  const props = boxes(ipco), selected = [];
  for (const { type, data } of tables) {
    if (type !== "ipma") continue;
    const idSize = data[0] === 0 ? 2 : 4;
    const indexSize = (data[3] & 1) ? 2 : 1;
    const mask = indexSize === 2 ? 0x7fff : 0x7f;
    const count = data.readUInt32BE(4);
    let p = 8;
    for (let j = 0; j < count; j++) {
      const item = data.readUIntBE(p, idSize);
      const n = data.readUInt8(p + idSize);
      p += idSize + 1;
      if (p + n * indexSize > data.length) throw new Error("Truncated AVIF item associations.");
      if (item === id) {
        for (let i = 0; i < n; i++) {
          const entry = data.readUIntBE(p + i * indexSize, indexSize);
          const property = props[(entry & mask) - 1];
          if (!property) continue;
          if (entry <= mask && ["clap", "irot", "imir"].includes(property.type))
            throw new Error("AVIF display properties must be marked essential.");
          selected.push(property);
        }
      }
      p += n * indexSize;
    }
  }
  return selected;
}

function cropTopLeft(image, clap) {
  if (!clap || clap.length !== 32) return image;
  // Chromium displays clean apertures anchored to the top left. It keeps
  // the full coded canvas when the aperture begins at any other position.
  function dimension(length, numerator, offset) {
    const denominator = clap.readInt32BE(numerator + 4);
    const offsetDenominator = clap.readInt32BE(offset + 4);
    if (denominator <= 0 || offsetDenominator <= 0) return 0;
    const size = clap.readInt32BE(numerator) / denominator;
    const centerShift = clap.readInt32BE(offset) / offsetDenominator;
    return Number.isInteger(size) && size > 0 && size <= length && (size - length) / 2 === centerShift ? size : 0;
  }
  const width = dimension(image.width, 0, 16), height = dimension(image.height, 8, 24);
  if (!width || !height || (width === image.width && height === image.height)) return image;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const start = y * image.width * 4;
    data.set(image.data.subarray(start, start + width * 4), y * width * 4);
  }
  return { width, height, data };
}

export async function decodeAvif(bytes, checkDimensions) {
  const properties = primaryProperties(bytes);
  const find = type => properties.find(box => box.type === type)?.data;
  const ispe = find("ispe");
  if (ispe) checkDimensions(ispe.readUInt32BE(4), ispe.readUInt32BE(8));
  const { width, height, data } = await decode(bytes);
  const image = cropTopLeft({ width, height, data }, find("clap"));
  const angle = (find("irot")?.[0] ?? 0) & 3;
  const mirror = find("imir")?.[0];
  // Counterclockwise quarter turns, followed by a horizontal- or vertical-axis flip.
  const orientation = mirror === undefined ? [1, 8, 3, 6] : (mirror & 1) ? [2, 7, 4, 5] : [4, 5, 2, 7];
  const result = orientImage(image, orientation[angle]);
  checkDimensions(result.width, result.height);
  return result;
}
