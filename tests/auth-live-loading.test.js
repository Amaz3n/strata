const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")
function load(section, modules) {
  const exports = {}, code = ts.transpileModule(fs.readFileSync(`app/(auth)/auth/${section}/page.tsx`, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function("exports", "require", code)(exports, name => ["react", "react/jsx-runtime"].includes(name) ? require(name) : modules[name] ?? new Proxy({}, { get: () => () => { throw Error(`Unexpected module call: ${name}`) } }))
  return exports.default
}
function elements(element) {
  if (!React.isValidElement(element)) return []
  return [element, ...React.Children.toArray(element.props.children).flatMap(elements)]
}
for (const section of ["verify", "accept-invite"]) {
  test(`${section} does no token or identity work during prefetch`, async () => {
    let reject
    const calls = [], live = new Promise((_, fail) => { reject = fail }), page = load(section, { "next/server": { connection: () => { calls.push("live"); return live } } })
    const shell = page({ searchParams: { then() { calls.push("token"); throw Error("Unexpected token read") } } })
    assert.equal(shell.type, React.Suspense)
    assert.ok(React.isValidElement(shell.props.fallback))
    assert.deepEqual(calls, [])
    const child = shell.props.children, result = child.type(child.props), failure = Error("Aborted prefetch")
    const rejected = assert.rejects(result, error => error === failure)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, ["live"])
    reject(failure); await rejected
    assert.deepEqual(calls, ["live"])
  })
}
test("live email verification confirms the requested token once and preserves expired links", async () => {
  for (const [token, confirmed, heading] of [["fixture-token", true, "Email confirmed"], ["expired-token", false, "This link has expired"], [undefined, false, "This link has expired"]]) {
    const calls = [], page = load("verify", {
      "next/server": { connection: async () => calls.push("live") },
      "@/lib/services/external-portal-auth": { confirmExternalIdentityVerification: async token => { calls.push(["confirm", token]); return confirmed } },
    })
    const child = page({ searchParams: Promise.resolve({ token }) }).props.children, result = await child.type(child.props)
    assert.deepEqual(calls, token ? ["live", ["confirm", token]] : ["live"])
    assert.equal(elements(result).find(element => element.type === "h1").props.children, heading)
  }
})
test("live invitations preserve the first token and private form details", async () => {
  const calls = [], page = load("accept-invite", {
    "next/server": { connection: async () => calls.push("live") },
    "./actions": { getInviteDetailsAction: async token => { calls.push(["lookup", token]); return { orgName: "Fixture org", email: "fixture@example.test" } } },
  })
  const child = page({ searchParams: Promise.resolve({ token: ["first-token", "ignored-token"] }) }).props.children, result = await child.type(child.props)
  assert.deepEqual(calls, ["live", ["lookup", "first-token"]])
  assert.deepEqual(elements(result).find(element => element.props.token === "first-token").props, { token: "first-token", orgName: "Fixture org", email: "fixture@example.test" })
})
test("missing invitation tokens never perform a private lookup", async () => {
  const calls = [], page = load("accept-invite", { "next/server": { connection: async () => calls.push("live") } })
  const child = page({ searchParams: Promise.resolve({}) }).props.children, result = await child.type(child.props)
  assert.deepEqual(calls, ["live"])
  assert.equal(elements(result).find(element => element.type === "h1").props.children, "Invitation not found")
})
