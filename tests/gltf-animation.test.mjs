import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { triangleModel, trianglePoses } from "../src/sprite-model.mjs";

function rig() {
  const scene = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { translation: [3, 0, 0], children: [1, 2] },
      { translation: [100, 0, 0], mesh: 0, skin: 0 },
      { translation: [0, 1, 0], children: [3] },
      { translation: [0, 2, 0] },
    ],
    buffers: [],
    bufferViews: [],
    accessors: [],
    meshes: [{ primitives: [{ attributes: {} }] }],
    skins: [{ joints: [2, 3] }],
    animations: [],
  };
  function view(array) {
    const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    const buffer =
      scene.buffers.push({
        byteLength: bytes.length,
        uri: "data:application/octet-stream;base64," + bytes.toString("base64"),
      }) - 1;
    return scene.bufferViews.push({ buffer, byteLength: bytes.length }) - 1;
  }
  function accessor(type, values, byte = false, normalized = false) {
    const width = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    return (
      scene.accessors.push({
        type,
        componentType: byte ? 5121 : 5126,
        normalized,
        count: values.length / width,
        bufferView: view(byte ? Uint8Array.from(values) : Float32Array.from(values)),
      }) - 1
    );
  }
  const primitive = scene.meshes[0].primitives[0];
  const bind = (y) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, y, 0, 1];
  scene.skins[0].inverseBindMatrices = accessor("MAT4", [...bind(-1), ...bind(-3)]);
  primitive.attributes = {
    POSITION: accessor("VEC3", [0, 1, 0, 1, 3, 0, 0, 4, 1]),
    JOINTS_0: accessor("VEC4", [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0], true),
    WEIGHTS_0: accessor("VEC4", [255, 0, 0, 0, 255, 0, 0, 0, 128, 0, 0, 0], true, true),
    JOINTS_1: accessor("VEC4", [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], true),
    WEIGHTS_1: accessor("VEC4", [0, 0, 0, 0, 0, 0, 0, 0, 127, 0, 0, 0], true, true),
  };
  return {
    scene,
    primitive,
    accessor,
    view,
    channel(name, path, interpolation, times, values, node = 3) {
      const type = { translation: "VEC3", scale: "VEC3", rotation: "VEC4", weights: "SCALAR" }[path];
      let clip = scene.animations.find((a) => a.name === name);
      if (!clip) {
        clip = { name, samplers: [], channels: [] };
        scene.animations.push(clip);
      }
      const sampler =
        clip.samplers.push({
          input: accessor("SCALAR", times),
          output: accessor(type, values),
          interpolation,
        }) - 1;
      clip.channels.push({ target: { node, path }, sampler });
    },
    load: (options) => trianglePoses(Buffer.from(JSON.stringify(scene)), undefined, options),
  };
}
function close(actual, expected, tolerance = 1e-7) {
  assert.equal(actual.length, expected.length);
  expected.forEach((v, i) =>
    assert.ok(Math.abs(actual[i] - v) <= tolerance, i + ": " + actual[i] + " vs " + v),
  );
}

test("rest pose uses inverse binds, ancestor transforms and both sets of vertex influences", async () => {
  const f = rig();
  const rest = await triangleModel(Buffer.from(JSON.stringify(f.scene)));
  close(rest.meshes[0].positions, [3, 1, 0, 4, 3, 0, 3, 4, 1]);
  f.channel("Stride", "translation", "LINEAR", [2, 4], [0, 2, 0, 4, 2, 0]);
  const source = await f.load({ frames: 2 });
  assert.deepEqual(source.animation, { clip: "Stride", frames: 2, duration: 2, times: [2, 3] });
  close(source.pose(1).meshes[0].positions, [3, 1, 0, 6, 3, 0, 3 + (2 * 127) / 255, 4, 1]);
  close(source.pose(0).meshes[0].positions, rest.meshes[0].positions);
});

test("STEP respects exact key boundaries and LINEAR rotations take the shortest arc", async () => {
  const f = rig();
  f.channel("Stride", "translation", "STEP", [2, 3, 4], [0, 2, 0, 4, 2, 0, 0, 2, 0]);
  const source = await f.load({ frames: 4 });
  close(source.pose(1).meshes[0].positions.slice(3, 6), [4, 3, 0]);
  close(source.pose(2).meshes[0].positions.slice(3, 6), [8, 3, 0]);
  f.channel("Turn", "rotation", "LINEAR", [0, 1], [0, 0, 0, 1, 0, 0, -Math.SQRT1_2, -Math.SQRT1_2]);
  const turn = await f.load({ clip: "Turn", frames: 2 });
  close(turn.pose(1).meshes[0].positions.slice(3, 6), [3 + Math.SQRT1_2, 3 + Math.SQRT1_2, 0]);
});

test("sparse morphs are applied before skinning and cubic Hermite tangents scale with key duration", async () => {
  const f = rig();
  const morph =
    f.scene.accessors.push({
      count: 3,
      type: "VEC3",
      componentType: 5126,
      sparse: {
        count: 1,
        indices: { bufferView: f.view(Uint8Array.of(1)), componentType: 5121 },
        values: { bufferView: f.view(Float32Array.of(0, 2, 0)) },
      },
    }) - 1;
  f.primitive.targets = [{ POSITION: morph }];
  f.scene.meshes[0].weights = [1];
  f.scene.nodes[1].weights = [0.25];
  f.scene.nodes[3].rotation = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  close((await f.load()).pose(0).meshes[0].positions.slice(3, 6), [2.5, 4, 0]);
  f.channel("Stretch", "weights", "CUBICSPLINE", [2, 4], [0, 0, 2, 0, 1, 0], 1);
  // At t=3, the tangent contributes .125 * 2 sec * 2 and the endpoint contributes .5.
  const source = await f.load({ frames: 2 });
  close(source.pose(1).meshes[0].positions.slice(3, 6), [1, 4, 0]);
});

test("groups channels by clip, clamps tracks to endpoints, and names unlabelled clips by source index", async () => {
  const f = rig();
  f.channel("First", "translation", "STEP", [0], [0, 1, 2]);
  f.channel(undefined, "scale", "LINEAR", [3, 4], [1, 1, 1, 2, 1, 1]);
  f.channel(undefined, "translation", "LINEAR", [2, 6], [0, 2, 0, 0, 2, 0]);
  const clip = await f.load({ clip: "Animation 2", frames: 4 });
  assert.deepEqual(clip.animation.times, [2, 3, 4, 5]);
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => clip.pose(i).meshes[0].positions[3]),
    [4, 4, 5, 5],
  );
  assert.throws(() => clip.pose(4), /frame index/);
  await assert.rejects(f.load({ clip: "unknown" }), /First, Animation 2/);
  await assert.rejects(f.load({ frames: 2 }), /zero duration/);
  await assert.rejects(f.load({ frames: 65 }), /1 to 64/);
  assert.equal((await f.load()).animation, null);
});

test("invalid joint and sparse index data give concrete geometry errors", async () => {
  const f = rig();
  f.primitive.attributes.JOINTS_0 = f.accessor("VEC4", Array(12).fill(4), true);
  await assert.rejects(f.load(), /skin influence/);
  delete f.scene.nodes[1].skin;
  f.primitive.targets = [
    {
      POSITION:
        f.scene.accessors.push({
          type: "VEC3",
          count: 3,
          componentType: 5126,
          sparse: {
            count: 1,
            indices: { bufferView: f.view(Uint8Array.of(3)), componentType: 5121 },
            values: { bufferView: f.view(Float32Array.of(1, 2, 3)) },
          },
        }) - 1,
    },
  ];
  await assert.rejects(f.load(), /sparse index/);
});

test("Fox GLB matches independent reference vertices for all three authored skeletal clips", async () => {
  const bytes = await readFile(new URL("./fixtures/fox/Fox.glb", import.meta.url));
  // World-space coordinates at 3/8 of each loop, independently evaluated using NumPy and SciPy.
  const vertices = {
    Walk: [
      [0.198643, 34.741443, -23.384502],
      [7.148927, 25.094804, -21.658864],
    ],
    Survey: [
      [-0.000299, 33.429106, -23.101277],
      [7.066817, 29.32879, -13.332232],
    ],
    Run: [
      [0.077313, 33.638964, -27.564522],
      [10.537181, 23.577532, -30.126275],
    ],
  };
  for (const [clip, [v1, v489]] of Object.entries(vertices)) {
    let textureReads = 0;
    const poses = await trianglePoses(
      bytes,
      () => {
        textureReads++;
        return null;
      },
      { clip, frames: 8 },
    );
    const positions = poses.pose(3).meshes[0].positions;
    close(positions.subarray(3, 6), v1, 1e-5);
    close(positions.subarray(489 * 3, 490 * 3), v489, 1e-5);
    poses.pose(5);
    assert.equal(textureReads, 1);
  }
});
