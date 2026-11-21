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

// Invert each layer's orthographic transform at output pixel centers. This is
// nearest-neighbor sampling and source-over alpha, matching the editor canvas.
export function softwareFrame(sheet, fields, yaw) {
  const { tile, layers, scale, rise, squash, w, h } = viewPlan(sheet, fields);
  const data = new Uint8ClampedArray(w * h * 4);
  const angle = (yaw * Math.PI) / 180,
    c = Math.cos(angle),
    s = Math.sin(angle);
  const radius = (tile * scale * (Math.abs(c) + Math.abs(s))) / 2;
  const left = Math.max(0, Math.floor(w / 2 - radius)),
    right = Math.min(w, Math.ceil(w / 2 + radius));
  for (let l = 0; l < layers; l++) {
    const cy = h / 2 + ((layers - 1) / 2 - l) * rise * scale;
    const top = Math.max(0, Math.floor(cy - radius * squash)),
      bottom = Math.min(h, Math.ceil(cy + radius * squash));
    for (let y = top; y < bottom; y++) {
      const dy = (y + 0.5 - cy) / (scale * squash);
      for (let x = left; x < right; x++) {
        const dx = (x + 0.5 - w / 2) / scale;
        const u = Math.floor(c * dx + s * dy + tile / 2),
          v = Math.floor(-s * dx + c * dy + tile / 2);
        if (u < 0 || v < 0 || u >= tile || v >= tile) continue;
        const src = (v * sheet.width + l * tile + u) * 4,
          dst = (y * w + x) * 4,
          alpha = sheet.data[src + 3];
        if (!alpha) continue;
        if (alpha === 255 || !data[dst + 3]) {
          data.set(sheet.data.subarray(src, src + 4), dst);
        } else {
          const under = data[dst + 3] * (1 - alpha / 255),
            a = alpha + under;
          for (let k = 0; k < 3; k++)
            data[dst + k] = (sheet.data[src + k] * alpha + data[dst + k] * under) / a;
          data[dst + 3] = a;
        }
      }
    }
  }
  return { width: w, height: h, data };
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
