export function number(fields, key, fallback, min, max, integer = false) {
  const value = fields[key] == null || fields[key] === "" ? fallback : Number(fields[key]);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
    throw new Error(
      key + " must be " + (integer ? "an integer " : "") + "between " + min + " and " + max + ".",
    );
  return value;
}

export function viewPlan(sheet, fields) {
  const tile = sheet.height,
    layers = sheet.width / tile;
  if (!Number.isInteger(layers) || layers < 8 || layers > 128 || tile < 16 || tile > 128)
    throw new Error("Expected a horizontal Slice 3D sheet with 8–128 square tiles of 16–128 pixels.");
  const pitch = (number(fields, "pitch", 30, 0, 90) * Math.PI) / 180,
    scale = number(fields, "scale", 3, 1, 8);
  const spacing = (number(fields, "spacing", 1, 0, 4) * (tile - 2)) / layers;
  const rise = spacing * Math.cos(pitch),
    squash = Math.max(1 / tile, Math.sin(pitch));
  // Fixed even bounds for every yaw, including both turntable endpoints.
  const floor = tile * Math.SQRT2;
  const w = 2 * Math.ceil((floor * scale + 4) / 2),
    h = 2 * Math.ceil(((floor * squash + rise * (layers - 1)) * scale + 4) / 2);
  return { tile, layers, scale, rise, squash, w, h };
}

// Scan transparency once per sheet. Empty sky and empty layers are common in a sliced mesh.
function occupiedLayers(sheet, plan) {
  const { tile, layers, rise, scale, h } = plan;
  const result = [];
  for (let layer = 0; layer < layers; layer++) {
    let left = tile, top = tile, right = 0, bottom = 0;
    for (let y = 0; y < tile; y++) {
      let alpha = (y * sheet.width + layer * tile) * 4 + 3;
      for (let x = 0; x < tile; x++, alpha += 4) {
        if (!sheet.data[alpha]) continue;
        left = Math.min(left, x);
        right = Math.max(right, x + 1);
        top = Math.min(top, y);
        bottom = y + 1;
      }
    }
    if (right === 0) continue;
    result.push({
      offset: layer * tile,
      x: (left + right - tile) / 2, y: (top + bottom - tile) / 2,
      halfWidth: (right - left) / 2, halfHeight: (bottom - top) / 2,
      cy: h / 2 + ((layers - 1) / 2 - layer) * rise * scale,
    });
  }
  return result;
}

// Invert the orthographic transform at each output pixel center, then composite
// layers in ground-to-top order. draw() can be reused for every turntable angle.
export function softwareView(sheet, fields) {
  const plan = viewPlan(sheet, fields);
  const { tile, scale, squash, w, h } = plan;
  const layers = occupiedLayers(sheet, plan);
  return function draw(yaw) {
    const data = new Uint8ClampedArray(w * h * 4);
    const angle = (yaw * Math.PI) / 180, c = Math.cos(angle), s = Math.sin(angle);
    const cosX = new Float64Array(w), sinX = new Float64Array(w);
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - w / 2) / scale;
      cosX[x] = c * dx;
      sinX[x] = -s * dx;
    }
    for (const layer of layers) {
      const cx = w / 2 + scale * (c * layer.x - s * layer.y);
      const cy = layer.cy + scale * squash * (s * layer.x + c * layer.y);
      const rx = scale * (Math.abs(c) * layer.halfWidth + Math.abs(s) * layer.halfHeight);
      const ry = scale * squash * (Math.abs(s) * layer.halfWidth + Math.abs(c) * layer.halfHeight);
      const left = Math.max(0, Math.floor(cx - rx)), right = Math.min(w, Math.ceil(cx + rx));
      const top = Math.max(0, Math.floor(cy - ry)), bottom = Math.min(h, Math.ceil(cy + ry));
      for (let y = top; y < bottom; y++) {
        const dy = (y + 0.5 - layer.cy) / (scale * squash);
        const sinY = s * dy, cosY = c * dy;
        for (let x = left; x < right; x++) {
          const u = Math.floor(cosX[x] + sinY + tile / 2), v = Math.floor(sinX[x] + cosY + tile / 2);
          if (u < 0 || u >= tile || v < 0 || v >= tile) continue;
          const src = (v * sheet.width + layer.offset + u) * 4, alpha = sheet.data[src + 3];
          if (!alpha) continue;
          const dst = (y * w + x) * 4;
          if (alpha === 255 || !data[dst + 3]) {
            data[dst] = sheet.data[src];
            data[dst + 1] = sheet.data[src + 1];
            data[dst + 2] = sheet.data[src + 2];
            data[dst + 3] = alpha;
          } else {
            const under = data[dst + 3] * (1 - alpha / 255), a = alpha + under;
            for (let k = 0; k < 3; k++)
              data[dst + k] = (sheet.data[src + k] * alpha + data[dst + k] * under) / a;
            data[dst + 3] = a;
          }
        }
      }
    }
    return { width: w, height: h, data };
  };
}

export function flag(value, fallback) {
  return value == null ? fallback : value === true || value === "true";
}
export function turntablePlan(fields) {
  const fps = number(fields, "fps", 24, 1, 60, true),
    duration = number(fields, "duration", 3, 0.25, 30);
  const from = number(fields, "yawStart", 0, -3600, 3600),
    to = number(fields, "yawEnd", 360, -3600, 3600);
  return { fps, duration, from, to, count: Math.max(2, Math.round(fps * duration)) };
}
