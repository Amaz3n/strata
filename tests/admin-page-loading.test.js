const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const React = require("react")
const ts = require("typescript")

const cases = [
  ["customers", "Customer Management", ["billing.manage", "platform.billing.manage"]],
  ["payment-fees", "Payment Fees", "platform.billing.manage"],
  ["features", "Feature Flags", ["features.manage", "platform.feature_flags.manage"]],
  ["audit", "Audit Log", ["audit.read", "platform.support.read"]],
  ["support", "Support Contracts", ["billing.manage", "platform.support.read"]],
  ["users", "User Activity", ["billing.manage", "platform.support.read"]],
  ["ops", "Ops", ["billing.manage", "platform.support.read"]],
  ["ops/drawings", "Drawings pipeline", ["billing.manage", "platform.support.read"]],
  ["ops/payment-launch", "Payment launch gates", "launch owner"],
  ["ops/ai", "AI", ["billing.manage", "platform.support.read"]],
  ["subscription-plans", "Subscription Plans", ["billing.manage", "platform.billing.manage"]],
]

function fixture(path) {
  let connect, authorize
  const live = new Promise(resolve => { connect = resolve })
  const permission = new Promise((_, reject) => { authorize = reject })
  const calls = []
  const guard = value => { calls.push(["permission", value]); return permission }
  const modules = {
    "next/server": { connection: () => live },
    "@/lib/auth/guards": { requireAnyPermissionGuard: guard, requirePermissionGuard: guard },
    "@/lib/services/payment-launch-readiness": { requirePaymentLaunchOwner: () => guard("launch owner") },
  }
  const exports = {}
  const leaves = new Proxy({}, { get: (_, key) => (...args) => { calls.push(["data", key, args]); return null } })
  const source = fs.readFileSync(`app/(app)/admin/${path}/page.tsx`, "utf8")
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function("exports", "require", code)(exports, name => ["react", "react/jsx-runtime"].includes(name) ? require(name) : modules[name] ?? leaves)
  const pending = new Promise(() => {})
  const shell = exports.default({ params: pending, searchParams: pending })
  return { calls, connect, authorize, shell }
}

for (const [path, title, permissions] of cases) {
  test(`${title} exposes its destination while route and authorization promises are pending`, async () => {
    const f = fixture(path)
    assert.equal(f.shell.type, React.Suspense)
    assert.equal(f.shell.props.fallback.props.title, title)
    assert.ok(f.shell.props.fallback.props.breadcrumbs.length >= 2)
    assert.deepEqual(f.calls, [], "building the fallback does not read protected data")
    const content = f.shell.props.children
    const result = content.type(content.props)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(f.calls, [], "authorization and protected reads wait for a live request")
    f.connect()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(f.calls, [["permission", permissions]])
    const forbidden = new Error("Forbidden")
    const rejected = assert.rejects(result, error => error === forbidden)
    f.authorize(forbidden)
    await rejected
    assert.deepEqual(f.calls, [["permission", permissions]], "denied access does not start a protected read")
  })
}
