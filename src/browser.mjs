/**
 * Browser-oriented package entry (`import … from "nanoodle/browser"`).
 *
 * Goal: one engine for play/export/CLI. No module on this surface top-level
 * imports Node builtins (Phase D): the pure local-media paths (MP4CAT remux,
 * PCM-WAV trim, PNG resize/mask composite) and share-link decoding run in a
 * browser as-is — zlib work goes through Compression/DecompressionStream
 * there. Only the ffmpeg fallback and file-path helpers dynamically import
 * Node builtins when those code paths actually run.
 * See docs/DESIGN.md § "Replacing the browser executor".
 *
 * Prefer `Workflow.fromJSON(obj, { apiKey, fetch, payment })` in the browser;
 * `Workflow.load(path)` and `mediaFromFile` remain Node-only (dynamic `node:fs`).
 */
export { Workflow, RunResult } from "./workflow.mjs";
export { NanoodleError, UnsupportedNodeError, RunError } from "./errors.mjs";
export {
  MediaRef,
  MEDIA_INLINE_MAX,
  coerceMediaInput,
  assertInlineMediaSize,
  bytesToDataUrl,
  dataUrlBytes,
  bytesToBase64,
  base64ToBytes,
  sniffMime,
  b64ImageMime,
  extForMime,
} from "./media.mjs";
export { NanoClient, httpError, costFromJson, costFromHeaders, costWithHeaders, sleep } from "./client.mjs";
export { NODE_TYPES, displayName, materialize, topoSort, wiredFramesFloor, MAX_FRAMES } from "./graph.mjs";
export { deriveInputs, deriveOutputs, deriveSettings, INPUT_SPECS, SETTING_SPECS } from "./io.mjs";
export { decodeShareUrl, decodeShareFragment, isShareRef } from "./share.mjs";
export { resizePlan, maskToSource, resizeCropImage, encodeWavMono } from "./local-media.mjs";
export { parseNanoInvoice } from "./x402.mjs";
export { qrTerminal, qrModules } from "./qr.mjs";
