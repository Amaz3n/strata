require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const { consumeObjectStream } = require("../lib/services/ai/consume-object-stream")
function stream(parts, result = { ok: true }) {
  return { fullStream: (async function* () { yield* parts })(), object: Promise.resolve(result), usage: Promise.resolve({ inputTokens: 1 }) }
}
test("provider error rejects without waiting for unresolved result promises", async () => {
  const source = stream([{ type: "error", error: new Error("Provider request timed out") }])
  source.object = source.usage = new Promise(() => {})
  await assert.rejects(consumeObjectStream(source, () => {}), /Provider request timed out/)
})
test("unexpected end rejects instead of hanging", async () => {
  const source = stream([{ type: "object", object: { vendor: "A" } }])
  source.object = source.usage = new Promise(() => {})
  await assert.rejects(consumeObjectStream(source, () => {}), /before finishing/)
})
test("successful stream delivers provisional data and the final result", async () => {
  const parts = []
  const result = await consumeObjectStream(stream([{ type: "object", object: { ok: true } }, { type: "finish" }]), part => { parts.push(part) })
  assert.deepEqual(parts, [{ ok: true }])
  assert.deepEqual(result.object, { ok: true })
})
