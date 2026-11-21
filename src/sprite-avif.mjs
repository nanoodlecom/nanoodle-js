import { readFile } from "node:fs/promises";
import decode, { init } from "@jsquash/avif/decode.js";

// Resolve the decoder installed by npm without network access. Module
// initialization is shared by concurrent graphs and only runs on first use.
const wasmFile = new URL(import.meta.resolve("@jsquash/avif/codec/dec/avif_dec.wasm"));
await init(await WebAssembly.compile(await readFile(wasmFile)));

export async function decodeAvif(bytes) {
  const { width, height, data } = await decode(bytes);
  return { width, height, data };
}
