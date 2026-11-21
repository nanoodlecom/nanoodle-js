// Huffman-coded 8-bit JPEG, including progressive scans and restart intervals.
// T.81 Annexes B, F and G. Coefficients stay quantized until the final IDCT.
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7,
  14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
];
const BASIS = Array.from({ length: 8 }, (_, x) =>
  Array.from(
    { length: 8 },
    (_, k) => ((k === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * k * Math.PI) / 16)) / 2,
  ),
);

function requireJpeg(ok, detail) {
  if (!ok) throw new Error("Invalid JPEG: " + detail);
}

function huffman(counts, symbols) {
  const last = new Int32Array(17).fill(-1);
  const offset = new Int32Array(17);
  let code = 0,
    index = 0;
  for (let n = 1; n <= 16; n++) {
    const count = counts[n - 1];
    if (count) {
      last[n] = code + count - 1;
      offset[n] = index - code;
      requireJpeg(last[n] < (1 << n) - 1, "Huffman tree");
      index += count;
    }
    code = (code + count) * 2;
  }
  return { last, offset, symbols };
}

class Entropy {
  constructor(bytes, start) {
    this.bytes = bytes;
    this.at = start;
    this.remaining = 0;
    this.eob = 0;
  }
  bit() {
    if (this.remaining === 0) {
      requireJpeg(this.at < this.bytes.length, "truncated scan");
      this.current = this.bytes[this.at++];
      if (this.current === 255) requireJpeg(this.bytes[this.at++] === 0, "premature marker");
      this.remaining = 8;
    }
    return (this.current >> --this.remaining) & 1;
  }
  read(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v;
  }
  signed(n) {
    if (!n) return 0;
    const v = this.read(n);
    return v < 1 << (n - 1) ? v + 1 - (1 << n) : v;
  }
  symbol(tree) {
    requireJpeg(tree, "missing Huffman table");
    let code = 0;
    for (let n = 1; n <= 16; n++) {
      code = (code << 1) | this.bit();
      if (code <= tree.last[n]) return tree.symbols[tree.offset[n] + code];
    }
    throw new Error("Invalid JPEG: unknown Huffman code");
  }
  restart(number) {
    requireJpeg(this.bytes[this.at++] === 255, "missing restart marker");
    while (this.bytes[this.at] === 255) this.at++;
    requireJpeg(this.bytes[this.at++] === 208 + (number % 8), "unexpected restart marker");
    this.remaining = 0;
    this.eob = 0;
  }
}

function refine(bits, block, i, step) {
  const value = block[i];
  if (bits.bit() && (Math.abs(value) & step) === 0) block[i] += value > 0 ? step : -step;
}

function decodeBlock(bits, c, pos, ss, se, high, low, progressive) {
  const block = c.coeffs;
  const step = 1 << low;
  if (ss === 0) {
    if (high) {
      block[pos] |= bits.bit() << low;
    } else {
      const size = bits.symbol(c.dcTree);
      requireJpeg(size <= 11, "DC coefficient size");
      c.predictor += bits.signed(size);
      block[pos] = c.predictor * step;
    }
    if (!se) return;
  }
  let k = ss || 1;
  if (!bits.eob) {
    while (k <= se) {
      const symbol = bits.symbol(c.acTree);
      let zeros = symbol >> 4;
      const size = symbol & 15;
      if (size === 0 && zeros < 15) {
        requireJpeg(progressive || zeros === 0, "sequential end-of-block");
        bits.eob = (1 << zeros) + bits.read(zeros);
        break;
      }
      requireJpeg(high ? size <= 1 : size <= 10, "AC coefficient size");
      const value = size ? bits.signed(size) * step : 0;
      if (!size) zeros = 16;
      while (k <= se && (zeros || (high && block[pos + ZIGZAG[k]]))) {
        const i = pos + ZIGZAG[k++];
        if (high && block[i]) refine(bits, block, i, step);
        else zeros--;
        // ZRL finishes on its sixteenth zero. Subsequent bits start a new symbol.
        if (!zeros && !size) break;
      }
      requireJpeg(zeros === 0 && (!size || k <= se), "AC run exceeds block");
      if (size) block[pos + ZIGZAG[k++]] = value;
    }
  }
  if (bits.eob) {
    if (high)
      for (; k <= se; k++) {
        const i = pos + ZIGZAG[k];
        if (block[i]) refine(bits, block, i, step);
      }
    bits.eob--;
  }
}

function scan(bytes, start, frame, components, ss, se, high, low, interval) {
  const bits = new Entropy(bytes, start);
  const single = components.length === 1 && components[0];
  const cols = single ? Math.ceil(single.width / 8) : frame.cols;
  const rows = single ? Math.ceil(single.height / 8) : frame.rows;
  let restart = 0;
  for (const c of components) c.predictor = 0;
  for (let mcu = 0; mcu < cols * rows; mcu++) {
    if (interval && mcu && mcu % interval === 0) {
      bits.restart(restart++);
      for (const c of components) c.predictor = 0;
    }
    const x = mcu % cols,
      y = Math.floor(mcu / cols);
    for (const c of components) {
      const h = single ? 1 : c.h,
        v = single ? 1 : c.v;
      for (let j = 0; j < v; j++)
        for (let i = 0; i < h; i++) {
          const pos = ((y * v + j) * c.blocksAcross + x * h + i) * 64;
          decodeBlock(bits, c, pos, ss, se, high, low, frame.progressive);
        }
    }
  }
  return bits.at;
}

function byte(value) {
  return Math.min(255, Math.max(0, Math.floor(value + 0.5)));
}

function toSamples(c) {
  const across = Math.ceil(c.width / 8),
    down = Math.ceil(c.height / 8);
  c.stride = across * 8;
  c.samples = new Uint8Array(c.stride * down * 8);
  const temp = new Float64Array(64);
  for (let y = 0; y < down; y++)
    for (let x = 0; x < across; x++) {
      const pos = (y * c.blocksAcross + x) * 64;
      const dest = y * 8 * c.stride + x * 8;
      let last = 63;
      while (last && c.coeffs[pos + last] === 0) last--;
      if (!last) {
        const dc = byte(128 + (c.coeffs[pos] * c.quant[0]) / 8);
        for (let j = 0; j < 8; j++) c.samples.fill(dc, dest + j * c.stride, dest + j * c.stride + 8);
        continue;
      }
      const lastRow = last >> 3;
      for (let row = 0; row <= lastRow; row++) {
        const off = row * 8;
        for (let col = 0; col < 8; col++) {
          let sum = 0;
          for (let k = 0; k < 8; k++) sum += c.coeffs[pos + off + k] * c.quant[off + k] * BASIS[col][k];
          temp[off + col] = sum;
        }
      }
      for (let j = 0; j < 8; j++)
        for (let i = 0; i < 8; i++) {
          let sum = 0;
          for (let k = 0; k <= lastRow; k++) sum += temp[k * 8 + i] * BASIS[j][k];
          c.samples[dest + j * c.stride + i] = byte(sum + 128);
        }
    }
  c.coeffs = null;
}

function channel(c, x, y, frame) {
  if (c.h === frame.h && c.v === frame.v) return c.samples[y * c.stride + x];
  const fx = Math.max(0, Math.min(c.width - 1, ((x + 0.5) * c.h) / frame.h - 0.5));
  const fy = Math.max(0, Math.min(c.height - 1, ((y + 0.5) * c.v) / frame.v - 0.5));
  const ix = Math.floor(fx),
    iy = Math.floor(fy),
    wx = fx - ix,
    wy = fy - iy;
  const a = iy * c.stride,
    b = Math.min(iy + 1, c.height - 1) * c.stride;
  const right = Math.min(ix + 1, c.width - 1),
    s = c.samples;
  const top = s[a + ix] + wx * (s[a + right] - s[a + ix]);
  const bottom = s[b + ix] + wx * (s[b + right] - s[b + ix]);
  return byte(top + wy * (bottom - top));
}

function pixels(frame, adobe) {
  const { width, height, components } = frame;
  for (const c of components) {
    requireJpeg(c.quant && c.seenDC, "missing quantization table or DC scan");
    toSamples(c);
  }
  const data = new Uint8ClampedArray(width * height * 4);
  const rgb = components.length === 3 && (adobe === 0 || components.map((c) => c.id).join() === "82,71,66");
  for (let y = 0, dst = 0; y < height; y++)
    for (let x = 0; x < width; x++, dst += 4) {
      let r = channel(components[0], x, y, frame),
        g = r,
        b = r;
      if (components.length >= 3) {
        g = channel(components[1], x, y, frame);
        b = channel(components[2], x, y, frame);
        if (!rgb && (components.length === 3 || adobe === 2)) {
          const yy = r,
            cb = g - 128,
            cr = b - 128;
          r = byte(yy + 1.402 * cr);
          g = byte(yy - 0.344136 * cb - 0.714136 * cr);
          b = byte(yy + 1.772 * cb);
        }
        if (components.length === 4) {
          // Adobe transform 0 stores inverted CMYK, transform 2 stores YCCK.
          let k = channel(components[3], x, y, frame);
          if (adobe !== 0) {
            r = 255 - r;
            g = 255 - g;
            b = 255 - b;
          }
          if (adobe === undefined) k = 255 - k;
          r = byte((r * k) / 255);
          g = byte((g * k) / 255);
          b = byte((b * k) / 255);
        }
      }
      data[dst] = r;
      data[dst + 1] = g;
      data[dst + 2] = b;
      data[dst + 3] = 255;
    }
  return { width, height, data };
}

export function decodeJpeg(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const quant = [],
    dc = [],
    ac = [];
  let frame,
    interval = 0,
    adobe,
    at = 2;
  while (at < bytes.length) {
    requireJpeg(bytes[at++] === 255, "marker prefix");
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (marker === 217) {
      requireJpeg(frame, "missing frame");
      return pixels(frame, adobe);
    }
    requireJpeg(at + 2 <= bytes.length, "missing segment length");
    const length = view.getUint16(at),
      end = at + length;
    requireJpeg(length >= 2 && end <= bytes.length, "truncated segment");
    at += 2;
    if (marker === 219) {
      while (at < end) {
        const spec = bytes[at++],
          wide = spec >> 4,
          id = spec & 15;
        requireJpeg(id < 4 && wide <= 1 && at + 64 * (wide + 1) <= end, "quantization table");
        const values = new Uint16Array(64);
        for (let i = 0; i < 64; i++, at += wide + 1)
          values[ZIGZAG[i]] = wide ? view.getUint16(at) : bytes[at];
        quant[id] = values;
      }
    } else if (marker === 196) {
      while (at < end) {
        const spec = bytes[at++];
        requireJpeg((spec & 15) < 4 && spec >> 4 <= 1 && at + 16 <= end, "Huffman table");
        const counts = bytes.subarray(at, at + 16);
        const n = counts.reduce((a, b) => a + b);
        at += 16;
        requireJpeg(n > 0 && n <= 256 && at + n <= end, "Huffman symbols");
        (spec >> 4 ? ac : dc)[spec & 15] = huffman(counts, bytes.subarray(at, at + n));
        at += n;
      }
    } else if (marker === 192 || marker === 193 || marker === 194) {
      requireJpeg(!frame && at + 6 <= end && bytes[at++] === 8, "expected one 8-bit frame");
      const height = view.getUint16(at),
        width = view.getUint16(at + 2),
        n = bytes[at + 4];
      at += 5;
      requireJpeg(
        width && height && width <= 8192 && height <= 8192 && [1, 3, 4].includes(n) && at + n * 3 === end,
        "frame dimensions or components",
      );
      const components = [];
      for (let i = 0; i < n; i++) {
        const id = bytes[at++],
          sampling = bytes[at++],
          h = sampling >> 4,
          v = sampling & 15,
          table = bytes[at++];
        requireJpeg(
          h && h <= 4 && v && v <= 4 && table < 4 && !components.some((c) => c.id === id),
          "component sampling",
        );
        components.push({ id, h, v, table });
      }
      const h = Math.max(...components.map((c) => c.h)),
        v = Math.max(...components.map((c) => c.v));
      const cols = Math.ceil(width / (h * 8)),
        rows = Math.ceil(height / (v * 8));
      for (const c of components) {
        c.width = Math.ceil((width * c.h) / h);
        c.height = Math.ceil((height * c.v) / v);
        c.blocksAcross = cols * c.h;
        c.coeffs = new Int16Array(c.blocksAcross * rows * c.v * 64);
      }
      frame = { width, height, h, v, cols, rows, components, progressive: marker === 194 };
    } else if (marker === 221) {
      requireJpeg(length === 4, "restart interval");
      interval = view.getUint16(at);
    } else if (
      marker === 238 &&
      length >= 14 &&
      String.fromCharCode(...bytes.subarray(at, at + 5)) === "Adobe"
    ) {
      adobe = bytes[at + 11];
    } else if (marker === 218) {
      requireJpeg(frame && at < end, "scan without frame");
      const count = bytes[at++],
        selected = [];
      requireJpeg(
        count >= 1 && count <= frame.components.length && at + 2 * count + 3 === end,
        "scan header",
      );
      for (let i = 0; i < count; i++) {
        const id = bytes[at++],
          tables = bytes[at++];
        const c = frame.components.find((component) => component.id === id);
        requireJpeg(c && !selected.includes(c), "scan component");
        c.quant ??= quant[c.table];
        c.dcTree = dc[tables >> 4];
        c.acTree = ac[tables & 15];
        selected.push(c);
      }
      const ss = bytes[at++],
        se = bytes[at++],
        high = bytes[at] >> 4,
        low = bytes[at] & 15;
      if (frame.progressive) {
        requireJpeg(
          (ss === 0 ? se === 0 : count === 1 && ss <= se && se <= 63) &&
            low <= 13 &&
            (!high || high === low + 1),
          "progressive scan parameters",
        );
      } else requireJpeg(ss === 0 && se === 63 && !high && !low, "sequential scan parameters");
      if (ss === 0 && !high) for (const c of selected) c.seenDC = true;
      at = scan(bytes, end, frame, selected, ss, se, high, low, interval);
      continue;
    } else if (!((marker >= 224 && marker <= 239) || marker === 254)) {
      throw new Error("Unsupported JPEG coding mode or marker 0x" + marker.toString(16));
    }
    at = end;
  }
  throw new Error("Invalid JPEG: missing end marker");
}
