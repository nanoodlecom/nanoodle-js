// Two closed, offset boxes with contrasting materials under a translated parent.
export function asymmetricMesh() {
  const positions = [];
  function box(x0, y0, z0, x1, y1, z1) {
    const corners = [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y0, z1],
      [x0, y0, z1],
      [x0, y1, z0],
      [x1, y1, z0],
      [x1, y1, z1],
      [x0, y1, z1],
    ];
    for (const i of [
      0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4,
      0,
    ])
      positions.push(...corners[i]);
  }
  box(-2, 0, -1, 2, 1, 1);
  box(0.75, 1, -0.75, 1.75, 4, 0.25);
  const data = Buffer.from(new Float32Array(positions).buffer);
  return {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ translation: [4, 5, 6], children: [1] }, { mesh: 0 }],
    buffers: [
      { byteLength: data.length, uri: "data:application/octet-stream;base64," + data.toString("base64") },
    ],
    bufferViews: [{ buffer: 0, byteLength: data.length }],
    accessors: [0, 36 * 12].map((byteOffset) => ({
      bufferView: 0,
      byteOffset,
      componentType: 5126,
      type: "VEC3",
      count: 36,
    })),
    materials: [
      [1, 0, 0, 1],
      [0, 0, 1, 1],
    ].map((baseColorFactor) => ({ pbrMetallicRoughness: { baseColorFactor } })),
    meshes: [{ primitives: [0, 1].map((i) => ({ attributes: { POSITION: i }, material: i })) }],
  };
}
export function splatFixture(binary = false) {
  const names = "x y z f_dc_0 f_dc_1 f_dc_2 opacity scale_0 scale_1 scale_2 rot_0 rot_1 rot_2 rot_3".split(
    " ",
  );
  const rows = [
    [0, 0, 0, 1.77, -1.77, -1.77, 2, -1, -2, -2, 1, 0, 0, 0],
    [1, 0.2, 1.8, -1.77, -1.77, 1.77, 1, -1, -2, -2, Math.SQRT1_2, 0, 0, Math.SQRT1_2],
  ];
  const header = [
    "ply",
    "format " + (binary ? "binary_little_endian" : "ascii") + " 1.0",
    "element vertex 2",
    ...names.map((n) => "property float " + n),
    "end_header",
    "",
  ].join("\n");
  return Buffer.concat([
    Buffer.from(header),
    binary
      ? Buffer.from(new Float32Array(rows.flat()).buffer)
      : Buffer.from(rows.map((row) => row.join(" ")).join("\n") + "\n"),
  ]);
}
