require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")
const { createDraftStorage } = require("../lib/daily-logs/draft-storage")

test("replacement composer waits for last pending draft write", async () => {
  const disk = new Map()
  let release
  const firstWrite = new Promise((resolve) => { release = resolve })
  const store = createDraftStorage({
    get: async (key) => disk.get(key),
    set: async (key, value) => { await firstWrite; disk.set(key, value) },
    del: async (key) => { disk.delete(key) },
  })
  const initial = store.save("user:project:today", { summary: "First" })
  const latest = store.save("user:project:today", { summary: "Final edit", files: ["photo"] })
  const recovered = store.load("user:project:today")
  release()
  await Promise.all([initial, latest])
  assert.deepEqual(await recovered, { summary: "Final edit", files: ["photo"] })
  assert.deepEqual(disk.get("user:project:today"), { summary: "Final edit", files: ["photo"] })
})

test("device write failure preserves draft in memory across remounts", async () => {
  const store = createDraftStorage({ get: async () => undefined, set: async () => { throw new Error("quota") }, del: async () => {} })
  await assert.rejects(store.save("draft", { summary: "Keep me" }), /quota/)
  assert.deepEqual(await store.load("draft"), { summary: "Keep me" })
})

test("successful deletion runs after pending writes and prevents resurrection", async () => {
  const disk = new Map()
  const store = createDraftStorage({ get: async (key) => disk.get(key), set: async (key, value) => { disk.set(key, value) }, del: async (key) => { disk.delete(key) } })
  void store.save("draft", { summary: "Saved log" })
  await store.remove("draft")
  assert.equal(await store.load("draft"), undefined)
  assert.equal(disk.has("draft"), false)
})

test("user and day namespaces cannot restore one another's draft", async () => {
  const store = createDraftStorage({ get: async () => undefined, set: async () => {}, del: async () => {} })
  await store.save("user-a:project:today", { summary: "Private note" })
  assert.equal(await store.load("user-b:project:today"), undefined)
  assert.equal(await store.load("user-a:project:yesterday"), undefined)
})
