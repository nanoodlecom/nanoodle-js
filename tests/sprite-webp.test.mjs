import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { decodeSpriteBytes } from "../src/sprite-image.mjs";

// Expected straight RGBA is from libwebp. The first-frame bounds, EXIF
// behavior and transparent animation canvas were also checked in Chromium.
// Ignore hidden RGB in fully transparent pixels.
function pixelHash(source) {
  const pixels = Uint8Array.from(source);
  for (let i = 0; i < pixels.length; i += 4) {
    if (!pixels[i + 3]) pixels.fill(0, i, i + 3);
  }
  return createHash("sha256").update(pixels).digest("hex");
}

const samples = [
  ["lossless", 37, 29, "25408f8911e792b93f702a68a811f5a8720b1b3fcbc13cb83c2c3437b737af43"],
  ["lossy", 41, 33, "7e1295088e2ea3059b0df89d21d0ad8a997c7712d703f4006d659be5598631fb"],
  ["alpha", 39, 35, "78ae094111fe0ac978297312fe9600e2f13f554fbf1cce3fc0a5dd15d866a6c1"],
  ["exif-6", 128, 16, "6ac39468197632df377eacaed98bc6a23e67ab1f7efdb0ce67268499753aa43b"],
  // First ANMF has a (2,2) offset. The ANIM background is opaque.
  // Both blend modes display the first frame on an otherwise transparent canvas.
  ["anim-webp-0", 8, 8, "401733a40ab2df2bd65f9d708b8db17b4d35822fe00f6ee9b6cdddee6b7ebdfb"],
  ["anim-webp-1", 8, 8, "401733a40ab2df2bd65f9d708b8db17b4d35822fe00f6ee9b6cdddee6b7ebdfb"],
];

for (const [name, width, height, digest] of samples) {
  test("sprite input decodes " + name + " WebP", async () => {
    const input = await readFile(new URL("./fixtures/sprite-webp/" + name + ".webp", import.meta.url));
    const image = await decodeSpriteBytes(input);
    assert.deepEqual([image.width, image.height], [width, height]);
    assert.equal(pixelHash(image.data), digest);
  });
}
