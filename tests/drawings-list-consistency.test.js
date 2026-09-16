const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const vm = require("node:vm")
const ts = require("typescript")

// Exercise the actual read implementation with a deliberately stale snapshot.
const source = fs.readFileSync("lib/services/drawings.ts", "utf8")
const start = source.indexOf("async function listDrawingSheetsOptimized(")
const end = source.indexOf("\n}\n", start) + 2
const code = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2020 })

function reader(live, snapshot) {
  let queryCount = 0
  const query = {
    select() { return this },
    eq() { return this },
    in(_, ids) {
      queryCount++
      return Promise.resolve({ data: snapshot.filter((row) => ids.includes(row.id)), error: null })
    },
  }
  const context = {
    listDrawingSheets: async () => live,
    createServiceSupabaseClient: () => ({ from: () => query }),
    mapDrawingSheet: (row) => row,
  }
  vm.createContext(context)
  vm.runInContext(code, context)
  return { read: context.listDrawingSheetsOptimized, queries: () => queryCount }
}

test("deleted snapshot entries cannot reappear in the live page", async () => {
  const { read } = reader(
    [{ id: "kept", org_id: "org", sheet_title: "Renamed", current_revision_id: "r1" }],
    [{ id: "deleted" }, { id: "kept", sheet_title: "Old name", current_revision_id: "r1", image_thumbnail_url: "/preview" }],
  )
  const result = await read({})
  assert.equal(result.length, 1)
  assert.equal(result[0].id, "kept")
  assert.equal(result[0].sheet_title, "Renamed")
  assert.equal(result[0].image_thumbnail_url, "/preview")
})

test("deleting the last sheet returns empty without consulting the snapshot", async () => {
  const { read, queries } = reader([], [{ id: "deleted" }])
  assert.equal((await read({})).length, 0)
  assert.equal(queries(), 0)
})

test("outdated revision imagery requires the authoritative fallback", async () => {
  const { read } = reader(
    [{ id: "sheet", org_id: "org", current_revision_id: "new" }],
    [{ id: "sheet", current_revision_id: "old" }],
  )
  await assert.rejects(read({}), /snapshot is behind/)
})
