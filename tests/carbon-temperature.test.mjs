import test from "node:test";
import assert from "node:assert/strict";
import { NanoClient } from "../src/client.mjs";

// Screenshot regression: 1536 max tokens, medium effort, temperature 0.8.
// Google's Carbon guide says remove sampling controls; don't let a default
// reintroduce temperature on its NanoGPT route. Its selected provider also
// rejects thinking controls, despite catalog-advertised reasoning levels. No live inference.
for (const temperature of [undefined, "", 0, 0.8, 2]) {
  test("Carbon omits temperature " + JSON.stringify(temperature), async () => {
    let body;
    const client = new NanoClient({ apiKey: "fixture", fetch: async (_url, init) => {
      body = JSON.parse(init.body);
      assert.equal("temperature" in body, false);
      return new Response(JSON.stringify({choices:[{message:{content:"fixture"}}]}));
    }});
    assert.equal(await client.chat([{role:"user",content:"fixture"}], "google/gemini-4-carbon",
      {temperature, max_tokens:1536, reasoning_effort:"medium"}), "fixture");
    assert.equal(body.max_tokens,1536);
    assert.equal("reasoning_effort" in body,false);
    assert.equal("thinking" in body,false);
  });
}
test("Argon and unrelated models keep their sampling settings", async () => {
  for (const model of ["google/gemini-4-argon", "anthropic/claude-fable-5.2"]) {
    for (const temperature of [undefined,0,0.8]) {
      const client = new NanoClient({apiKey:"fixture",fetch:async (_url,init)=>{
        assert.equal(JSON.parse(init.body).temperature,temperature ?? 0.8);
        return new Response(JSON.stringify({choices:[{message:{content:"fixture"}}]}));
      }});
      await client.chat([],model,{temperature});
    }
  }
});

for (const reasoning_effort of [undefined, "default", "low", "medium", "high"]) {
  test("Carbon omits explicit provider thinking control " + reasoning_effort, async () => {
    let body;
    const client = new NanoClient({apiKey:"fixture",fetch:async (_url,init)=>{
      body=JSON.parse(init.body);
      if(body.model === "google/gemini-4-carbon") {
        assert.equal("reasoning_effort" in body,false);
        assert.equal("thinking" in body,false);
      } else assert.equal(body.reasoning_effort,reasoning_effort);
      return new Response(JSON.stringify({choices:[{message:{content:"fixture"}}]}));
    }});
    await client.chat([],"google/gemini-4-carbon",{reasoning_effort,max_tokens:1536});
    assert.equal(body.max_tokens,1536);
    await client.chat([],"google/gemini-4-argon",{reasoning_effort});
  });
}
