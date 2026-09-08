require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")
const { syncOfflineDailyLog } = require("../lib/daily-logs/offline-sync")

const draft = () => ({ id: "queued", projectId: "project", logInput: { project_id: "project", date: "2026-09-07", summary: "Work finished" }, files: [{ name: "a.jpg" }, { name: "b.jpg" }], timestamp: 1 })

test("a failed attachment resumes with the same log and skips persisted files", async () => {
  let pending = draft()
  let saved
  let creates = 0
  const uploaded = []
  const dependencies = {
    createLog: async () => { creates++; return { id: "created" } },
    persist: async (value) => { saved = structuredClone(value) },
    uploadFiles: async ([file]) => { uploaded.push(file.name); if (file.name === "b.jpg") throw new Error("offline") },
  }
  await assert.rejects(syncOfflineDailyLog(pending, dependencies), /offline/)
  pending = saved
  assert.equal(pending.createdLogId, "created")
  assert.deepEqual(pending.uploadedFileIndexes, [0])
  await syncOfflineDailyLog(pending, { ...dependencies, uploadFiles: async ([file]) => uploaded.push(file.name) })
  assert.equal(creates, 1)
  assert.deepEqual(uploaded, ["a.jpg", "b.jpg", "b.jpg"])
})

test("an uncertain create response reuses the persisted submission identifier", async () => {
  let saved
  const ids = []
  const pending = draft()
  const dependencies = {
    persist: async (value) => { saved = structuredClone(value) },
    uploadFiles: async () => {},
    createLog: async (input) => { ids.push(input.submission_id); throw new Error("connection lost") },
  }
  await assert.rejects(syncOfflineDailyLog(pending, dependencies))
  await syncOfflineDailyLog(saved, { ...dependencies, createLog: async (input) => { ids.push(input.submission_id); return { id: "created" } } })
  assert.ok(ids[0])
  assert.equal(ids[0], ids[1])
})

test("storage failure stops sync before issuing a create request", async () => {
  let creates = 0
  await assert.rejects(syncOfflineDailyLog(draft(), {
    persist: async () => { throw new Error("quota exceeded") },
    createLog: async () => { creates++; return { id: "created" } },
    uploadFiles: async () => {},
  }), /quota exceeded/)
  assert.equal(creates, 0)
})
