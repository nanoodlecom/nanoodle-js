/**
 * Browser-oriented package entry (`import … from "nanoodle/browser"`).
 *
 * Goal: one engine for play/export/CLI. This surface is the migration on-ramp:
 * pure graph/IO/media/transport code has no top-level Node imports. Full
 * `Workflow.run` still reaches `local-media.mjs` (ffmpeg soft-dep + node zlib)
 * when a graph contains local media nodes — network-only runs are the ready
 * path today. See docs/DESIGN.md § "Replacing the browser executor".
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
export { parseNanoInvoice } from "./x402.mjs";
export { qrTerminal, qrModules } from "./qr.mjs";
