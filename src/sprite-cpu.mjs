import { bytesToDataUrl, sniffMime, extForMime } from "./media.mjs";
import { decodePng, encodePngRgba, runProc, withTemp } from "./local-media.mjs";
import { softwareFrame, turntablePlan } from "./sprite-projection.mjs";

export async function decodeSpriteImage(blob, signal) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes[0] === 137 && bytes[1] === 80) {
    try {
      const { w, h, rgba } = await decodePng(bytes, true);
      return { width: w, height: h, data: rgba };
    } catch (error) {
      if (signal?.aborted) throw error;
      // FFmpeg handles indexed, interlaced and higher-bit-depth PNGs.
    }
  }
  return withTemp(async (dir) => {
    const { writeFile, readFile } = await import("node:fs/promises");
    const input = dir + "/source." + extForMime(sniffMime(bytes)),
      output = dir + "/image.png";
    await writeFile(input, bytes);
    await runProc(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-f",
        "image2",
        "-i",
        input,
        "-frames:v",
        "1",
        "-pix_fmt",
        "rgba",
        "-c:v",
        "png",
        output,
      ],
      { signal },
    );
    const { w, h, rgba } = await decodePng(new Uint8Array(await readFile(output)), true);
    return { width: w, height: h, data: rgba };
  });
}

export async function frameUrl(frame) {
  return bytesToDataUrl(await encodePngRgba(frame.width, frame.height, frame.data), "image/png");
}

export async function encodeTurntable(sheet, fields, signal) {
  const { duration, from, to, count } = turntablePlan(fields);
  return withTemp(async (dir) => {
    const { writeFile, readFile } = await import("node:fs/promises");
    for (let i = 0; i < count; i++) {
      signal?.throwIfAborted();
      const frame = softwareFrame(sheet, fields, from + ((to - from) * i) / (count - 1));
      const png = await encodePngRgba(frame.width, frame.height, frame.data);
      await writeFile(dir + "/" + String(i).padStart(5, "0") + ".png", png);
    }
    const args = [
      "-nostdin",
      "-v",
      "error",
      "-framerate",
      String(count / duration),
      "-i",
      dir + "/%05d.png",
      "-an",
    ];
    const out = dir + "/turntable.mp4";
    try {
      await runProc(
        "ffmpeg",
        [...args, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
        { signal },
      );
    } catch (error) {
      if (!/unknown encoder.*libx264|encoder.*libx264.*not found/i.test(error.message)) throw error;
      await runProc(
        "ffmpeg",
        [...args, "-y", "-c:v", "mpeg4", "-q:v", "3", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
        { signal },
      );
    }
    return bytesToDataUrl(new Uint8Array(await readFile(out)), "video/mp4");
  });
}
