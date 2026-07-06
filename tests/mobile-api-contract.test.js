const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

function loadContracts() {
  const filename = path.resolve(__dirname, "../lib/mobile/contracts.ts")
  const source = fs.readFileSync(filename, "utf8")
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText
  const moduleRecord = { exports: {} }
  Function("exports", "require", "module", "__filename", "__dirname", output)(
    moduleRecord.exports,
    require,
    moduleRecord,
    filename,
    path.dirname(filename),
  )
  return moduleRecord.exports
}

test("mobile pagination is bounded and cursors round-trip", () => {
  const contracts = loadContracts()

  assert.equal(contracts.parsePageSize(null), 50)
  assert.equal(contracts.parsePageSize("0"), 50)
  assert.equal(contracts.parsePageSize("250"), 100)

  const cursor = contracts.encodeCursor("2026-06-23T12:00:00.000Z", "project-1")
  assert.deepEqual(contracts.decodeCursor(cursor), {
    updated_at: "2026-06-23T12:00:00.000Z",
    id: "project-1",
  })
  assert.equal(contracts.decodeCursor("not-a-cursor"), null)
})

test("mobile API endpoints and version remain stable", () => {
  const contracts = loadContracts()
  assert.equal(contracts.MOBILE_API_VERSION, "v1")

  const spec = fs.readFileSync(
    path.resolve(__dirname, "../docs/mobile-api-v1.openapi.yaml"),
    "utf8",
  )
  for (const endpoint of [
    "/session:",
    "/organizations:",
    "/projects:",
    "/projects/{projectId}:",
    "/projects/{projectId}/daily-logs:",
    "/projects/{projectId}/daily-logs/context:",
    "/projects/{projectId}/daily-logs/{dailyLogId}:",
    "/projects/{projectId}/daily-logs/{dailyLogId}/comments:",
    "/projects/{projectId}/daily-logs/{dailyLogId}/photos:",
    "/projects/{projectId}/drawings/sets:",
    "/projects/{projectId}/drawings/sheets:",
    "/projects/{projectId}/drawings/sheets/{sheetId}:",
    "/projects/{projectId}/schedule:",
    "/projects/{projectId}/tasks:",
    "/projects/{projectId}/tasks/{taskId}:",
    "/projects/{projectId}/punch-items:",
    "/projects/{projectId}/punch-items/{punchItemId}:",
    "/projects/{projectId}/expenses:",
    "/projects/{projectId}/expenses/scan:",
    "/projects/{projectId}/files:",
    "/projects/{projectId}/files/{fileId}:",
    "/notifications:",
    "/notifications/{notificationId}/read:",
    "/notifications/read-all:",
    "/platform/audit-log:",
    "/platform/issues:",
    "/projects/{projectId}/rfis:",
    "/projects/{projectId}/team:",
    "/devices:",
  ]) {
    assert.ok(spec.includes(endpoint), `OpenAPI spec is missing ${endpoint}`)
  }
})
