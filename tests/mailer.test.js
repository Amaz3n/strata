const assert = require("node:assert/strict")
const test = require("node:test")

const { freshRequire } = require("./support/modules")

// The provider key is read when the module loads.
process.env.RESEND_API_KEY = "resend-fixture-key"
const { sendEmail } = freshRequire("lib/services/mailer.ts")

// A deliverable-looking address: reserved test domains are refused before sending.
const message = { to: ["signer@harbor-homes.us"], subject: "Please sign", html: "<p>Body</p>" }

/** The provider's HTTP API: accepts with `id`, or fails with `status`. */
function useProvider(t, { id = "provider-1", status = 200 } = {}) {
  const sent = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    sent.push({ url, init })
    return { ok: status < 400, status, json: async () => ({ id }), text: async () => "provider error" }
  }
  t.after(() => {
    globalThis.fetch = original
  })
  t.mock.method(console, "error", () => {})
  t.mock.method(console, "warn", () => {})
  return sent
}

test("a send is complete only once the provider's message id is durably recorded", async (t) => {
  useProvider(t)
  const recorded = []

  assert.equal(await sendEmail({ ...message, onAccepted: async (id) => recorded.push(id) }), true)
  assert.deepEqual(recorded, ["provider-1"])

  assert.equal(
    await sendEmail({
      ...message,
      onAccepted: async () => {
        throw new Error("database unavailable")
      },
    }),
    false,
  )
})

test("an acceptance without a message id is not a delivered send", async (t) => {
  const sent = useProvider(t, { id: "" })
  const recorded = []
  assert.equal(await sendEmail({ ...message, onAccepted: async (id) => recorded.push(id) }), false)
  assert.equal(sent.length, 1)
  assert.deepEqual(recorded, [])
})

test("a provider rejection reports failure and records nothing", async (t) => {
  const sent = useProvider(t, { status: 422 })
  const recorded = []
  assert.equal(await sendEmail({ ...message, onAccepted: async (id) => recorded.push(id) }), false)
  assert.equal(sent.length, 1)
  assert.deepEqual(recorded, [])
})

test("no mail leaves for an empty or placeholder recipient list", async (t) => {
  const sent = useProvider(t)
  assert.equal(await sendEmail({ ...message, to: [null, ""] }), false)
  assert.equal(await sendEmail({ ...message, to: ["signer@harbor-homes.us", "client@example.com"] }), false)
  assert.equal(sent.length, 0)
})
