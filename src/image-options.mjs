// Model knobs may tune generation, but cannot replace node-owned request fields
// or smuggle routing/authentication settings into an image request.
export function imageModelOpts(opts) {
  const out = {};
  if (!opts || typeof opts !== "object" || Array.isArray(opts)) return out;
  for (const [key, value] of Object.entries(opts)) {
    if (/^(?:model|prompt|size|n|responseformat|image|images|imageurl|imagedataurl|mask|maskurl|maskdataurl|key|apikey|xapikey|token|accesstoken|authorization|auth|headers|url|endpoint|baseurl|method|body|credentials|proxy|runid|requestid|isapirequest|paymentsource|paymentid|tojson|proto|prototype|constructor)$/i.test(key.replace(/[_-]/g, ""))) continue;
    out[key] = value;
  }
  return out;
}
