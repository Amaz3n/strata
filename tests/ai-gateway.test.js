require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const { z } = require("zod")

const { createFakeSupabase } = require("./support/fake-supabase")
const { freshRequire, stubModule } = require("./support/modules")

// The model provider is the external boundary: each call takes the next
// scripted response (an object, or an Error to throw).
let calls = []
let usage = []
let responses = []

stubModule("ai", {
  ...require("ai"),
  generateObject: async (options) => {
    calls.push(options)
    const next = responses.shift()
    if (next instanceof Error) throw next
    return { object: next ?? { total: 10 }, usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 } }
  },
})
stubModule("@/lib/services/ai/provider", {
  getApiKeyForProvider: () => "test",
  resolveLanguageModel: (provider, _key, model) => ({ provider, model }),
})
stubModule("@/lib/services/ai/usage", {
  ...require("@/lib/services/ai/usage"),
  recordAiUsage: async (_supabase, record) => {
    usage.push(record)
  },
})
// The gateway reads the org's AI settings; none are configured.
stubModule("@/lib/supabase/server", { createServiceSupabaseClient: () => createFakeSupabase() })
stubModule("@/lib/services/feature-flags", { isFeatureEnabledForOrg: async () => true })
stubModule("@/lib/services/ai/pdf-raster", { rasterizePdfToImages: async () => null })

const { runAiObject } = freshRequire("lib/services/ai/gateway.ts")

const base = {
  feature: "document_extraction",
  schema: z.object({ total: z.number() }),
  prompt: "Synthetic invoice",
  totalTimeoutMs: 1000,
}

function script(...next) {
  calls = []
  usage = []
  responses = next
}

test("a busy provider hands over to another provider instead of retrying itself", async () => {
  script(Object.assign(new Error("high demand"), { statusCode: 503 }), { total: 10 })
  const result = await runAiObject(base)
  assert.equal(result.ok, true)
  assert.deepEqual(calls.map((call) => call.model.provider), ["openai", "google"])
  assert.equal(calls[0].maxRetries, 0)
  assert.deepEqual(usage.map((record) => record.status), ["error", "ok"])
})

test("at most one availability fallback is attempted", async () => {
  script(new Error("high demand"), new Error("high demand"))
  assert.equal((await runAiObject(base)).ok, false)
  assert.equal(calls.length, 2)
})

test("bad credentials and an invalid schema stop without charging another tier", async () => {
  for (const error of [new Error("Incorrect API key provided"), new Error("Invalid schema for response_format")]) {
    script(error)
    assert.equal((await runAiObject(base)).ok, false, error.message)
    assert.equal(calls.length, 1, error.message)
  }
})

test("an answer that fails verification escalates to a stronger model", async () => {
  script({ total: 9 }, { total: 10 })
  const result = await runAiObject({ ...base, verify: (value) => ({ ok: value.total === 10 }) })
  assert.equal(result.ok, true)
  assert.equal(result.meta.escalated, true)
  assert.equal(usage[0].errorKind, "verification_failed")
})

test("a cost-capped task may recover availability but never buys a quality escalation", async () => {
  script({ total: 9 })
  assert.equal((await runAiObject({ ...base, allowEscalation: false, verify: () => ({ ok: false }) })).ok, false)
  assert.equal(calls.length, 1)

  script(new Error("rate limit 429"), { total: 10 })
  assert.equal((await runAiObject({ ...base, allowEscalation: false })).ok, true)
  assert.equal(calls.length, 2)
})

test("tokens billed for an unusable answer are recorded before recovering", async () => {
  const unusable = Object.assign(new Error("No object generated"), {
    name: "AI_NoObjectGeneratedError",
    usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
  })
  script(unusable, { total: 10 })
  assert.equal((await runAiObject(base)).ok, true)
  assert.equal(usage[0].usage.outputTokens, 8)
})
