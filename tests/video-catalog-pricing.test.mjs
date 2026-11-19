import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { estimateGraphCost } from '../src/estimate.mjs';
// Read-only snapshot: https://nano-gpt.com/api/v1/video-models, 2026-11-10.
const video = JSON.parse(readFileSync(new URL('./fixtures/video-pricing-2026-11-10.json', import.meta.url)));
function estimate(model, fields = {}, image = false) {
  return estimateGraphCost({nodes: [{id:'v', type:model === 'openjutsu' ? 'vedit' : 'ivideo', fields:{model, ...fields}}], links:image ? [{from:{node:'u',port:'image'},to:{node:'v',port:'image'}}] : []}, {video});
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
test('Mischief uses requested seconds and resolution, never numeric metadata', () => {
  near(estimate('tbc/mischief-1').usd, .05);
  near(estimate('tbc/mischief-1', {duration:3, resolution:'480p'}).usd, .015);
  near(estimate('tbc/mischief-1', {duration:5, resolution:'480p'}).usd, .025);
});
test('OpenJutsu rounds source seconds, clamps duration, and adds NanoGPT image tariff', () => {
  near(estimate('openjutsu', {duration:3.1,resolution:'480p'}, true).usd, .21);
  near(estimate('openjutsu', {duration:.2,resolution:'480p'}, true).usd, .16);
  near(estimate('openjutsu', {duration:30}, true).usd, 1.51);
  near(estimate('openjutsu', {duration:3.1,resolution:'480p',modelOpts:{swap_type:'object'}}).usd, .20);
});
test('LTX Quality bills rounded megapixel frames, with HDR and LoRA premium', () => {
  near(estimate('ltx-2.3-quality').usd, .002408 * 134);
  near(estimate('ltx-2.3-quality', {duration:10}).usd, .002408 * 223);
  near(estimate('ltx-2.3-quality', {modelOpts:{mode:'hdr'}}).usd, .002708 * 134);
  near(estimate('ltx-2.3-quality', {loras:[{url:'https://example.com/lora.safetensors'}]}).usd, .002708 * 134);
  near(estimate('ltx-2.3-quality', {modelOpts:{lora_url_1:'https://example.com/lora.safetensors'}}).usd, .002708 * 134);
  near(estimate('ltx-2.3-quality', {modelOpts:{lora_url_1:'  '}}).usd, .002408 * 134);
  assert.equal(estimate('ltx-2.3-quality').exact, false);
});
