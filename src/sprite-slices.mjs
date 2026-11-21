export const CHARACTER_SLICE_DEFAULTS = { resolution: 128, slices: 80, palette: 0, outline: true };

// A clip uses one world-space grid across its poses so feet, scale and root
// motion stay aligned. Only the bounds need to be retained between poses.
export function expandModelBounds(model, bounds = {
  min: [Infinity, Infinity, Infinity],
  max: [-Infinity, -Infinity, -Infinity],
}) {
  const { min, max } = bounds;
  function grow(x, y, z) {
    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
    max[2] = Math.max(max[2], z);
  }
  for (const m of model.meshes || []) {
    const p = m.positions;
    for (let i = 0; i < p.length; i += 3) grow(p[i], p[i + 1], p[i + 2]);
  }
  for (const s of model.splats || []) {
    const [x, y, z] = s.center,
      [a, b, c] = s.extent;
    grow(x - a, y - b, z - c);
    grow(x + a, y + b, z + c);
  }
  return bounds;
}

// Grid coordinates are (column, row, layer). Each square tile has the same
// world-to-pixel scale in both directions; layer thickness is recorded separately.
function gridFor({ min, max }, axis, size, layers) {
  const axes = { x: [1, 2, 0, -1], y: [0, 2, 1, 1], z: [0, 1, 2, -1] }[axis];
  if (!axes) throw new Error("Up axis must be auto, x, y or z.");
  const [u, v, h, sign] = axes;
  const span = Math.max(...min.map((n, i) => max[i] - n));
  if (!(span > 0) || !Number.isFinite(span)) throw new Error("Model bounds have no usable extent.");
  const unit = span / (size - 2),
    step = span / layers,
    cu = (max[u] + min[u]) / 2,
    cv = (max[v] + min[v]) / 2;
  return {
    size,
    layers,
    unit,
    step,
    axes,
    min,
    max,
    project(p) {
      return [(p[u] - cu) / unit + size / 2, (sign * (p[v] - cv)) / unit + size / 2, (p[h] - min[h]) / step];
    },
    world(x, y, l) {
      const p = [];
      p[u] = (x - size / 2) * unit + cu;
      p[v] = sign * (y - size / 2) * unit + cv;
      p[h] = min[h] + l * step;
      return p;
    },
  };
}

function wrap(t, mode) {
  if (mode === 33071) return Math.min(1, Math.max(0, t));
  if (mode === 33648) return 1 - Math.abs((((t % 2) + 2) % 2) - 1);
  return t - Math.floor(t);
}
function srgb(v) {
  return v < 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
function linear(v) {
  return v < 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function sample(mesh, ids, weights) {
  const color = mesh.factor.slice();
  function interpolate(attr, channel) {
    return weights.reduce((sum, w, j) => sum + w * attr.data[ids[j] * attr.n + channel], 0);
  }
  if (mesh.color) for (let k = 0; k < mesh.color.n; k++) color[k] *= interpolate(mesh.color, k);
  if (mesh.texture) {
    const { pixels, sampler } = mesh.texture;
    const x = Math.min(
      pixels.width - 1,
      Math.floor(wrap(interpolate(mesh.uv, 0), sampler.wrapS) * pixels.width),
    );
    const y = Math.min(
      pixels.height - 1,
      Math.floor(wrap(interpolate(mesh.uv, 1), sampler.wrapT) * pixels.height),
    );
    const p = (y * pixels.width + x) * 4;
    for (let k = 0; k < 3; k++) color[k] *= linear(pixels.data[p + k] / 255);
    color[3] *= pixels.data[p + 3] / 255;
  }
  const alpha =
    mesh.alphaMode === "OPAQUE" ? 1 : mesh.alphaMode === "MASK" ? Number(color[3] >= mesh.cutoff) : color[3];
  return [srgb(color[0]) * 255, srgb(color[1]) * 255, srgb(color[2]) * 255, alpha * 255];
}

// Scan a triangle in an axis-aligned projection at cell centers. The dominant
// projection catches vertical walls and flat caps. A floor projection also
// supplies signed ray intersections for filling closed interiors.
function scanTriangle(verts, a, b, width, height, visit) {
  const [p, q, r] = verts;
  const dx = q[a] - p[a],
    dy = q[b] - p[b],
    ex = r[a] - p[a],
    ey = r[b] - p[b];
  const det = dx * ey - dy * ex;
  if (Math.abs(det) < 1e-12) return;
  const startX = Math.max(0, Math.ceil(Math.min(p[a], q[a], r[a]) - 0.5));
  const startY = Math.max(0, Math.ceil(Math.min(p[b], q[b], r[b]) - 0.5));
  const endX = Math.min(width - 1, Math.floor(Math.max(p[a], q[a], r[a]) - 0.5));
  const endY = Math.min(height - 1, Math.floor(Math.max(p[b], q[b], r[b]) - 0.5));
  for (let y = startY; y <= endY; y++)
    for (let x = startX; x <= endX; x++) {
      const px = x + 0.5 - p[a],
        py = y + 0.5 - p[b];
      const v = (px * ey - py * ex) / det,
        w = (dx * py - dy * px) / det,
        u = 1 - v - w;
      if (Math.min(u, v, w) >= -1e-8) visit(x, y, [u, v, w], Math.sign(det));
    }
}

function paintMesh(grid, model, put) {
  const { size, layers } = grid,
    dims = [size, size, layers],
    rays = new Array(size * size);
  for (const mesh of model.meshes) {
    const points = [];
    for (let i = 0; i < mesh.positions.length; i += 3)
      points.push(grid.project(mesh.positions.subarray(i, i + 3)));
    for (let i = 0; i + 2 < mesh.length; i += mesh.mode === 4 ? 3 : 1) {
      const corners =
        mesh.mode === 6
          ? [0, i + 1, i + 2]
          : mesh.mode === 5 && i % 2
            ? [i + 1, i, i + 2]
            : [i, i + 1, i + 2];
      const ids = mesh.idx ? corners.map((k) => mesh.idx[k]) : corners,
        verts = ids.map((k) => points[k]);
      const [p, q, r] = verts,
        planes = [
          [0, 1, 2],
          [1, 2, 0],
          [2, 0, 1],
        ];
      const areas = planes.map(([a, b]) =>
        Math.abs((q[a] - p[a]) * (r[b] - p[b]) - (q[b] - p[b]) * (r[a] - p[a])),
      );
      const dominant = areas.indexOf(Math.max(...areas));
      if (!areas[dominant]) continue;
      let painted = false;
      for (const j of dominant === 0 ? [0] : [dominant, 0]) {
        const [a, b, c] = planes[j];
        scanTriangle(verts, a, b, dims[a], dims[b], (x, y, weights, sign) => {
          const depth = weights.reduce((s, w, k) => s + w * verts[k][c], 0);
          const color = sample(mesh, ids, weights);
          if (j === dominant) {
            const cell = [];
            cell[a] = x;
            cell[b] = y;
            cell[c] = Math.min(dims[c] - 1, Math.max(0, Math.floor(depth)));
            put(...cell, color);
            painted = true;
          }
          if (j === 0) (rays[y * size + x] ||= []).push({ depth, sign, color });
        });
      }
      // A subpixel triangle may cover no cell center in any projection.
      if (!painted) {
        const cell = dims.map((d, k) => Math.min(d - 1, Math.max(0, Math.floor((p[k] + q[k] + r[k]) / 3))));
        put(...cell, sample(mesh, ids, [1 / 3, 1 / 3, 1 / 3]));
      }
    }
  }
  for (let i = 0; i < rays.length; i++) {
    const ray = rays[i];
    if (!ray || ray.length < 2) continue;
    ray.sort((a, b) => a.depth - b.depth);
    // Collapse shared triangle edges before counting volume crossings.
    const hits = [];
    for (const hit of ray) {
      const prev = hits.at(-1);
      if (prev && Math.abs(prev.depth - hit.depth) < 1e-6) prev.sum += hit.sign;
      else hits.push({ ...hit, sum: hit.sign });
    }
    if (hits.reduce((n, h) => n + Math.sign(h.sum), 0) !== 0) continue;
    let winding = 0;
    for (let k = 0; k + 1 < hits.length; k++) {
      const a = hits[k],
        b = hits[k + 1];
      winding += Math.sign(a.sum);
      if (!winding) continue;
      for (let l = Math.max(0, Math.ceil(a.depth - 0.5)); l < layers && l + 0.5 < b.depth; l++)
        put(i % size, Math.floor(i / size), l, l + 0.5 < (a.depth + b.depth) / 2 ? a.color : b.color, true);
    }
  }
}

function paintSplats(grid, model, rgba, index) {
  const { size, layers, axes, unit, step } = grid,
    weights = new Float32Array(rgba.length / 4);
  const dims = [size, size, layers];
  for (const s of model.splats) {
    const center = grid.project(s.center);
    const radius = [s.extent[axes[0]] / unit, s.extent[axes[1]] / unit, s.extent[axes[2]] / step];
    const lo = center.map((n, i) => Math.max(0, Math.floor(n - radius[i])));
    const hi = center.map((n, i) => Math.min(dims[i] - 1, Math.floor(n + radius[i])));
    const peak = center.map((n, i) => Math.min(dims[i] - 1, Math.max(0, Math.floor(n))));
    for (let l = lo[2]; l <= hi[2]; l++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let x = lo[0]; x <= hi[0]; x++) {
          const d = grid.world(x + 0.5, y + 0.5, l + 0.5).map((v, k) => v - s.center[k]);
          const atCenter = x === peak[0] && y === peak[1] && l === peak[2];
          let distance = 0;
          for (let k = 0; k < 3; k++)
            distance +=
              ((d[0] * s.rotation[k * 4] + d[1] * s.rotation[k * 4 + 1] + d[2] * s.rotation[k * 4 + 2]) /
                s.scales[k]) **
              2;
          if (distance > 9 && !atCenter) continue;
          const alpha = s.alpha * Math.exp(-0.5 * (atCenter ? 0 : distance));
          if (alpha < 0.5 / 255) continue;
          const p = index(x, y, l),
            old = weights[p / 4],
            sum = old + alpha;
          for (let k = 0; k < 3; k++) rgba[p + k] = (rgba[p + k] * old + s.color[k] * alpha) / sum;
          rgba[p + 3] += alpha * (255 - rgba[p + 3]);
          weights[p / 4] = sum;
        }
  }
}

// Weighted median-cut over 5-bit RGB bins. Small supplied palettes keep their
// exact colors, including near-neighbors in the same histogram bin.
function paletteOf(data, limit) {
  const exact = new Set(),
    hist = new Map();
  for (let p = 0; p < data.length; p += 4) {
    if (!data[p + 3]) continue;
    const r = data[p],
      g = data[p + 1],
      b = data[p + 2],
      key = (r >> 3) * 1024 + (g >> 3) * 32 + (b >> 3);
    if (exact.size <= limit) exact.add(r * 65536 + g * 256 + b);
    const bin = hist.get(key) || [0, 0, 0, 0];
    bin[0] += r;
    bin[1] += g;
    bin[2] += b;
    bin[3]++;
    hist.set(key, bin);
  }
  if (!exact.size) throw new Error("Palette source has no visible pixels.");
  if (exact.size <= limit) return [...exact].map((c) => [c >> 16, (c >> 8) & 255, c & 255]);
  const bins = [...hist.values()].map(([r, g, b, n]) => [r / n, g / n, b / n, n]);
  function box(colors) {
    const low = [255, 255, 255],
      high = [0, 0, 0];
    let count = 0;
    for (const c of colors) {
      for (let k = 0; k < 3; k++) {
        low[k] = Math.min(low[k], c[k]);
        high[k] = Math.max(high[k], c[k]);
      }
      count += c[3];
    }
    const range = high.map((v, k) => v - low[k]),
      span = Math.max(...range);
    return { colors, count, axis: range.indexOf(span), score: colors.length > 1 ? span * count : 0 };
  }
  const boxes = [box(bins)];
  while (boxes.length < limit) {
    boxes.sort((a, b) => b.score - a.score);
    if (!boxes[0].score) break;
    const { colors, count, axis } = boxes.shift();
    colors.sort((a, b) => a[axis] - b[axis]);
    let cut = 0,
      weight = 0;
    do {
      weight += colors[cut++][3];
    } while (cut < colors.length - 1 && weight < count / 2);
    boxes.push(box(colors.slice(0, cut)), box(colors.slice(cut)));
  }
  return boxes.map(({ colors, count }) =>
    [0, 1, 2].map((k) => Math.round(colors.reduce((n, c) => n + c[k] * c[3], 0) / count)),
  );
}

export function slicePixels(model, { size, layers, axis, palette, outline }, supplied, bounds = expandModelBounds(model)) {
  if (axis === "auto") axis = model.kind === "splat" ? "z" : "y";
  const grid = gridFor(bounds, axis, size, layers),
    width = size * layers,
    rgba = new Uint8ClampedArray(width * size * 4);
  const index = (x, y, l) => (y * width + l * size + x) * 4;
  if (model.kind === "splat") paintSplats(grid, model, rgba, index);
  else
    paintMesh(grid, model, (x, y, l, c, onlyEmpty = false) => {
      const p = index(x, y, l);
      if (c[3] && (!onlyEmpty || !rgba[p + 3])) rgba.set(c, p);
    });
  let ink = [24, 24, 24];
  if (palette && (supplied || rgba.some((v, i) => i % 4 === 3 && v))) {
    // Reserve one ink color for generated palettes. An explicit reference
    // palette supplies its own darkest color for the outline.
    const reserveInk = outline && !supplied && palette > 1;
    const colors = paletteOf(supplied?.data || rgba, palette - Number(reserveInk));
    if (!reserveInk) ink = colors.reduce((a, b) => (a[0] + a[1] + a[2] <= b[0] + b[1] + b[2] ? a : b));
    const cache = new Map();
    for (let p = 0; p < rgba.length; p += 4) {
      if (!rgba[p + 3]) continue;
      const key = rgba[p] * 65536 + rgba[p + 1] * 256 + rgba[p + 2];
      let color = cache.get(key);
      if (!color) {
        let best = Infinity;
        for (const c of colors) {
          const d = (c[0] - rgba[p]) ** 2 + (c[1] - rgba[p + 1]) ** 2 + (c[2] - rgba[p + 2]) ** 2;
          if (d < best) {
            best = d;
            color = c;
          }
        }
        cache.set(key, color);
      }
      rgba.set(color, p);
    }
  }
  if (outline) {
    const before = rgba.slice();
    for (let l = 0; l < layers; l++)
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const p = index(x, y, l);
          if (before[p + 3]) continue;
          const alpha = Math.max(
            x > 0 ? before[p - 4 + 3] : 0,
            x + 1 < size ? before[p + 4 + 3] : 0,
            y > 0 ? before[p - width * 4 + 3] : 0,
            y + 1 < size ? before[p + width * 4 + 3] : 0,
          );
          if (alpha) {
            rgba.set(ink, p);
            rgba[p + 3] = alpha;
          }
        }
  }
  return {
    rgba,
    width,
    height: size,
    layout: {
      version: 1,
      order: "bottom-to-top",
      columns: layers,
      rows: 1,
      tileWidth: size,
      tileHeight: size,
      upAxis: axis,
      source: model.kind,
      bounds: { min: grid.min, max: grid.max },
      pixelSize: grid.unit,
      layerHeight: grid.step,
    },
  };
}
