// A Nanoodle pose sequence is an ordinary APNG whose frames are full RGBA
// sprite strips. Only the private nsTA marker opts a sheet into pose playback.
import { NanoodleError } from "./errors.mjs";
import { catBytes, crc32, pngChunk } from "./local-media.mjs";

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const END = pngChunk("IEND", new Uint8Array());
const MAX_FILE_BYTES = 544 * 1024 * 1024;
const MAX_CHUNKS = 65_536;

function check(ok, detail) {
  if (!ok) throw new NanoodleError("Invalid sprite stack PNG: " + detail);
}

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function countValid(n) {
  return Number.isInteger(n) && n >= 2 && n <= 64;
}

// Probe just chunk headers so unmarked stills and ordinary APNGs keep their
// existing decode path. Recognition does not depend on the marker's validity.
function isMarked(bytes) {
  if (!SIGNATURE.every((b, i) => bytes[i] === b)) return false;
  const data = view(bytes);
  for (let p = 8, count = 0; p + 8 <= bytes.length && count < MAX_CHUNKS; count++) {
    if (data.getUint32(p + 4) === 0x6e735441) return true; // nsTA
    if (data.getUint32(p + 4) === 0x49454e44) return false; // IEND
    p += 12 + data.getUint32(p);
  }
  return false;
}

function* chunks(bytes) {
  check(
    SIGNATURE.every((b, i) => bytes[i] === b),
    "signature",
  );
  check(bytes.length <= MAX_FILE_BYTES, "file too large");
  const data = view(bytes);
  let p = 8,
    count = 0;
  while (p < bytes.length) {
    check(++count <= MAX_CHUNKS && p + 12 <= bytes.length, "excessive or truncated chunks");
    const length = data.getUint32(p);
    const stop = p + 8 + length;
    check(stop + 4 <= bytes.length, "truncated chunk data");
    const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    check(/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type), "chunk type");
    check(crc32(bytes.subarray(p + 4, stop)) === data.getUint32(stop), "CRC of " + type);
    check(count !== 1 || type === "IHDR", "missing IHDR");
    check(type !== "IHDR" || count === 1, "duplicate IHDR");
    if (type === "IEND") check(!length && stop + 4 === bytes.length, "IEND or trailing bytes");
    yield { type, payload: bytes.subarray(p + 8, stop) };
    if (type === "IEND") return;
    p = stop + 4;
  }
  check(false, "missing IEND");
}

function header(payload) {
  check(payload.length === 13, "IHDR size");
  const data = view(payload);
  const width = data.getUint32(0),
    height = data.getUint32(4);
  const layers = width / height;
  check(height >= 16 && height <= 128 && Number.isInteger(layers) && layers >= 8 && layers <= 128, "strip dimensions");
  check(
    payload[8] === 8 && payload[9] === 6 && !payload[10] && !payload[11] && !payload[12],
    "expected noninterlaced RGBA8",
  );
  return { width, height, maxCompressed: (width * 4 + 1) * height + 65_536 };
}

function ancillary(type) {
  // PLTE is permitted in truecolor images as a suggested palette.
  check(type === "PLTE" || type[0] >= "a", "unsupported critical chunk " + type);
}

function appendData(frame, payload, limit) {
  frame.size += payload.length;
  check(frame.size <= limit, "compressed frame too large");
  frame.parts.push(payload);
}

/** Return null for an unmarked image, or validate and index all compressed poses. */
export function readStackApng(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!isMarked(bytes)) return null;
  let ihdr,
    shape,
    marked = false,
    count = 0,
    seq = 0,
    frame;
  let num, den, previous;
  const frames = [];
  for (const { type, payload } of chunks(bytes)) {
    const data = view(payload);
    switch (type) {
      case "IHDR":
        shape = header(payload);
        ihdr = pngChunk("IHDR", payload);
        break;
      case "nsTA":
        check(!marked && !count && payload.length === 1 && payload[0] === 1, "nsTA version or order");
        marked = true;
        break;
      case "acTL":
        check(marked && !count && payload.length === 8, "acTL order or size");
        count = data.getUint32(0);
        check(countValid(count) && !data.getUint32(4), "pose count or loop count");
        break;
      case "fcTL": {
        check(
          frames.length < count && (!frame || frame.size) && payload.length === 26,
          "frame control or missing frame data",
        );
        check(data.getUint32(0) === seq++, "frame sequence number");
        check(
          data.getUint32(4) === shape.width &&
            data.getUint32(8) === shape.height &&
            !data.getUint32(12) &&
            !data.getUint32(16) &&
            !payload[24] &&
            !payload[25],
          "frame geometry or operations",
        );
        const n = data.getUint16(20),
          d = data.getUint16(22);
        check(n && d && (!frame || n * den === num * d), "nonpositive or unequal pose delays");
        num = n;
        den = d;
        frame = { parts: [], size: 0 };
        frames.push(frame);
        break;
      }
      case "IDAT":
        check(frames.length === 1 && (!frame.parts.length || previous === "IDAT"), "unexpected IDAT");
        appendData(frame, payload, shape.maxCompressed);
        break;
      case "fdAT":
        check(
          frames.length > 1 && payload.length >= 4 && data.getUint32(0) === seq++,
          "unexpected fdAT or sequence number",
        );
        appendData(frame, payload.subarray(4), shape.maxCompressed);
        break;
      case "IEND":
        check(count && frames.length === count && frame.size, "missing poses or image data");
        break;
      default:
        ancillary(type);
    }
    previous = type;
  }
  const delay = num / den;
  return {
    length: count,
    width: shape.width,
    height: shape.height,
    duration: delay * count,
    delays: Array(count).fill(delay),
    png(index) {
      check(Number.isInteger(index) && index >= 0 && index < count, "pose index");
      return catBytes([SIGNATURE, ihdr, ...frames[index].parts.map((part) => pngChunk("IDAT", part)), END]);
    },
  };
}

// Slice 3D already PNG-encodes tiles. Reuse its deflate stream instead of
// expanding it into RGBA again when all we're doing is wrapping each pose.
function stillFrame(bytes) {
  let ihdr, shape, previous;
  const frame = { parts: [], size: 0 };
  for (const { type, payload } of chunks(bytes)) {
    if (type === "IHDR") {
      ihdr = payload;
      shape = header(payload);
    } else if (type === "IDAT") {
      check(!frame.parts.length || previous === "IDAT", "nonconsecutive IDAT");
      appendData(frame, payload, shape.maxCompressed);
    } else if (type === "IEND") {
      check(frame.size, "empty pose");
    } else {
      check(!["nsTA", "acTL", "fcTL", "fdAT"].includes(type), "expected a still image per pose");
      ancillary(type);
    }
    previous = type;
  }
  return { ...shape, ihdr, compressed: frame.parts.length === 1 ? frame.parts[0] : catBytes(frame.parts) };
}

function u32(number) {
  const bytes = new Uint8Array(4);
  view(bytes).setUint32(0, number);
  return bytes;
}

/** Pack a sync/async iterable of independently encoded PNG strips. Delay is seconds per pose. */
export async function writeStackApng(frameCount, frameDuration, frames) {
  check(countValid(frameCount), "expected 2 to 64 poses");
  check(Number.isFinite(frameDuration) && frameDuration > 0 && frameDuration <= 65_535, "invalid pose duration");
  const den = Math.max(1, Math.min(60_000, Math.floor(65_535 / frameDuration)));
  const num = Math.max(1, Math.min(65_535, Math.round(frameDuration * den)));
  const chunksOut = [SIGNATURE];
  let width,
    height,
    seq = 0,
    i = 0;
  for await (const bytes of frames) {
    check(i < frameCount && bytes instanceof Uint8Array, "unexpected pose");
    const frame = stillFrame(bytes);
    if (i === 0) {
      width = frame.width;
      height = frame.height;
      chunksOut.push(
        pngChunk("IHDR", frame.ihdr),
        pngChunk("nsTA", Uint8Array.of(1)),
        pngChunk("acTL", catBytes([u32(frameCount), u32(0)])),
      );
    }
    check(frame.width === width && frame.height === height, "poses must have the same dimensions");
    const control = new Uint8Array(26);
    const data = view(control);
    data.setUint32(0, seq++);
    data.setUint32(4, width);
    data.setUint32(8, height);
    data.setUint16(20, num);
    data.setUint16(22, den);
    chunksOut.push(
      pngChunk("fcTL", control),
      i ? pngChunk("fdAT", catBytes([u32(seq++), frame.compressed])) : pngChunk("IDAT", frame.compressed),
    );
    i++;
  }
  check(i === frameCount, "pose count mismatch");
  return catBytes([...chunksOut, END]);
}
