import test from "node:test";
import assert from "node:assert/strict";
import { estimateGraphCost } from "../src/index.mjs";
import { avatarAudioEstSeconds, avatarClampSecs } from "../src/estimate.mjs";

// Raw catalog rows as GET https://nano-gpt.com/api/v1/video-models returned them on 2026-11-02 (pricing only).
const LONGCAT_BILLING = "Duration rounded up to whole seconds, then clamped to the minimum and maximum billable duration";
const video = [
  { id: "longcat-avatar-1.5", pricing: { currency: "USD", per_second_by_resolution: { "480p": 0.04, "720p": 0.08 }, billing: LONGCAT_BILLING, minimum_billable_duration: 3, maximum_billable_duration: 30, default_duration: 5, default_resolution: "480p" } },
  { id: "longcat-avatar", pricing: { currency: "USD", per_second_by_resolution: { "480p": 0.04, "720p": 0.08 }, billing: LONGCAT_BILLING, minimum_billable_duration: 3, maximum_billable_duration: 120, default_duration: 5, default_resolution: "480p" } },
  // same model with the billing limits stripped: avatarClampSecs' 3–30 s fallback must still apply
  { id: "longcat-avatar-1.5-bare", pricing: { per_second_by_resolution: { "480p": 0.04 }, default_duration: 5, default_resolution: "480p" } },
];
const catalogs = { video, audio: [{ id: "Minimax-Speech-2.8-HD", pricing: { per_thousand_chars: 0 } }] };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

const SCRIPT = "Okay so this little clay pot waters my basil for me. You fill the base, the terracotta wicks it up, and I genuinely forgot about it for a week. Handmade, tiny, and my herbs have never looked this good.";

// Shape of nanoodle's gallery/talking-avatar graph: text → tts → lipsync.audio
function avatarGraph({ model = "longcat-avatar-1.5", resolution = "480p", text = SCRIPT, ttsPrompt, src } = {}) {
  const nodes = [
    { id: "t", type: "text", fields: { text } },
    src || { id: "s", type: "tts", fields: { model: "Minimax-Speech-2.8-HD", voice: "Deep_Voice_Man", ...(ttsPrompt ? { prompt: ttsPrompt } : {}) } },
    { id: "a", type: "lipsync", fields: { model, resolution } },
  ];
  const links = [{ from: { node: nodes[1].id, port: "audio" }, to: { node: "a", port: "audio" } }];
  if (text != null && !src) links.push({ from: { node: "t", port: "text" }, to: { node: "s", port: "prompt" } });
  return { nodes, links };
}
// price the avatar node alone (audio catalog omitted → the tts node is unpriced, adds $0)
const lipsyncUsd = (gr) => estimateGraphCost(gr, { video }).usd;

test("avatarAudioEstSeconds twins the app (nanoodle #782 check-avatar-audio-estimate cases)", () => {
  const tts = (prompt) => ({ type: "tts", fields: prompt ? { prompt } : {} });
  assert.equal(avatarAudioEstSeconds(null, "", null), null);
  assert.equal(avatarAudioEstSeconds(tts(), "", 13.1), 14);
  assert.equal(avatarAudioEstSeconds({ type: "music", fields: { duration: "20" } }, "", null), 20);
  const w = avatarAudioEstSeconds(tts(), SCRIPT, null);
  assert.ok(w >= 12 && w <= 15, `~38-word script → ${w}s`);
  assert.equal(avatarAudioEstSeconds(tts(SCRIPT), "", null), w);
  assert.equal(avatarAudioEstSeconds(tts(), "", null), 40);              // 600 chars at 15 chars/s
  assert.equal(avatarAudioEstSeconds({ type: "aupload", fields: {} }, "", null), null);
});

test("avatarClampSecs clamps seconds to the catalog's billable duration, with the 1.5 fallback", () => {
  assert.equal(avatarClampSecs("longcat-avatar-1.5", 2, {}), 3);
  assert.equal(avatarClampSecs("longcat-avatar-1.5", 31, null), 30);
  assert.equal(avatarClampSecs("longcat-avatar", 100, { minimum_billable_duration: 3, maximum_billable_duration: 120 }), 100);
  assert.equal(avatarClampSecs("heygen/avatar-iv", 100, {}), 100);       // other avatars unchanged
  assert.equal(avatarClampSecs("longcat-avatar-1.5/multi", 50, {}), 50); // multi is not the 1.5 single fallback
});

test("lipsync forecast prices the wired voice's length, not the 5 s default", () => {
  const w = avatarAudioEstSeconds({ type: "tts", fields: {} }, SCRIPT, null);
  near(lipsyncUsd(avatarGraph()), w * 0.04);
  assert.ok(lipsyncUsd(avatarGraph()) > 0.2, "never back to 5 s × $0.04 = $0.20 with a Speech node wired");
  near(lipsyncUsd(avatarGraph({ resolution: "720p" })), w * 0.08);
  // the Speech node's own typed text counts the same as a wired text node
  near(lipsyncUsd(avatarGraph({ text: null, ttsPrompt: SCRIPT })), w * 0.04);
});

test("lipsync forecast clamps to LongCat's billable window", () => {
  // tiny script: 2 words → 1 s → billed at the 3 s minimum
  near(lipsyncUsd(avatarGraph({ text: "Hi there" })), 3 * 0.04);
  // unknown text (no prompt anywhere) → 40 s assumption → 30 s ceiling on 1.5
  near(lipsyncUsd(avatarGraph({ text: null })), 30 * 0.04);
  near(lipsyncUsd(avatarGraph({ text: null, resolution: "720p" })), 30 * 0.08);
  // LongCat 1.0 has its own 120 s ceiling, so the 40 s assumption stands
  near(lipsyncUsd(avatarGraph({ text: null, model: "longcat-avatar" })), 40 * 0.04);
  // limits missing from the catalog row → the 1.5 id's 3–30 s fallback still clamps
  near(lipsyncUsd(avatarGraph({ text: null, model: "longcat-avatar-1.5-bare" })), 30 * 0.04);
});

test("lipsync wired to a source with a duration knob bills that length", () => {
  const src = { id: "m", type: "music", fields: { model: "x", duration: "20" } };
  near(lipsyncUsd(avatarGraph({ src })), 20 * 0.04);
});

test("lipsync with nothing usable wired keeps the model default (unchanged behavior)", () => {
  const gr = { nodes: [{ id: "a", type: "lipsync", fields: { model: "longcat-avatar-1.5", resolution: "480p" } }], links: [] };
  near(estimateGraphCost(gr, { video }).usd, 5 * 0.04);
  const up = avatarGraph({ src: { id: "u", type: "aupload", fields: {} } });
  near(lipsyncUsd(up), 5 * 0.04);
});

test("full talking-avatar graph: priced counts include the avatar node", () => {
  const r = estimateGraphCost(avatarGraph(), catalogs);
  assert.equal(r.priced, 2);
  assert.equal(r.exact, false);
});
