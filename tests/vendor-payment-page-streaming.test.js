const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")
const { renderToStaticMarkup } = require("react-dom/server")

function load(file, modules = {}) {
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const leaves = new Proxy({}, { get: () => () => null })
  new Function("exports", "require", code)(exports, name =>
    ["react", "react/jsx-runtime"].includes(name) ? require(name) : modules[name] ?? leaves,
  )
  return exports
}
function elements(tree) {
  if (!React.isValidElement(tree)) return []
  return [tree, ...React.Children.toArray(tree.props.children).flatMap(elements)]
}
function fixture({ access = { id: "token-id", portal_type: "sub", org_id: "org", company_id: "company" }, setupOpen = true, paymentAccess = { state: "open" }, grant = true, connection = Promise.resolve() } = {}) {
  const calls = []
  const AccountGate = () => null
  const Setup = () => null
  const page = load("app/s/[token]/payments/page.tsx", {
    "next/server": { connection: () => connection },
    "next/navigation": { notFound: () => { throw new Error("Not found") }, redirect: href => { throw new Error(`Redirect: ${href}`) } },
    "@/components/portal/account/portal-account-gate": { PortalAccountGate: AccountGate },
    "./vendor-payment-setup": { VendorPaymentSetup: Setup },
    "@/lib/services/portal-access": { validatePortalToken: async token => { calls.push(["token", token]); return access } },
    "@/lib/services/payment-rail-setup": {
      isVendorPayoutSetupOpen: async org => { calls.push(["setup-open", org]); return setupOpen },
      reconcileVendorRecipientAfterOnboarding: async entity => { calls.push(["reconcile", entity]) },
    },
    "@/lib/services/vendor-payment-identities": {
      getVendorPortalPaymentAccess: async token => { calls.push(["payment-access", token]); return paymentAccess },
      getVendorPaymentSetupContext: async token => { calls.push(["setup-context", token]); return { builder: { orgName: "Fixture builder" } } },
    },
    "@/lib/services/external-portal-auth": {
      hasExternalPortalGrantForToken: async input => { calls.push(["grant", input]); return grant },
      getExternalPortalGateContext: async () => { calls.push(["account-context"]); return null },
    },
  }).default
  const shell = page({ params: Promise.resolve({ token: "fixture-token" }), searchParams: Promise.resolve({}) })
  function content(query = {}) {
    const next = page({ params: Promise.resolve({ token: "fixture-token" }), searchParams: Promise.resolve(query) }).props.children
    return next.type(next.props)
  }
  return { shell, content, calls, AccountGate, Setup }
}

test("vendor payment setup exposes its shell while live reads wait for a request", async () => {
  let release
  const connection = new Promise(resolve => { release = resolve })
  const { shell, content, calls } = fixture({ connection })
  assert.equal(shell.type, React.Suspense)
  assert.equal(shell.props.fallback.props.title, "Get paid through Arc")
  const pending = content()
  await Promise.resolve()
  assert.deepEqual(calls, [])
  release()
  await pending
  assert.deepEqual(calls.map(call => call[0]), ["token", "setup-open", "payment-access", "grant", "setup-context"])
})
test("invalid, wrong-kind, company-less, and disabled payout links never read payout state", async () => {
  for (const options of [{ access: null }, { access: { portal_type: "client" } }, { access: { portal_type: "sub", company_id: null } }, { setupOpen: false }]) {
    const { content, calls } = fixture(options)
    await assert.rejects(content({ payments: "return", entity: "entity" }), /Not found/)
    assert.equal(calls.some(call => ["payment-access", "grant", "reconcile", "setup-context"].includes(call[0])), false)
  }
})
test("closed payment relationships show their status before any grant or reconciliation calls", async () => {
  for (const [paymentAccess, expected] of [
    [{ state: "withdrawn", status: "suspended" }, "Electronic payment is paused"],
    [{ state: "withdrawn", status: "revoked" }, "Electronic payment was withdrawn"],
    [{ state: "not_invited" }, "This builder has not invited you yet"],
  ]) {
    const { content, calls } = fixture({ paymentAccess })
    const result = await content({ payments: "return", entity: "entity" })
    assert.ok(elements(result).some(node => node.type === "h2" && node.props.children === expected))
    assert.equal(calls.some(call => ["grant", "reconcile", "setup-context"].includes(call[0])), false)
  }
})
test("an unclaimed payout link renders its account form without touching recipient state", async () => {
  const { content, calls, AccountGate } = fixture({ grant: false })
  const result = await content({ payments: "return", entity: "entity" })
  assert.ok(elements(result).some(node => node.type === AccountGate && node.props.purpose === "vendor_payout"))
  assert.equal(calls.some(call => ["reconcile", "setup-context"].includes(call[0])), false)
})
test("an authorized onboarding return reconciles before redirecting and does not load setup data", async () => {
  const { content, calls } = fixture()
  await assert.rejects(content({ payments: "return", entity: "entity" }), error => error.message === "Redirect: /s/fixture-token/payments?verified=1")
  assert.deepEqual(calls.map(call => call[0]), ["token", "setup-open", "payment-access", "grant", "reconcile"])
  assert.deepEqual(calls.at(-1), ["reconcile", "entity"])
})
test("an expired onboarding link and verified arrival preserve their client flags without reconciliation", async () => {
  const { content, calls, Setup } = fixture()
  const result = await content({ payments: "refresh", verified: "1", entity: "entity" })
  const setup = elements(result).find(node => node.type === Setup)
  assert.equal(setup.props.justVerified, true)
  assert.equal(setup.props.linkExpired, true)
  assert.equal(calls.some(call => call[0] === "reconcile"), false)
})
test("titled portal loading HTML has one heading while generic cold shells keep their skeleton", () => {
  const { PortalPageSkeleton } = load("components/portal/shell/portal-skeleton.tsx", {
    "./portal-page-header": load("components/portal/shell/portal-page-header.tsx"),
    "@/components/ui/skeleton": { Skeleton: props => React.createElement("div", { ...props, "data-skeleton": true }) },
  })
  const titled = renderToStaticMarkup(React.createElement(PortalPageSkeleton, { title: "Invoices", rows: 3 }))
  assert.equal((titled.match(/<h1\b/g) ?? []).length, 1)
  assert.match(titled, />Invoices<\/h1>/)
  assert.equal((titled.match(/data-skeleton/g) ?? []).length, 3)
  assert.match(titled, /role="status"/)
  const generic = renderToStaticMarkup(React.createElement(PortalPageSkeleton))
  assert.equal((generic.match(/<h1\b/g) ?? []).length, 0)
  assert.equal((generic.match(/data-skeleton/g) ?? []).length, 6)
})
