require("../scripts/register-ts-node-test")

/**
 * `lib/inbound/signature.ts` — the signed server-to-server deliveries (website
 * leads, lender and title milestones): what is accepted, and why the rest is not.
 */

const assert = require("node:assert/strict")
const test = require("node:test")

const { signInboundPayload, verifyInboundSignature } = require("../lib/inbound/signature.ts")

const NOW = new Date("2026-10-12T15:00:00Z")
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000))
const BODY = JSON.stringify({ email: "dana@example.test" })

function verify(overrides = {}) {
  return verifyInboundSignature({
    secrets: ["current-secret"],
    timestamp: TIMESTAMP,
    signature: signInboundPayload("current-secret", TIMESTAMP, BODY),
    rawBody: BODY,
    now: NOW,
    ...overrides,
  })
}

test("a body signed with an accepted secret within five minutes verifies", () => {
  assert.deepEqual(verify(), { ok: true })
  assert.deepEqual(verify({ secrets: ["new-secret", "current-secret"] }), { ok: true }, "a rotated-out secret in its grace window")
  assert.deepEqual(verify({ now: new Date(NOW.getTime() + 299_000) }), { ok: true })
})

test("an unsigned, stale, tampered or wrongly keyed delivery is refused with its reason", () => {
  assert.deepEqual(verify({ signature: null }), { ok: false, reason: "missing_signature" })
  assert.deepEqual(verify({ timestamp: null }), { ok: false, reason: "missing_signature" })
  assert.deepEqual(verify({ now: new Date(NOW.getTime() + 301_000) }), { ok: false, reason: "stale_timestamp" })
  assert.deepEqual(verify({ timestamp: "12.5" }), { ok: false, reason: "stale_timestamp" })
  assert.deepEqual(verify({ rawBody: `${BODY} ` }), { ok: false, reason: "bad_signature" })
  assert.deepEqual(verify({ secrets: ["another-secret"] }), { ok: false, reason: "bad_signature" })
  assert.deepEqual(verify({ signature: "not-hex" }), { ok: false, reason: "bad_signature" })
})
