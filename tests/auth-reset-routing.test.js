const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const ts = require("typescript")

const file = "app/(auth)/auth/reset/page.tsx"
const code = ts.transpileModule(fs.readFileSync(file, "utf8") + "\nexport { ResetRoute };", {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const loaded = {}
const Client = () => null
new Function("exports", "require", code)(loaded, id => {
  if (id === "@/components/auth/auth-reset-page") return { default: Client }
  if (id === "next/navigation") return { redirect: destination => { throw Object.assign(new Error("redirect"), { destination }) } }
  return require(id)
})

test("reset codes exchange before the browser client mounts and return to reset", async () => {
  await assert.rejects(loaded.ResetRoute({ searchParams: Promise.resolve({ code: "one-time", next: "//external.example" }) }), error => {
    const url = new URL(error.destination, "https://arc.local")
    assert.equal(url.pathname, "/auth/confirm")
    assert.equal(url.searchParams.get("code"), "one-time")
    assert.equal(url.searchParams.get("next"), "/auth/reset")
    return true
  })
})

test("reset token hashes default to recovery and preserve an explicit type for validation", async () => {
  for (const type of [undefined, "recovery", "invalid"]) {
    await assert.rejects(loaded.ResetRoute({ searchParams: Promise.resolve({ token_hash: "hash", type }) }), error => {
      const url = new URL(error.destination, "https://arc.local")
      assert.equal(url.searchParams.get("type"), type ?? "recovery")
      assert.equal(url.searchParams.get("token_hash"), "hash")
      assert.equal(url.searchParams.get("next"), "/auth/reset")
      return true
    })
  }
})

test("external resets and already-confirmed sessions keep their client form", async () => {
  for (const params of [{}, { external_token: "external", code: "ignore" }]) {
    const result = await loaded.ResetRoute({ searchParams: Promise.resolve(params) })
    assert.equal(result.type, Client)
  }
})
