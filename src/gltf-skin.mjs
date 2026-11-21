import { ident, mul, trs, xform } from "./gltf-scene.mjs";

export function sceneNodes(json) {
  const nodes = json.nodes || [],
    parents = new Map();
  for (let i = 0; i < nodes.length; i++) {
    for (const child of nodes[i].children || []) {
      if (!nodes[child] || parents.has(child)) throw new Error("Invalid glTF node hierarchy.");
      parents.set(child, i);
    }
  }
  const roots =
    json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, i) => i).filter((i) => !parents.has(i));
  const stack = roots.slice().reverse(),
    active = new Set();
  while (stack.length) {
    const i = stack.pop();
    if (!nodes[i] || active.has(i)) throw new Error("Invalid or cyclic glTF node tree.");
    active.add(i);
    const children = nodes[i].children || [];
    for (let j = children.length - 1; j >= 0; j--) stack.push(children[j]);
  }
  return {
    active,
    worldMatrices(overrides) {
      const world = new Map();
      for (const i of active) {
        const node = nodes[i],
          pose = overrides?.get(i);
        let local = node.matrix;
        if (!local) {
          const q = pose?.rotation ?? node.rotation ?? [0, 0, 0, 1];
          const norm = Math.hypot(...q);
          if (!norm || !Number.isFinite(norm)) throw new Error("Invalid glTF rotation.");
          local = trs(
            pose?.translation ?? node.translation ?? [0, 0, 0],
            q.map((v) => v / norm),
            pose?.scale ?? node.scale ?? [1, 1, 1],
          );
        }
        const parent = world.get(parents.get(i));
        world.set(i, parent ? mul(parent, local) : local);
      }
      return world;
    },
  };
}

export function readSkin(json, skinIndex, accessor, scene) {
  const skin = json.skins?.[skinIndex];
  if (!skin?.joints?.length || skin.joints.some((j) => !scene.active.has(j)))
    throw new Error("glTF skin references missing joints in the scene.");
  const matrices = skin.inverseBindMatrices == null ? null : accessor(skin.inverseBindMatrices, ["MAT4"]);
  if (matrices && matrices.count < skin.joints.length) throw new Error("Missing glTF inverse bind matrices.");
  return skin.joints.map((node, i) => ({ node, bind: matrices?.data.subarray(i * 16, i * 16 + 16) }));
}

export function skinInfluences(json, attributes, count, joints, accessor) {
  const sets = [];
  const indices = Object.keys(attributes)
    .filter((name) => /^(JOINTS|WEIGHTS)_\d+$/.test(name))
    .map((name) => Number(name.split("_")[1]));
  if (!indices.includes(0)) throw new Error("A skinned glTF mesh requires JOINTS_0 and WEIGHTS_0.");
  for (const i of new Set(indices)) {
    const jointIndex = attributes["JOINTS_" + i],
      weightIndex = attributes["WEIGHTS_" + i];
    const jointType = json.accessors?.[jointIndex],
      weightType = json.accessors?.[weightIndex];
    if (
      !jointType ||
      ![5121, 5123].includes(jointType.componentType) ||
      jointType.normalized ||
      !weightType ||
      !(
        weightType.componentType === 5126 ||
        ([5121, 5123].includes(weightType.componentType) && weightType.normalized)
      )
    )
      throw new Error("Invalid glTF joint or weight attributes.");
    const joint = accessor(jointIndex, ["VEC4"], count).data,
      weight = accessor(weightIndex, ["VEC4"], count).data;
    if (joint.some((v) => v >= joints.length) || weight.some((w) => w < 0))
      throw new Error("Invalid glTF skin influence.");
    sets.push({ joint, weight });
  }
  return sets;
}

export function skinMatrices(joints, world) {
  return joints.map(({ node, bind }) => (bind ? mul(world.get(node), bind) : world.get(node)));
}

export function posedPositions(mesh, nodeMatrix, weights, jointMatrices) {
  const { base, targets, influences } = mesh;
  const positions = new Float64Array(base.length);
  if (weights && (weights.length !== targets.length || !weights.every(Number.isFinite)))
    throw new Error("Invalid glTF morph weights.");
  const matrix = nodeMatrix ?? ident();
  for (let p = 0; p < positions.length; p += 3) {
    let x = base[p],
      y = base[p + 1],
      z = base[p + 2];
    for (let m = 0; m < targets.length; m++) {
      const w = weights?.[m],
        delta = targets[m];
      if (!w || !delta) continue;
      x += w * delta[p];
      y += w * delta[p + 1];
      z += w * delta[p + 2];
    }
    if (!jointMatrices) positions.set(xform(matrix, x, y, z, false), p);
    else {
      // Joint matrices already contain the scene transform; the skinned mesh node's transform cancels out.
      let dx = 0,
        dy = 0,
        dz = 0,
        total = 0;
      for (const { joint, weight } of influences) {
        const offset = (p / 3) * 4;
        for (let k = offset; k < offset + 4; k++) {
          const w = weight[k];
          if (!w) continue;
          const j = jointMatrices[joint[k]];
          dx += w * (j[0] * x + j[4] * y + j[8] * z + j[12]);
          dy += w * (j[1] * x + j[5] * y + j[9] * z + j[13]);
          dz += w * (j[2] * x + j[6] * y + j[10] * z + j[14]);
          total += w;
        }
      }
      if (!total) throw new Error("A skinned glTF vertex has zero total joint weight.");
      positions[p] = dx / total;
      positions[p + 1] = dy / total;
      positions[p + 2] = dz / total;
    }
  }
  if (positions.some((v) => !Number.isFinite(v))) throw new Error("Invalid glTF scene transform.");
  return positions;
}
