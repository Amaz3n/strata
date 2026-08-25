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
    "/my-houses:",
    "/my-houses/work:",
    "/my-houses/schedule-items/{scheduleItemId}/complete:",
    "/organizations/{organizationId}/reason-codes:",
    "/projects/{projectId}/purchase-orders:",
    "/projects/{projectId}/vpos:",
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
    "/payables:",
    "/payables/{id}:",
    "/payables/{id}/decision:",
    "/devices:",
  ]) {
    assert.ok(spec.includes(endpoint), `OpenAPI spec is missing ${endpoint}`)
  }
})

function readSource(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, "..", relativePath), "utf8")
}

test("payable due dates are whole calendar days, signed for overdue", () => {
  const contracts = loadContracts()
  const today = new Date("2026-08-08T18:30:00.000Z")

  assert.equal(contracts.daysUntilDue("2026-08-08", today), 0)
  assert.equal(contracts.daysUntilDue("2026-08-18", today), 10)
  // Past due reads negative rather than clamping to zero — the field approver
  // needs to see how late a vendor already is.
  assert.equal(contracts.daysUntilDue("2026-07-29", today), -10)
  assert.equal(contracts.daysUntilDue(null, today), null)
  assert.equal(contracts.daysUntilDue("not-a-date", today), null)
  // A timestamp is truncated to its date, so the clock cannot shift the answer.
  assert.equal(contracts.daysUntilDue("2026-08-09T23:59:59.000Z", today), 1)
})

test("mobile payable routes exist and are reachable through the proxy", () => {
  for (const route of [
    "app/api/mobile/v1/payables/route.ts",
    "app/api/mobile/v1/payables/[id]/route.ts",
    "app/api/mobile/v1/payables/[id]/decision/route.ts",
  ]) {
    assert.ok(fs.existsSync(path.resolve(__dirname, "..", route)), `Missing route ${route}`)
  }

  // Without a PUBLIC_API_ROUTES prefix the proxy 307s these to /auth/signin and
  // the app sees an empty queue instead of an error.
  const proxy = readSource("proxy.ts")
  const publicRoutes = proxy.slice(
    proxy.indexOf("const PUBLIC_API_ROUTES = ["),
    proxy.indexOf("]", proxy.indexOf("const PUBLIC_API_ROUTES = [")),
  )
  const prefixes = [...publicRoutes.matchAll(/"([^"]+)"/g)].map((match) => match[1])
  for (const pathname of [
    "/api/mobile/v1/payables",
    "/api/mobile/v1/payables/00000000-0000-0000-0000-000000000000",
    "/api/mobile/v1/payables/00000000-0000-0000-0000-000000000000/decision",
  ]) {
    assert.ok(
      prefixes.some((prefix) => pathname.startsWith(prefix)),
      `${pathname} is not covered by a PUBLIC_API_ROUTES prefix`,
    )
  }
  // The proxy matches by prefix, which is what makes one mobile entry enough.
  // Tolerates either arrow-parameter style so reformatting the proxy cannot
  // fail this on spelling while the behaviour it guards is intact.
  assert.match(proxy, /PUBLIC_API_ROUTES\.some\(\(?route\)? => pathname\.startsWith\(route\)\)/)
})

test("bill approval delegates to the one status service and guards concurrency", () => {
  const source = readSource("lib/mobile/payables.ts")

  // `updateVendorBillStatus` owns the bill.approve check, the rejection-reason
  // rule, the coding gates, and ledger propagation. Re-stating any of it here
  // would let mobile drift away from the desk.
  assert.match(source, /import \{[\s\S]*updateVendorBillStatus[\s\S]*\} from "@\/lib\/services\/vendor-bills"/)
  assert.match(source, /updateVendorBillStatus\(\{/)
  assert.ok(
    !/from\("vendor_bills"\)[\s\S]{0,400}\.update\(/.test(source),
    "mobile must not write vendor_bills directly",
  )

  // A phone that has been in a pocket must not overwrite a desk decision.
  assert.match(source, /expected_updated_at: z\.string\(\)\.min\(1\)/)
  assert.match(source, /expected_updated_at: parsed\.data\.expected_updated_at/)
  assert.match(source, /409, "payable_conflict"/)

  // Rejection reason matches what the service demands, so the app can show a
  // field error instead of surfacing a 422 from deep in the service.
  assert.match(source, />= 8/)
})

test("bill approval deliberately carries no payment step-up", () => {
  const payables = readSource("lib/mobile/payables.ts")
  const paymentRuns = readSource("lib/mobile/payment-runs.ts")

  // Releasing money steps up; accepting an obligation does not. The web app
  // draws the same line, and a phone stricter than the desk sends people back
  // to a laptop — the behaviour these endpoints exist to end.
  assert.match(paymentRuns, /requireRecentMobilePaymentStepUp/)
  assert.ok(
    !payables.includes("requireRecentMobilePaymentStepUp"),
    "bill approval must not step-up gate; that is the payment-release control",
  )
  assert.ok(!payables.includes("resolveStepUp"), "bill approval takes no step-up override")
  assert.ok(payables.includes("step-up"), "the step-up decision must be explained in a comment")
})

test("every mobile payables query is org-scoped", () => {
  const source = readSource("lib/mobile/payables.ts")
  const tables = [...source.matchAll(/\.from\("([a-z_]+)"\)/g)].map((match) => match[1])

  assert.deepEqual(
    [...new Set(tables)].sort(),
    ["file_links", "files", "lots", "project_members", "vendor_bills"],
    "unexpected table read — every one of these must stay org-scoped",
  )
  // RLS depends on org_id being on every query, so each `.from(` needs one.
  assert.equal(tables.length, (source.match(/\.eq\("org_id", context\.orgId\)/g) ?? []).length)
})

test("the approval queue is capped and scoped to what the caller can decide", () => {
  const source = readSource("lib/mobile/payables.ts")

  // Lists get a cap from day one, and the caller can see when it truncated.
  assert.match(source, /Math\.min\(MAX_PAGE_SIZE/)
  assert.match(source, /page_count:/)
  assert.match(source, /count: "exact"/)

  // A queue listing payables the viewer cannot decide is one they learn to
  // ignore, so scope is resolved before the query rather than filtered after.
  assert.match(source, /permission: "bill\.approve"/)
  assert.match(source, /403,\s*"bill_approval_forbidden"/)
  assert.match(source, /\.eq\("status", "pending"\)/)
  // Drafts are not obligations and vendor credits are money coming back.
  assert.match(source, /creation_state\.neq\.draft/)
  assert.match(source, /source\.neq\.vendor_credit/)
})
