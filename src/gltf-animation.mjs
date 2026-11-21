// Sample each channel on its own keyframe timeline. glTF quaternions are xyzw.
function unitRotation(values) {
  const length = Math.hypot(...values);
  if (!length || !Number.isFinite(length)) throw new Error("Invalid glTF rotation quaternion.");
  return values.map((v) => v / length);
}

function slerp(a, b, u) {
  a = unitRotation(a);
  b = unitRotation(b);
  const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  if (dot < 0) b = b.map((v) => -v);
  const angle = Math.acos(Math.min(1, Math.abs(dot)));
  let left = 1 - u,
    right = u;
  if (angle > 0.00001) {
    left = Math.sin(left * angle) / Math.sin(angle);
    right = Math.sin(right * angle) / Math.sin(angle);
  }
  return unitRotation(a.map((v, i) => left * v + right * b[i]));
}

function sampleTrack(track, time) {
  const { times, values, width, interpolation, path } = track;
  const cubic = interpolation === "CUBICSPLINE";
  const read = (key, part = cubic ? 1 : 0) => {
    const at = (key * (cubic ? 3 : 1) + part) * width;
    return values.slice(at, at + width);
  };
  let lo = 0,
    hi = times.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (times[mid] <= time) lo = mid + 1;
    else hi = mid;
  }
  const key = Math.max(0, lo - 1);
  const a = read(key);
  if (!lo || lo === times.length || time === times[key] || interpolation === "STEP") {
    return path === "rotation" ? unitRotation(a) : a;
  }
  const b = read(lo),
    dt = times[lo] - times[key],
    u = (time - times[key]) / dt;
  if (!cubic) {
    return path === "rotation" ? slerp(a, b, u) : a.map((v, i) => v + u * (b[i] - v));
  }
  const u2 = u * u,
    u3 = u2 * u;
  const outgoing = read(key, 2),
    incoming = read(lo, 0);
  const value = a.map(
    (v, i) =>
      (2 * u3 - 3 * u2 + 1) * v +
      (u3 - 2 * u2 + u) * dt * outgoing[i] +
      (3 * u2 - 2 * u3) * b[i] +
      (u3 - u2) * dt * incoming[i],
  );
  return path === "rotation" ? unitRotation(value) : value;
}

export function prepareClip(json, accessor, clip, frames) {
  if (!Number.isInteger(frames) || frames < 1 || frames > 64)
    throw new Error("Slice 3D requires an integer frame count from 1 to 64.");
  if (!clip && frames === 1) return null;
  const clips = json.animations || [];
  const labels = clips.map((a, i) => a.name || "Animation " + (i + 1));
  const selected = clip ? labels.indexOf(clip) : 0;
  if (!clips[selected]) {
    throw new Error(
      labels.length
        ? "Unknown glTF clip " + clip + ". Available clips: " + labels.join(", ")
        : "No animation clips in this model. Use one frame for the rest pose.",
    );
  }
  const animation = clips[selected];
  const tracks = [];
  let start = Infinity,
    end = -Infinity;
  for (const channel of animation.channels || []) {
    const { node, path } = channel.target;
    if (node == null) continue; // Extension-only animation targets have no core glTF node.
    const target = json.nodes?.[node],
      sampler = animation.samplers?.[channel.sampler];
    if (!target || !sampler || !["translation", "scale", "rotation", "weights"].includes(path))
      throw new Error("Invalid glTF animation channel.");
    if (target.matrix && path !== "weights") throw new Error("Cannot animate TRS on a glTF matrix node.");
    const interpolation = sampler.interpolation ?? "LINEAR";
    if (!["STEP", "LINEAR", "CUBICSPLINE"].includes(interpolation))
      throw new Error("Unsupported glTF interpolation: " + interpolation);
    const times = accessor(sampler.input, ["SCALAR"]).data;
    if (times[0] < 0 || times.some((t, i) => i > 0 && t <= times[i - 1]))
      throw new Error("glTF keyframe times must be nonnegative and strictly increasing.");
    const morph = path === "weights",
      rotation = path === "rotation";
    const width = morph ? json.meshes?.[target.mesh]?.primitives?.[0]?.targets?.length : rotation ? 4 : 3;
    if (!width) throw new Error("Animation weights require morph targets.");
    const count = times.length * (interpolation === "CUBICSPLINE" ? 3 : 1) * (morph ? width : 1);
    const values = accessor(sampler.output, [morph ? "SCALAR" : rotation ? "VEC4" : "VEC3"], count).data;
    tracks.push({ node, path, times, values, width, interpolation });
    start = Math.min(start, times[0]);
    end = Math.max(end, times[times.length - 1]);
  }
  if (!tracks.length) throw new Error("Selected glTF clip has no supported node animation channels.");
  const duration = end - start;
  if (duration === 0 && frames > 1) throw new Error("This glTF clip has zero duration. Use one frame.");
  const times = Array.from({ length: frames }, (_, i) => start + (duration * i) / frames);
  return {
    info: { clip: labels[selected], frames, duration, times },
    sample(time) {
      const overrides = new Map();
      for (const track of tracks) {
        if (!overrides.has(track.node)) overrides.set(track.node, {});
        overrides.get(track.node)[track.path] = sampleTrack(track, time);
      }
      return overrides;
    },
  };
}
