const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function fixture({ denied = false, missing = false, missingProject = false, canPay = true, balance = 1200, proofFailure = false, policyFailure = false } = {}) {
  const policy = deferred(), reads = []
  const dependencies = {
    "next/server": { connection: async () => {} },
    "next/navigation": { notFound: () => { throw new Error("Not found") }, unstable_rethrow: require("next/navigation").unstable_rethrow },
    "@/lib/services/portal-access": { assertPortalActionAccess: async (token, options) => {
      reads.push(["access", token, options])
      if (denied) throw new Error("Denied")
      return { org_id: "org", project_id: missingProject ? null : "project", permissions: { can_pay_invoices: canPay } }
    } },
    "@/lib/services/invoices": { getInvoiceForPortal: async (...args) => { reads.push(["invoice", ...args]); return missing ? null : { id: "invoice", token: "invoice-token", totals: { balance_due_cents: balance }, metadata: { card: false } } } },
    "@/lib/services/receipts": { listReceiptsForInvoice: async scope => { reads.push(["receipts", scope]); return ["receipt"] } },
    "@/lib/services/cost-plus": { listOpenBookCostDetailsForInvoice: async scope => { reads.push(["costs", scope]); if (proofFailure) throw new Error("Unavailable"); return ["cost"] } },
    "@/lib/services/owner-billing-packages": { listSharedInvoiceBackupPackagesForPortal: async scope => { reads.push(["backup", scope]); return ["package"] } },
    "@/lib/supabase/server": { createServiceSupabaseClient: () => ({}) },
    "@/lib/payments/fee-engine": {
      loadPaymentFeePolicy: () => { reads.push(["policy"]); return policyFailure ? Promise.reject(new Error("Policy unavailable")) : policy.promise },
      restrictPaymentFeePolicyToInvoice: (value, metadata) => { reads.push(["restrict", metadata]); return value },
      calculatePaymentFeeQuotes: amount => ({ amount }),
    },
  }
  const exports = {}, leaf = new Proxy({}, { get: () => () => null })
  const source = ts.transpileModule(fs.readFileSync("app/p/[token]/invoices/[id]/page.tsx", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  new Function("exports", "require", "process", source)(exports, name =>
    name === "react/jsx-runtime" ? require(name) : dependencies[name] ?? leaf,
    { env: { NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "fixture-key" } },
  )
  return { reads, policy, content: () => exports.default({ params: Promise.resolve({ token: "portal-token", id: "invoice" }) }) }
}

test("invoice evidence starts while payment settings are pending and stays scoped to the authorized invoice", async () => {
  const f = fixture()
  const resultPromise = f.content()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.reads.map(read => read[0]), ["access", "invoice", "policy", "receipts", "costs", "backup"])
  assert.deepEqual(f.reads[1], ["invoice", "invoice", "org", "project"])
  assert.deepEqual(f.reads[4][1], { orgId: "org", projectId: "project", invoiceId: "invoice" })
  f.policy.resolve({})
  const client = (await resultPromise).props.children[1]
  assert.deepEqual(client.props.payment.feeQuotes, { amount: 1200 })
  assert.deepEqual(client.props.receipts, ["receipt"])
  assert.deepEqual(client.props.backupPackages, ["package"])
  assert.deepEqual(f.reads.at(-1), ["restrict", { card: false }])
})

test("denied or missing invoices never start payment or evidence reads", async () => {
  for (const options of [{ denied: true }, { missing: true }, { missingProject: true }]) {
    const f = fixture(options)
    await assert.rejects(f.content(), /Not found/)
    assert.equal(f.reads.some(read => ["policy", "receipts", "costs", "backup"].includes(read[0])), false)
  }
})

test("payment-disabled and paid invoices still show independently available evidence", async () => {
  for (const options of [{ canPay: false }, { balance: 0 }]) {
    const f = fixture({ ...options, proofFailure: true })
    const client = (await f.content()).props.children[1]
    assert.equal(client.props.payment, null)
    assert.equal(f.reads.some(read => read[0] === "policy"), false)
    assert.deepEqual(client.props.costDetails, [])
    assert.deepEqual(client.props.receipts, ["receipt"])
    assert.deepEqual(client.props.proofErrors, ["Cost detail: Unavailable"])
  }
})

test("unavailable payment settings preserve invoice evidence and offline payment fallback", async t => {
  t.mock.method(console, "warn", () => {})
  const f = fixture({ policyFailure: true })
  const client = (await f.content()).props.children[1]
  assert.equal(client.props.payment, null)
  assert.deepEqual(client.props.receipts, ["receipt"])
  assert.deepEqual(client.props.backupPackages, ["package"])
  assert.deepEqual(client.props.proofErrors, [])
})
