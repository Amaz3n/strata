require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const MODULE_PATH = require.resolve("../lib/files/view-url")

/**
 * The resolver keeps its cache and its stand-down flag in module scope, which is
 * the whole point of it — so each test needs its own copy of the module rather
 * than the one the previous test left behind.
 */
function loadResolver() {
  delete require.cache[MODULE_PATH]
  return require("../lib/files/view-url")
}

function stubFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push(String(url))
    return handler(String(url), init)
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

function signed(url, expiresIn = 3600) {
  return { ok: true, json: async () => ({ url, expiresIn }) }
}

test("resolves a signed url and reuses it for the same file", async () => {
  const { resolveFileViewUrl } = loadResolver()
  const fetchStub = stubFetch(() => signed("https://bucket.example/a?sig=1"))

  try {
    assert.equal(await resolveFileViewUrl("file-a"), "https://bucket.example/a?sig=1")
    assert.equal(await resolveFileViewUrl("file-a"), "https://bucket.example/a?sig=1")
    assert.equal(fetchStub.calls.length, 1, "second resolve must come from cache")
    assert.equal(fetchStub.calls[0], "/api/files/file-a/view-url")
  } finally {
    fetchStub.restore()
  }
})

test("concurrent callers share one signing request", async () => {
  const { resolveFileViewUrl } = loadResolver()
  const fetchStub = stubFetch(() => signed("https://bucket.example/b?sig=1"))

  try {
    const results = await Promise.all([
      resolveFileViewUrl("file-b"),
      resolveFileViewUrl("file-b"),
      resolveFileViewUrl("file-b"),
    ])
    assert.deepEqual(new Set(results), new Set(["https://bucket.example/b?sig=1"]))
    assert.equal(fetchStub.calls.length, 1, "a viewer and its rail must not each sign the file")
  } finally {
    fetchStub.restore()
  }
})

test("a url expiring inside the safety margin is never cached", async () => {
  const { resolveFileViewUrl } = loadResolver()
  let issued = 0
  const fetchStub = stubFetch(() => signed(`https://bucket.example/c?sig=${(issued += 1)}`, 60))

  try {
    assert.equal(await resolveFileViewUrl("file-c"), "https://bucket.example/c?sig=1")
    assert.equal(await resolveFileViewUrl("file-c"), "https://bucket.example/c?sig=2")
    assert.equal(fetchStub.calls.length, 2, "a url this close to expiry must be re-signed")
  } finally {
    fetchStub.restore()
  }
})

test("a refused or failed signing request falls back rather than throwing", async () => {
  const { resolveFileViewUrl } = loadResolver()

  const forbidden = stubFetch(() => ({ ok: false, status: 403, json: async () => ({}) }))
  try {
    assert.equal(await resolveFileViewUrl("file-d"), null)
  } finally {
    forbidden.restore()
  }

  const offline = stubFetch(() => {
    throw new Error("network down")
  })
  try {
    assert.equal(await resolveFileViewUrl("file-e"), null)
  } finally {
    offline.restore()
  }
})

test("a malformed payload is treated as no signed url", async () => {
  const { resolveFileViewUrl } = loadResolver()
  const fetchStub = stubFetch(() => ({ ok: true, json: async () => ({ url: 42 }) }))

  try {
    assert.equal(await resolveFileViewUrl("file-f"), null)
  } finally {
    fetchStub.restore()
  }
})

test("one direct-read failure stands the mechanism down for every file", async () => {
  const { resolveFileViewUrl, reportFileViewUrlFailure } = loadResolver()
  const fetchStub = stubFetch(() => signed("https://bucket.example/g?sig=1"))

  try {
    assert.equal(await resolveFileViewUrl("file-g"), "https://bucket.example/g?sig=1")

    // Whether direct reads work is a property of the deployment, not the file:
    // a bucket that rejects this origin rejects it for everything, and retrying
    // would make every document load twice.
    reportFileViewUrlFailure("file-g")

    assert.equal(await resolveFileViewUrl("file-g"), null, "the failed file must not retry")
    assert.equal(await resolveFileViewUrl("file-h"), null, "no other file may retry either")
    assert.equal(fetchStub.calls.length, 1, "nothing should be signed after standing down")
  } finally {
    fetchStub.restore()
  }
})
