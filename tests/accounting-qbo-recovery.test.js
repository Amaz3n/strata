const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const Module = require("node:module")
const ts = require("typescript")

function finder(pages, deadline = () => undefined) {
  const filename = path.resolve(__dirname, "../lib/integrations/accounting/qbo/client.ts")
  class AccountingDeliveryError extends Error {
    constructor(message, retryable, reason) { super(message); this.retryable = retryable; this.reason = reason }
  }
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = module.paths
  mod.require = (name) => name === "@/lib/services/accounting-delivery"
    ? { accountingDeliveryDeadline: deadline, AccountingDeliveryError }
    : name.startsWith("@/") ? {} : require(name)
  mod._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename)
  const requests = []
  const client = {
    async request(method, endpoint) {
      requests.push({ method, query: decodeURIComponent(endpoint.split("query=")[1]) })
      const next = pages.shift()
      if (next instanceof Error) throw next
      if (typeof next === "function") return next()
      assert.notEqual(next, undefined, "lookup must stop at the exhausted page")
      return next
    },
  }
  return { requests, run: (marker = "[arc:payment:local]") => mod.exports.QBOClient.prototype.findTransactionByPrivateNote.call(client, "Payment", marker) }
}
const page = (rows) => ({ QueryResponse: { Payment: rows } })
const fullPage = () => Array.from({ length: 1000 }, (_, index) => ({ Id: String(index + 1) }))

test("finds a backdated previous create past 1000 results with no history cutoff", async () => {
  const found = { Id: "1001", TxnDate: "1999-01-01", PrivateNote: "old [arc:payment:local]" }
  const { run, requests } = finder([page(fullPage()), page([found]), { QueryResponse: {} }])
  assert.equal((await run()).Id, "1001")
  assert.equal(requests.length, 3)
  assert.match(requests[1].query, /STARTPOSITION 1001 MAXRESULTS 1000/)
  assert.match(requests[2].query, /STARTPOSITION 1002 MAXRESULTS 1000/)
  assert.ok(requests.every(({ query }) => !query.includes("WHERE")))
})

test("returns absence only after exhausting every page", async () => {
  const { run, requests } = finder([page(fullPage()), page([{ Id: "1001" }]), page([])])
  assert.equal(await run(), null)
  assert.equal(requests.length, 3)
})

test("a failed later page cannot authorize a duplicate create", async () => {
  const error = new Error("throttled")
  const { run } = finder([page(fullPage()), error])
  await assert.rejects(run(), (actual) => actual === error)
})

test("a match on an incomplete scan still requires recovery rather than guessing", async () => {
  const { run } = finder([page([{ Id: "1", PrivateNote: "[arc:payment:local]" }]), new Error("offline")])
  await assert.rejects(run(), /offline/)
})

test("repeated pages cannot loop forever or imply absence", async () => {
  const { run, requests } = finder([page(fullPage()), page(fullPage())])
  await assert.rejects(run(), (error) => error.reason === "unstable_recovery_page" && error.retryable)
  assert.equal(requests.length, 2)
})

test("malformed response, malformed identities, and contradictory empty pages fail closed", async () => {
  for (const response of [{}, { QueryResponse: { Payment: {} } }, { QueryResponse: { Payment: null } }, page([{}]), { QueryResponse: { totalCount: 2 } }]) {
    await assert.rejects(finder([response]).run(), (error) => error.reason === "invalid_recovery_response")
  }
})

test("deadline exhaustion before a lookup cannot imply absence", async () => {
  const { run, requests } = finder([], () => Date.now() - 1)
  await assert.rejects(run(), (error) => error.reason === "deadline" && error.retryable)
  assert.equal(requests.length, 0)
})

test("deadline exhaustion after a response cannot imply absence", async () => {
  const originalNow = Date.now
  let now = 100
  Date.now = () => now
  try {
    const { run } = finder([() => { now = 201; return page([]) }], () => 200)
    await assert.rejects(run(), (error) => error.reason === "deadline")
  } finally { Date.now = originalNow }
})

test("multiple marker matches require review", async () => {
  const { run } = finder([page([{ Id: "1", PrivateNote: "[arc:payment:local]" }, { Id: "2", PrivateNote: "[arc:payment:local]" }])])
  await assert.rejects(run(), (error) => error.reason === "ambiguous_remote_identity" && error.retryable === false)
})

test("empty recovery marker never authorizes creation", async () => {
  const { run, requests } = finder([])
  await assert.rejects(run("  "), (error) => error.reason === "invalid_recovery_marker")
  assert.equal(requests.length, 0)
})
