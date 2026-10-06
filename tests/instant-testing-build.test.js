const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { fileURLToPath } = require("node:url")
const test = require("node:test")
const ts = require("typescript")

function nextConfig(env) {
  const code = fs.readFileSync("next.config.mjs", "utf8")
    .replace(/^import .*\n/gm, "")
    .replaceAll("import.meta.url", '"file:///fixture/next.config.mjs"')
    .replace("export default", "return")
  return new Function("process", "dirname", "fileURLToPath", "withSentryConfig", code)(
    { env }, path.dirname, fileURLToPath, config => config,
  )
}

function playwrightConfig(env, manifest) {
  const code = ts.transpileModule(fs.readFileSync("playwright.config.ts", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const exports = {}
  const modules = {
    "@playwright/test": { defineConfig: config => config, devices: { "Desktop Chrome": {} } },
    "node:path": path,
    "node:fs": {
      existsSync: name => name.endsWith("required-server-files.json") && manifest !== undefined,
      readFileSync: () => JSON.stringify(manifest),
    },
  }
  new Function("exports", "require", "process", "__dirname", code)(
    exports, name => { assert.ok(modules[name], name); return modules[name] },
    { env, loadEnvFile: () => { throw Error("Unexpected credential read") } }, "/fixture",
  )
  return exports.default
}

test("production testing API requires the explicit controlled-build flag", () => {
  for (const flag of [undefined, "false", "1", "true"]) {
    const config = nextConfig({ NODE_ENV: "production", NEXT_INSTANT_NAVIGATION_TESTING: flag })
    assert.equal(config.experimental.exposeTestingApiInProductionBuild, flag === "true")
    assert.equal(config.cacheComponents, true)
    assert.equal(config.reactCompiler, true)
    assert.equal(config.experimental.cachedNavigations, true)
  }
})

test("Playwright enables the testing API when building its production server", () => {
  const config = playwrightConfig({})
  assert.match(config.webServer.command, /pnpm build && pnpm start/)
  assert.equal(config.webServer.env.NEXT_INSTANT_NAVIGATION_TESTING, "true")
  assert.equal(config.webServer.reuseExistingServer, false)
})

test("reusing a build requires proof that it exposes the testing API", () => {
  const env = { PLAYWRIGHT_SKIP_BUILD: "1" }
  for (const manifest of [undefined, {}, { config: { experimental: { exposeTestingApiInProductionBuild: false } } }]) {
    assert.throws(() => playwrightConfig(env, manifest), /rebuild with NEXT_INSTANT_NAVIGATION_TESTING=true/)
  }
  const config = playwrightConfig(env, { config: { experimental: { exposeTestingApiInProductionBuild: true } } })
  assert.match(config.webServer.command, /^pnpm start/)
  assert.doesNotMatch(config.webServer.command, /pnpm build/)
})

test("external browser targets do not inspect an unrelated local build", () => {
  const config = playwrightConfig({ PLAYWRIGHT_SKIP_BUILD: "1", PLAYWRIGHT_BASE_URL: "https://fixture.test" })
  assert.equal(config.webServer, undefined)
  assert.equal(config.use.baseURL, "https://fixture.test")
})
