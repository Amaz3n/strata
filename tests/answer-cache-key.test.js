require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  buildAnswerCacheKey,
  buildDataVersion,
  isCacheEntryFresh,
  isCacheableQuestion,
  normalizeQuestion,
  permissionFingerprint,
} = require("../lib/ai/answer-cache-key")

const BASE = {
  question: "What is our open AR?",
  projectId: null,
  assistantMode: "org",
  permissions: ["invoice.read", "budget.read"],
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

test("case, spacing and trailing punctuation are noise", () => {
  assert.equal(normalizeQuestion("  What is   our Open AR? "), "what is our open ar")
  assert.equal(normalizeQuestion("what is our open ar"), "what is our open ar")
})

test("meaningful words are never collapsed away", () => {
  assert.notEqual(normalizeQuestion("invoices sent"), normalizeQuestion("invoices not sent"))
})

// ---------------------------------------------------------------------------
// Key identity
// ---------------------------------------------------------------------------

test("the same question from the same person hits the same key", () => {
  assert.equal(
    buildAnswerCacheKey(BASE),
    buildAnswerCacheKey({ ...BASE, question: "what is our OPEN ar" }),
  )
})

test("a different question is a different key", () => {
  assert.notEqual(buildAnswerCacheKey(BASE), buildAnswerCacheKey({ ...BASE, question: "overdue AR?" }))
})

test("project scope changes the key", () => {
  assert.notEqual(buildAnswerCacheKey(BASE), buildAnswerCacheKey({ ...BASE, projectId: "p1" }))
})

test("assistant mode changes the key", () => {
  assert.notEqual(
    buildAnswerCacheKey(BASE),
    buildAnswerCacheKey({ ...BASE, assistantMode: "general" }),
  )
})

test("DIFFERENT CLEARANCE IS A DIFFERENT KEY — the cache must not leak across roles", () => {
  const privileged = buildAnswerCacheKey(BASE)
  const restricted = buildAnswerCacheKey({ ...BASE, permissions: ["budget.read"] })
  assert.notEqual(privileged, restricted)
})

test("permission order does not matter", () => {
  assert.equal(
    buildAnswerCacheKey(BASE),
    buildAnswerCacheKey({ ...BASE, permissions: ["budget.read", "invoice.read"] }),
  )
})

test("duplicate permissions do not change the fingerprint", () => {
  assert.equal(
    permissionFingerprint(["a", "b"]),
    permissionFingerprint(["a", "b", "a"]),
  )
})

test("no permissions is a valid, distinct fingerprint", () => {
  assert.notEqual(permissionFingerprint([]), permissionFingerprint(["invoice.read"]))
})

// ---------------------------------------------------------------------------
// Data version
// ---------------------------------------------------------------------------

const STAMPS = [
  { entityType: "invoice", updatedAt: "2026-08-07T10:00:00Z" },
  { entityType: "project", updatedAt: "2026-08-06T09:00:00Z" },
]

test("the same data yields the same version, in any order", () => {
  assert.equal(buildDataVersion(STAMPS), buildDataVersion([...STAMPS].reverse()))
})

test("a write to any dependency changes the version", () => {
  const moved = [{ ...STAMPS[0], updatedAt: "2026-08-07T10:00:01Z" }, STAMPS[1]]
  assert.notEqual(buildDataVersion(STAMPS), buildDataVersion(moved))
})

test("null stamps are ignored rather than treated as a value", () => {
  assert.equal(
    buildDataVersion(STAMPS),
    buildDataVersion([...STAMPS, { entityType: "task", updatedAt: null }]),
  )
})

test("no usable stamps is 'unknown', not an empty hash", () => {
  assert.equal(buildDataVersion([]), "unknown")
  assert.equal(buildDataVersion([{ entityType: "task", updatedAt: null }]), "unknown")
})

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-07T12:00:00Z")

test("matching version inside the TTL is fresh", () => {
  const entry = { dataVersion: "v1", expiresAt: "2026-08-07T12:10:00Z" }
  assert.equal(isCacheEntryFresh(entry, "v1", NOW), true)
})

test("a moved data version is stale even well inside the TTL", () => {
  const entry = { dataVersion: "v1", expiresAt: "2026-08-07T23:00:00Z" }
  assert.equal(isCacheEntryFresh(entry, "v2", NOW), false)
})

test("an expired entry is stale even with a matching version", () => {
  const entry = { dataVersion: "v1", expiresAt: "2026-08-07T11:59:00Z" }
  assert.equal(isCacheEntryFresh(entry, "v1", NOW), false)
})

test("an unknown version on either side never serves", () => {
  assert.equal(
    isCacheEntryFresh({ dataVersion: "unknown", expiresAt: "2026-08-07T23:00:00Z" }, "unknown", NOW),
    false,
  )
  assert.equal(
    isCacheEntryFresh({ dataVersion: "v1", expiresAt: "2026-08-07T23:00:00Z" }, "unknown", NOW),
    false,
  )
})

test("an unparseable expiry is stale, not eternal", () => {
  assert.equal(isCacheEntryFresh({ dataVersion: "v1", expiresAt: "soon" }, "v1", NOW), false)
})

// ---------------------------------------------------------------------------
// What may be cached at all
// ---------------------------------------------------------------------------

test("a plain factual question is cacheable", () => {
  assert.equal(isCacheableQuestion("What is our open AR?"), true)
  assert.equal(isCacheableQuestion("Which RFIs are overdue on Maple Street"), true)
})

test("anything that would change something is never cached", () => {
  assert.equal(isCacheableQuestion("Create a task for the framing crew"), false)
  assert.equal(isCacheableQuestion("Send the invoice to the owner"), false)
  assert.equal(isCacheableQuestion("Approve change order 12"), false)
})

test("a question explicitly asking for the current state is never cached", () => {
  assert.equal(isCacheableQuestion("What is the status right now"), false)
  assert.equal(isCacheableQuestion("Show me today's logs"), false)
  assert.equal(isCacheableQuestion("What is the latest on the permit"), false)
})

test("a question too short to identify is not cached", () => {
  assert.equal(isCacheableQuestion("ar?"), false)
})
