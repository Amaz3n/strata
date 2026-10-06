require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const { ensureTilesCookie, getTilesCookieState, TILES_COOKIE_REFRESH_MS } = require("../lib/drawings/tiles-cookie-client")

test("a preview grid shares one access request", async () => {
  const original = global.fetch
  let calls = 0
  global.fetch = async () => { calls++; return { ok: true } }
  try {
    await Promise.all(Array.from({ length: 25 }, () => ensureTilesCookie("/test/preview-grid")))
    assert.equal(calls, 1)
  } finally { global.fetch = original }
})

test("reopening a review after expiry renews access once", async () => {
  const original = global.fetch
  let calls = 0
  global.fetch = async () => { calls++; return { ok: true } }
  const endpoint = "/test/expired-preview"
  try {
    await ensureTilesCookie(endpoint)
    getTilesCookieState(endpoint).setAt = Date.now() - TILES_COOKIE_REFRESH_MS - 1
    await Promise.all([ensureTilesCookie(endpoint), ensureTilesCookie(endpoint)])
    assert.equal(calls, 2)
  } finally { global.fetch = original }
})

test("failed access can be retried rather than cached permanently", async () => {
  const original = global.fetch
  let calls = 0
  global.fetch = async () => ({ ok: ++calls > 1, status: 503 })
  try {
    await assert.rejects(ensureTilesCookie("/test/failed-preview"), /503/)
    await ensureTilesCookie("/test/failed-preview")
    assert.equal(calls, 2)
  } finally { global.fetch = original }
})

test("switching organizations does not reuse another organization's access", async () => {
  const originalFetch = global.fetch
  const originalDocument = global.document
  let calls = 0
  global.fetch = async () => { calls++; return { ok: true } }
  try {
    global.document = { cookie: "org_id=first" }
    await ensureTilesCookie("/test/org-preview")
    global.document.cookie = "org_id=second"
    await ensureTilesCookie("/test/org-preview")
    global.document.cookie = "org_id=first"
    await ensureTilesCookie("/test/org-preview")
    assert.equal(calls, 3)
  } finally { global.fetch = originalFetch; global.document = originalDocument }
})
