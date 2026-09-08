require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")
const { runBoundedUploads, completeQueuedUpload } = require("../lib/daily-logs/upload-queue")

test("large batches never exceed three simultaneous uploads", async () => {
  let active = 0
  let peak = 0
  const completed = []
  await runBoundedUploads(Array.from({ length: 10 }, (_, index) => index), async (item) => {
    peak = Math.max(peak, ++active)
    await new Promise((resolve) => setImmediate(resolve))
    completed.push(item)
    active--
  })
  assert.equal(peak, 3)
  assert.equal(completed.length, 10)
})

test("confirmed upload is persisted before removal and cleanup retry never reuploads", async () => {
  const item = { id: "job", status: "queued", file: {}, context: {} }
  const events = []
  let saved
  const dependencies = {
    upload: async () => { events.push("upload"); return { id: "file" } },
    persist: async (value) => { events.push("persist"); saved = structuredClone(value) },
    remove: async () => { events.push("remove"); throw new Error("storage unavailable") },
  }
  await assert.rejects(completeQueuedUpload(item, dependencies), /storage unavailable/)
  assert.deepEqual(events, ["upload", "persist", "remove"])
  const result = await completeQueuedUpload(saved, { ...dependencies, remove: async () => events.push("removed") })
  assert.equal(result.id, "file")
  assert.deepEqual(events, ["upload", "persist", "remove", "removed"])
})

test("a rejected upload stays in the queue for explicit retry", async () => {
  let removed = false
  const item = { id: "job", status: "queued", file: {}, context: {} }
  await assert.rejects(completeQueuedUpload(item, {
    upload: async () => { throw new Error("network interrupted") },
    persist: async () => {},
    remove: async () => { removed = true },
  }), /network interrupted/)
  assert.equal(removed, false)
  assert.equal(item.uploaded, undefined)
})

test("restored attachment identity survives cloned files and scopes changes", async () => {
  const { dailyLogUploadId } = require("../lib/daily-logs/upload-queue")
  const original = new File(["photo bytes"], "site.jpg", { type: "image/jpeg" })
  const restored = new File(["photo bytes"], "site.jpg", { type: "image/jpeg" })
  const context = { dailyLogId: "log", tags: ["b", "a"] }
  const id = await dailyLogUploadId("user:project", original, context)
  assert.equal(await dailyLogUploadId("user:project", restored, { ...context, tags: ["b", "a"] }), id)
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(await dailyLogUploadId("other:project", original, context), id)
  assert.notEqual(await dailyLogUploadId("user:project", original, { ...context, dailyLogId: "other" }), id)
  assert.notEqual(await dailyLogUploadId("user:project", new File(["different"], "site.jpg", { type: "image/jpeg" }), context), id)
})
