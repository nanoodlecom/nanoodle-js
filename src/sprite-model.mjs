import { dataUrlBytes } from "./media.mjs";

import { ident, mul, trs, xform, unpackGlb } from "./gltf-scene.mjs";

const decodeText = bytes => new TextDecoder().decode(bytes);
const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const glTypes = {
  5120: [1, "getInt8", 127],
  5121: [1, "getUint8", 255],
  5122: [2, "getInt16", 32767],
  5123: [2, "getUint16", 65535],
  5125: [4, "getUint32", 4294967295],
  5126: [4, "getFloat32", 1],
};

function unpack(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4 || view.getUint32(0, true) !== 0x46546c67) {
    try {
      return { json: JSON.parse(decodeText(bytes)) };
    } catch {
      throw new Error("Expected a GLB, a self-contained glTF 2 mesh, or a Gaussian PLY.");
    }
  }
  return unpackGlb(bytes);
}

function embedded(uri) {
  if (!uri?.startsWith("data:"))
    throw new Error("External glTF buffers and images require a self-contained .gltf or .glb export.");
  return dataUrlBytes(uri);
}

export async function triangleModel(bytes, imagePixels) {
  const { json, bin } = unpack(bytes);
  if (json?.asset?.version !== "2.0") throw new Error("Expected glTF 2.0.");
  if (json.extensionsRequired?.length)
    throw new Error("Unsupported required glTF extensions: " + json.extensionsRequired.join(", "));
  const buffers = (json.buffers || []).map((b, i) => {
    const data = b.uri ? embedded(b.uri).bytes : i === 0 && bin;
    if (!data || data.length < b.byteLength) throw new Error("Missing or truncated glTF buffer.");
    return data;
  });
  function bufferView(index) {
    const bv = json.bufferViews?.[index],
      buffer = buffers[bv?.buffer],
      start = bv?.byteOffset ?? 0;
    if (
      !buffer ||
      !Number.isSafeInteger(bv.byteLength) ||
      start < 0 ||
      bv.byteLength < 0 ||
      start + bv.byteLength > buffer.length
    )
      throw new Error("Invalid glTF buffer view.");
    if (bv.extensions?.EXT_meshopt_compression)
      throw new Error("Meshopt-compressed buffers are unsupported.");
    return buffer.subarray(start, start + bv.byteLength);
  }
  function accessor(index, shapes, count) {
    const a = json.accessors?.[index],
      spec = glTypes[a?.componentType];
    if (!a || !spec || !shapes.includes(a.type) || a.sparse || a.bufferView == null)
      throw new Error("Unsupported glTF accessor type or sparse encoding.");
    const n = components[a.type],
      [size, get, max] = spec,
      buf = bufferView(a.bufferView);
    const stride = json.bufferViews[a.bufferView].byteStride ?? n * size,
      offset = a.byteOffset ?? 0;
    if (
      !Number.isSafeInteger(a.count) ||
      a.count < 1 ||
      (count != null && a.count !== count) ||
      offset < 0 ||
      stride < n * size ||
      offset + (a.count - 1) * stride + n * size > buf.length
    )
      throw new Error("Invalid glTF accessor bounds or count.");
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength),
      data = new Float64Array(n * a.count);
    for (let i = 0; i < a.count; i++)
      for (let c = 0; c < n; c++) {
        const v = view[get](offset + i * stride + c * size, true);
        if (!Number.isFinite(v)) throw new Error("Non-finite glTF attribute.");
        data[i * n + c] = a.normalized ? Math.max(-1, v / max) : v;
      }
    return { data, n, count: a.count };
  }
  const textures = new Map();
  async function texture(info) {
    const tex = json.textures?.[info.index],
      img = json.images?.[tex?.source];
    if (!img || info.extensions?.KHR_texture_transform)
      throw new Error("Unsupported base-color texture encoding or transform.");
    if (!textures.has(tex.source)) {
      const image = img.uri ? embedded(img.uri) : { bytes: bufferView(img.bufferView), mime: img.mimeType };
      textures.set(tex.source, await imagePixels(new Blob([image.bytes], { type: image.mime })));
    }
    return { pixels: textures.get(tex.source), sampler: json.samplers?.[tex.sampler] || {} };
  }
  const meshes = [];
  async function emit(index, world) {
    if (!json.meshes?.[index]) throw new Error("Missing glTF mesh.");
    for (const p of json.meshes[index].primitives) {
      const mode = p.mode ?? 4;
      if (![4, 5, 6].includes(mode))
        throw new Error(
          "Slice 3D requires triangles. For a point-cloud preview, supply the original Gaussian PLY.",
        );
      if (p.targets?.length || p.extensions?.KHR_draco_mesh_compression)
        throw new Error("Morph targets and Draco-compressed meshes are unsupported.");
      const pos = accessor(p.attributes.POSITION, ["VEC3"]);
      for (let i = 0; i < pos.data.length; i += 3) {
        const point = xform(world, pos.data[i], pos.data[i + 1], pos.data[i + 2], false);
        if (!point.every(Number.isFinite)) throw new Error("Invalid glTF scene transform.");
        pos.data.set(point, i);
      }
      if (p.indices != null) {
        const indexSpec = json.accessors?.[p.indices];
        if (!indexSpec || ![5121, 5123, 5125].includes(indexSpec.componentType) || indexSpec.normalized)
          throw new Error("glTF triangle indices must be unsigned integers.");
      }
      const idx = p.indices != null ? accessor(p.indices, ["SCALAR"]).data : null;
      if (idx?.some((v) => !Number.isInteger(v) || v < 0 || v >= pos.count))
        throw new Error("Invalid triangle index.");
      const length = idx?.length ?? pos.count;
      if (length < 3 || (mode === 4 && length % 3)) throw new Error("Incomplete triangle primitive.");
      const mat = json.materials?.[p.material] || {},
        pbr = mat.pbrMetallicRoughness || {},
        info = pbr.baseColorTexture;
      const factor = pbr.baseColorFactor ?? [1, 1, 1, 1];
      if (
        !Array.isArray(factor) ||
        factor.length !== 4 ||
        !factor.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
      )
        throw new Error("Invalid glTF base color factor.");
      if (mat.alphaMode != null && !["OPAQUE", "MASK", "BLEND"].includes(mat.alphaMode))
        throw new Error("Invalid glTF alpha mode.");
      const color =
        p.attributes.COLOR_0 == null ? null : accessor(p.attributes.COLOR_0, ["VEC3", "VEC4"], pos.count);
      const uv = info
        ? accessor(p.attributes["TEXCOORD_" + (info.texCoord ?? 0)], ["VEC2"], pos.count)
        : null;
      meshes.push({
        positions: pos.data,
        idx,
        mode,
        length,
        color,
        uv,
        texture: info && (await texture(info)),
        factor,
        alphaMode: mat.alphaMode || "OPAQUE",
        cutoff: mat.alphaCutoff ?? 0.5,
      });
    }
  }
  const active = new Set(),
    nodes = json.nodes || [];
  async function walk(i, parent) {
    const node = nodes[i];
    if (!node || active.has(i)) throw new Error("Invalid or cyclic glTF node tree.");
    if (node.skin != null) throw new Error("Skinned meshes require a static mesh export.");
    active.add(i);
    const world = mul(
      parent,
      node.matrix ||
        trs(node.translation || [0, 0, 0], node.rotation || [0, 0, 0, 1], node.scale || [1, 1, 1]),
    );
    if (node.mesh != null) await emit(node.mesh, world);
    for (const child of node.children || []) await walk(child, world);
    active.delete(i);
  }
  if (nodes.length) {
    const children = new Set(nodes.flatMap((n) => n.children || []));
    const roots =
      json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, i) => i).filter((i) => !children.has(i));
    for (const root of roots) await walk(root, ident());
  } else for (let i = 0; i < (json.meshes || []).length; i++) await emit(i, ident());
  if (!meshes.length) throw new Error("No triangles in the selected glTF scene.");
  return { kind: "mesh", meshes };
}

const plyTypes = {
  char: glTypes[5120],
  int8: glTypes[5120],
  uchar: glTypes[5121],
  uint8: glTypes[5121],
  short: glTypes[5122],
  int16: glTypes[5122],
  ushort: glTypes[5123],
  uint16: glTypes[5123],
  int: [4, "getInt32"],
  int32: [4, "getInt32"],
  uint: glTypes[5125],
  uint32: glTypes[5125],
  float: glTypes[5126],
  float32: glTypes[5126],
  double: [8, "getFloat64"],
  float64: [8, "getFloat64"],
};

export function gaussianModel(bytes) {
  const head = decodeText(bytes.subarray(0, 65536)),
    end = /^end_header\r?\n/m.exec(head);
  if (!end) throw new Error("Missing PLY header terminator.");
  const header = head.slice(0, end.index + end[0].length),
    offset = new TextEncoder().encode(header).length;
  let format,
    count,
    stride = 0,
    element;
  const props = new Map();
  for (const line of header.trim().split(/\r?\n/)) {
    const [key, a, b, version] = line.trim().split(/\s+/);
    if (key === "format") {
      if (b !== "1.0" || !["ascii", "binary_little_endian"].includes(a))
        throw new Error("Supported Gaussian PLY formats are ASCII and binary little-endian 1.0.");
      format = a;
    }
    if (key === "element") {
      element = a;
      if (a !== "vertex" && Number(b) !== 0)
        throw new Error("Expected an uncompressed vertex-only Gaussian PLY.");
      if (a === "vertex") count = Number(b);
    }
    if (key === "property" && element === "vertex") {
      if (!plyTypes[a] || version || props.has(b))
        throw new Error("Unsupported Gaussian PLY property encoding.");
      props.set(b, { type: plyTypes[a], offset: stride, index: props.size });
      stride += plyTypes[a][0];
    }
  }
  const required = [
    "x",
    "y",
    "z",
    "opacity",
    "scale_0",
    "scale_1",
    "scale_2",
    "rot_0",
    "rot_1",
    "rot_2",
    "rot_3",
  ];
  const dc = ["f_dc_0", "f_dc_1", "f_dc_2"],
    rgb = ["red", "green", "blue"];
  const hasDC = dc.every((p) => props.has(p));
  if (!format || !required.every((p) => props.has(p)) || !(hasDC || rgb.every((p) => props.has(p))))
    throw new Error(
      "Expected Gaussian PLY positions, log scales, quaternion, opacity logit, and DC or RGB colors. Ordinary point clouds are unsupported.",
    );
  if (!hasDC && rgb.some((name) => props.get(name).type !== glTypes[5121]))
    throw new Error(
      "Gaussian RGB properties must be unsigned bytes, or supply floating-point DC coefficients.",
    );
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid Gaussian PLY vertex count.");
  const rows = format === "ascii" ? decodeText(bytes.subarray(offset)).trim().split(/\r?\n/) : null;
  if (rows ? rows.length !== count : count * stride !== bytes.length - offset)
    throw new Error("Gaussian PLY payload does not match its declared vertex count.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    splats = [];
  for (let i = 0; i < count; i++) {
    const row = rows && rows[i].trim().split(/\s+/);
    if (row && row.length !== props.size) throw new Error("Invalid ASCII PLY vertex.");
    const read = (key) => {
      const p = props.get(key);
      const v = row ? Number(row[p.index]) : view[p.type[1]](offset + i * stride + p.offset, true);
      if (!Number.isFinite(v)) throw new Error("Non-finite Gaussian PLY attribute.");
      return v;
    };
    const center = ["x", "y", "z"].map(read),
      scales = ["scale_0", "scale_1", "scale_2"].map((p) => Math.exp(read(p)));
    const quaternion = ["rot_0", "rot_1", "rot_2", "rot_3"].map(read),
      norm = Math.hypot(...quaternion);
    if (!norm || !scales.every((s) => Number.isFinite(s) && s > 0))
      throw new Error("Invalid Gaussian scale or rotation.");
    const [w, x, y, z] = quaternion.map((v) => v / norm);
    const rotation = trs([0, 0, 0], [x, y, z, w], [1, 1, 1]);
    const extent = center.map((_, k) => 3 * Math.hypot(...scales.map((s, j) => rotation[j * 4 + k] * s)));
    const color = hasDC ? dc.map((p) => 255 * (0.5 + 0.2820947918 * read(p))) : rgb.map(read);
    splats.push({ center, scales, rotation, extent, color, alpha: 1 / (1 + Math.exp(-read("opacity"))) });
  }
  return { kind: "splat", splats };
}
