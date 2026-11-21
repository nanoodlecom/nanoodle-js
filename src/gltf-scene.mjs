// The editor also embeds these helpers in its standalone GLB viewer.
export function ident() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
export function mul(a, b) {
  var o = new Array(16),
    c,
    r;
  for (c = 0; c < 4; c++)
    for (r = 0; r < 4; r++)
      o[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
export function trs(t, r, s) {
  var x = r[0],
    y = r[1],
    z = r[2],
    w = r[3];
  var sx = s[0],
    sy = s[1],
    sz = s[2];
  var x2 = x + x,
    y2 = y + y,
    z2 = z + z;
  var xx = x * x2,
    xy = x * y2,
    xz = x * z2,
    yy = y * y2,
    yz = y * z2,
    zz = z * z2;
  var wx = w * x2,
    wy = w * y2,
    wz = w * z2;
  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    t[0],
    t[1],
    t[2],
    1,
  ];
}
export function xform(m, x, y, z, dir) {
  var w = dir ? 0 : 1;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
  ];
}
export function unpackGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.length)
    throw new Error("Invalid GLB v2 header or length.");
  let json,
    bin = new Uint8Array(0);
  for (let p = 12; p < bytes.length; ) {
    if (p + 8 > bytes.length) throw new Error("Truncated GLB chunk header.");
    const length = view.getUint32(p, true),
      type = view.getUint32(p + 4, true);
    p += 8;
    if (p + length > bytes.length) throw new Error("Truncated GLB chunk.");
    const chunk = bytes.subarray(p, p + length);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk));
    if (type === 0x004e4942) bin = chunk;
    p += length;
  }
  return { json, bin };
}
