require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { TileLoader } = require("../lib/viewer/tile-loader")

const TILE = 512
const TILE_BYTES = TILE * TILE * 4

/** Decode stub: dimensions ride on the "blob" the fetch stub returned. */
global.createImageBitmap = async (blob) => ({
  width: blob.width,
  height: blob.height,
  close: () => {},
})

/** fetch stub: "bad" URLs 500, "auth" URLs 401, everything else a 512² tile. */
function installFetch() {
  global.fetch = async (url) => {
    if (url.startsWith("bad")) return { ok: false, status: 500 }
    if (url.startsWith("auth")) return { ok: false, status: 401 }
    return { ok: true, status: 200, blob: async () => ({ width: TILE, height: TILE }) }
  }
}

/** Renderer stub tagging uploads so eviction order is observable. */
function makeRenderer() {
  let uploads = 0
  const destroyed = []
  return {
    backend: "webgl2",
    onDeviceLost: null,
    uploadTile: (bitmap) => ({ width: bitmap.width, height: bitmap.height, id: ++uploads }),
    destroyTile: (texture) => destroyed.push(texture),
    render: () => {},
    resize: () => {},
    destroy: () => {},
    destroyed,
  }
}

async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function makeLoader(renderer, overrides = {}) {
  const sustained = []
  let authErrors = 0
  const loader = new TileLoader({
    credentials: "omit",
    onTileReady: () => {},
    onAuthError: () => {
      authErrors++
    },
    onSustainedFailure: (count) => sustained.push(count),
    ...overrides,
  })
  loader.setRenderer(renderer)
  return { loader, sustained, authErrors: () => authErrors }
}

test("byte budget evicts least-recently-used textures, not the working set", async () => {
  installFetch()
  const renderer = makeRenderer()
  const { loader } = makeLoader(renderer, { maxCacheBytes: 3 * TILE_BYTES })

  loader.get("a")
  await settle()
  loader.get("b")
  await settle()
  loader.get("c")
  await settle()
  const texA = loader.get("a")
  const texB = loader.get("b")
  const texC = loader.get("c")
  assert.ok(texA && texB && texC, "all three tiles cached")
  assert.equal(loader.stats().currentBytes, 3 * TILE_BYTES)

  // Touch a so b becomes least recently used, then push over budget.
  loader.get("a")
  loader.get("c")
  loader.get("b")
  loader.get("a")
  loader.get("c")
  loader.get("d")
  await settle()

  assert.equal(renderer.destroyed.length, 1, "exactly one eviction")
  assert.equal(renderer.destroyed[0], texB, "the LRU texture (b) was evicted")
  assert.equal(loader.stats().currentBytes, 3 * TILE_BYTES)
  assert.equal(loader.stats().peakBytes, 4 * TILE_BYTES)
  assert.ok(loader.get("a"), "a survived")
  assert.ok(loader.get("c"), "c survived")
  assert.ok(loader.get("d"), "d cached")

  loader.destroy()
})

test("release frees every texture and resets byte accounting", async () => {
  installFetch()
  const renderer = makeRenderer()
  const { loader } = makeLoader(renderer)

  loader.get("a")
  loader.get("b")
  await settle()
  assert.equal(loader.stats().currentBytes, 2 * TILE_BYTES)

  loader.release()
  assert.equal(renderer.destroyed.length, 2)
  assert.equal(loader.stats().currentBytes, 0)
  assert.equal(loader.stats().peakBytes, 2 * TILE_BYTES, "peak is telemetry and survives")
  assert.equal(loader.get("a"), null, "released tiles reload from scratch")

  loader.destroy()
})

test("prefetch waits for every visible tile and promotion jumps the line", async () => {
  const gates = new Map()
  global.fetch = (url) =>
    new Promise((resolve) => {
      gates.set(url, () =>
        resolve({ ok: true, status: 200, blob: async () => ({ width: TILE, height: TILE }) }),
      )
    })
  const renderer = makeRenderer()
  const { loader } = makeLoader(renderer, { maxConcurrent: 1 })

  loader.get("v1")
  loader.prefetch("p1")
  loader.prefetch("p2")
  loader.get("v2")
  await settle()
  assert.deepEqual([...gates.keys()], ["v1"], "only the first visible tile is in flight")

  gates.get("v1")()
  await settle()
  assert.deepEqual([...gates.keys()], ["v1", "v2"], "visible v2 precedes queued prefetches")

  // p2 becomes visible while queued — it must now precede p1.
  loader.get("p2")
  gates.get("v2")()
  await settle()
  assert.deepEqual([...gates.keys()], ["v1", "v2", "p2"], "promoted prefetch jumps the line")

  gates.get("p2")()
  await settle()
  assert.deepEqual([...gates.keys()], ["v1", "v2", "p2", "p1"], "plain prefetch runs last")
  gates.get("p1")()
  await settle()
  assert.equal(loader.stats().currentBytes, 4 * TILE_BYTES)

  loader.destroy()
})

test("sustained failure fires once per epoch; auth failures report separately", async () => {
  installFetch()
  const renderer = makeRenderer()
  const { loader, sustained, authErrors } = makeLoader(renderer)

  loader.get("auth-1")
  loader.get("auth-2")
  await settle()
  assert.equal(authErrors(), 1, "auth error reported once")
  assert.deepEqual(sustained, [], "auth failures do not count as sustained failure")

  loader.get("bad-1")
  loader.get("bad-2")
  await settle()
  assert.deepEqual(sustained, [], "below the sustained threshold")
  loader.get("bad-3")
  await settle()
  assert.deepEqual(sustained, [3], "third distinct failure trips the report")
  loader.get("bad-4")
  await settle()
  assert.deepEqual(sustained, [3], "no repeat within the epoch")

  assert.ok(loader.isFailed("bad-1"))
  assert.equal(loader.stats().failureCount, 6)
  assert.equal(loader.stats().currentBytes, 0, "failures never consume budget")

  // Cookie re-mint: failures forgotten, epoch reset, a fresh streak re-reports.
  loader.retryFailed()
  assert.equal(loader.isFailed("bad-1"), false)
  loader.get("bad-1")
  loader.get("bad-2")
  loader.get("bad-3")
  await settle()
  assert.deepEqual(sustained, [3, 3])

  loader.destroy()
})
