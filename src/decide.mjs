// ⚖️ Decide — typed judgments from NanoGPT decision models (POST /api/v1/decisions).
// Port of the editor/play twin block (nanoodle index.html / play.html "⚖️ DECIDE"): same
// question shapes, same image state parts, same in-order + reversed pick debias, same
// outputs. Only the on-device image shrink differs: browsers use canvas, this library
// uses ffmpeg (fitImageJpeg) — text-only decisions need no ffmpeg at all.
import { NanoodleError } from "./errors.mjs";

export const DECIDE_DEFAULT_MODEL = "perplexity/pplx-decider-v1.1-27b";
export const DECIDE_SCALE_DEFAULT = "poor\nokay\ngood\ngreat";
/** The live limits of every image-capable decision model at launch (catalog decision_input.image_limits). */
export const DECIDE_IMG_FALLBACK = { maxImages: 4, maxDimension: 512, maxEncodedBytes: 240000 };

export function decideMode(f) {
  const m = f && f.mode;
  return (m === "choose" || m === "score" || m === "yesno") ? m : "pick";
}
export function decideLines(s) {
  return String(s == null ? "" : s).split("\n").map((x) => x.trim()).filter(Boolean);
}
export function decideDefaultQuestion(mode) {
  if (mode === "pick") return "Which image best matches the brief?";
  if (mode === "choose") return "Which label fits best?";
  if (mode === "score") return "How good is it?";
  return "Is it good enough to use?";
}
/** Image limits from a catalog decision_input; known=false (absent / offline) → permissive launch limits; known text-only → null. */
export function decideImageLimits(di, known) {
  if (!known) return DECIDE_IMG_FALLBACK;
  if (!di || !di.image_input) return null;
  const l = di.image_limits || {};
  return {
    maxImages: l.maxImages > 0 ? l.maxImages : DECIDE_IMG_FALLBACK.maxImages,
    maxDimension: l.maxDimension > 0 ? l.maxDimension : DECIDE_IMG_FALLBACK.maxDimension,
    maxEncodedBytes: l.maxEncodedBytes > 0 ? l.maxEncodedBytes : DECIDE_IMG_FALLBACK.maxEncodedBytes,
  };
}
/** The one typed question this node asks. Throws (before any request) on an unanswerable setup. */
export function decideQuestionFor(mode, f, nImgs) {
  const q = String((f && f.question) || "").trim() || decideDefaultQuestion(mode);
  if (mode === "pick") {
    if (nImgs < 2) throw new NanoodleError("pick needs at least two images — wire 2 or more into the image ports");
    const c = {};
    for (let i = 1; i <= nImgs; i++) c["image_" + i] = "image " + i;
    return { type: "choice", instructions: q, criteria: c };
  }
  if (mode === "choose") {
    const labels = decideLines(f && f.options).filter((x, i, a) => a.indexOf(x) === i);
    if (labels.length < 2) throw new NanoodleError("add at least two labels to choose from (one per line)");
    if (labels.length > 255) throw new NanoodleError("too many labels — 255 at most");
    const cc = {};
    labels.forEach((x) => { cc[x] = null; });
    return { type: "choice", instructions: q, criteria: cc };
  }
  if (mode === "score") {
    const lv = decideLines((f && f.levels != null && String(f.levels).trim()) ? f.levels : DECIDE_SCALE_DEFAULT);
    if (lv.length < 2 || lv.length > 10) throw new NanoodleError("the scale needs 2 to 10 levels, worst first (one per line)");
    return { type: "score", instructions: q, criteria: lv };
  }
  return { type: "noul", instructions: q };
}
/** state: plain text, or (with images) text + labelled inline image_url parts. */
export function decideState(text, imgs) {
  if (!imgs.length) return text;
  const s = [];
  if (text) s.push(text);
  imgs.forEach((u, i) => {
    if (imgs.length > 1) s.push("image_" + (i + 1) + ":");
    s.push({ type: "image_url", image_url: { url: u } });
  });
  return s;
}
/** API answer → node outputs: text, image (pick: the winner; else the first image, passed through), decision detail. */
export function decideOutputs(mode, ans, q, imgs, usage, model) {
  if (!ans || !ans.type) throw new NanoodleError("the decision model returned no answer");
  const d = { mode, model, cost: (usage && typeof usage.cost === "number") ? usage.cost : null, rows: [] };
  const probs = ans.probabilities || {};
  if (mode === "pick") {
    const k = String(ans.choice || ""), idx = parseInt(k.replace(/^image_/, ""), 10) || 1;
    d.pick = idx; d.confidence = ans.confidence;
    d.rows = Object.keys(q.criteria).map((key, i) => ({ label: "image " + (i + 1), p: +probs[key] || 0, win: key === k }));
    return { text: "image " + idx, image: imgs[idx - 1] || "", decision: d };
  }
  if (mode === "choose") {
    d.confidence = ans.confidence;
    d.rows = Object.keys(q.criteria).map((key) => ({ label: key, p: +probs[key] || 0, win: key === ans.choice }));
    return { text: String(ans.choice || ""), image: imgs[0] || "", decision: d };
  }
  if (mode === "score") {
    const sc = (+ans.score || 0) + 1; // 1 = the first (worst) level
    d.score = sc; d.levels = q.criteria.length; d.confidence = ans.confidence;
    let top = 0;
    q.criteria.forEach((x, i) => { if ((+probs[String(i)] || 0) > (+probs[String(top)] || 0)) top = i; });
    d.rows = q.criteria.map((x, i) => ({ label: (i + 1) + " · " + x, p: +probs[String(i)] || 0, win: i === top }));
    return { text: String(Math.round(sc * 100) / 100), image: imgs[0] || "", decision: d };
  }
  const py = Math.max(0, Math.min(1, +ans.noul || 0));
  d.yes = py;
  d.rows = [{ label: "yes", p: py, win: py >= 0.5 }, { label: "no", p: 1 - py, win: py < 0.5 }];
  return { text: py >= 0.5 ? "yes" : "no", image: imgs[0] || "", decision: d };
}
/** A closed yes/no gate: a deliberate stop. Downstream nodes skip (unbilled) like any upstream failure. */
export function decideGateError(d) {
  return new NanoodleError(
    "gate closed — the answer was no (yes " + Math.round(d.yes * 100) + "%), so nothing downstream ran",
    { code: "decide-gate", gate: true, decision: d });
}
/** Average pick probabilities across runs that saw the candidates in different orders; costs add up. */
export function decideMergeOrders(js, orders) {
  const n = orders[0].length, sum = new Array(n).fill(0);
  let cost = 0, costKnown = true;
  js.forEach((j, r) => {
    const a = j && j.answers && j.answers.answer;
    if (!a || !a.probabilities) throw new NanoodleError("the decision model returned no answer");
    orders[r].forEach((orig, k) => { sum[orig] += (+a.probabilities["image_" + (k + 1)] || 0) / js.length; });
    if (j.usage && typeof j.usage.cost === "number") cost += j.usage.cost; else costKnown = false;
  });
  let best = 0;
  const probs = {};
  sum.forEach((p, i) => { probs["image_" + (i + 1)] = p; if (p > sum[best]) best = i; });
  return {
    answers: { answer: { type: "choice", choice: "image_" + (best + 1), confidence: sum[best], probabilities: probs } },
    usage: { cost: costKnown ? cost : null }, runs: js.length,
  };
}
/**
 * The whole run. send(body) POSTs /api/v1/decisions and returns the JSON; fit(url, maxDim, budget)
 * returns a data: URL that fits (inlining remote URLs as needed).
 */
export async function decideRun(f, model, text, imgs, lim, send, fit) {
  const mode = decideMode(f);
  text = String(text == null ? "" : text).trim();
  imgs = (imgs || []).filter(Boolean);
  if (imgs.length && !lim) throw new NanoodleError("this decision model can’t see images — pick one that can (e.g. PPLX Decider or Clef)");
  if (lim && imgs.length > lim.maxImages) throw new NanoodleError("this decision model takes at most " + lim.maxImages + " images — unwire the extras");
  const q = decideQuestionFor(mode, f, imgs.length);
  if (!text && !imgs.length && !String((f && f.question) || "").trim()) throw new NanoodleError("nothing to judge — wire text or an image into Decide");
  const sent = [];
  if (imgs.length) {
    const budget = Math.floor(lim.maxEncodedBytes * 0.95 / imgs.length);
    for (const u of imgs) sent.push(await fit(u, lim.maxDimension, budget));
  }
  let j;
  if (mode === "pick") {
    // decision models lean toward the first image they see: ask in order and reversed, average
    const fwd = sent.map((x, i) => i), rev = fwd.slice().reverse();
    const both = await Promise.all([fwd, rev].map((ord) =>
      send({ model, state: decideState(text, ord.map((i) => sent[i])), questions: { answer: q } })));
    j = decideMergeOrders(both, [fwd, rev]);
  } else {
    j = await send({ model, state: decideState(text, sent), questions: { answer: q } });
  }
  const out = decideOutputs(mode, j && j.answers && j.answers.answer, q, imgs, j && j.usage, model);
  if (mode === "yesno" && (f.gate === true || f.gate === "true") && out.decision.yes < 0.5) throw decideGateError(out.decision);
  return out;
}
