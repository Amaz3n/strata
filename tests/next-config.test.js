const assert = require("node:assert/strict")
const path = require("node:path")
const test = require("node:test")
const { pathToFileURL } = require("node:url")

const configUrl = pathToFileURL(path.resolve(__dirname, "../next.config.mjs")).href

/** The config Next would build with under `env` (a fresh module evaluation each time). */
async function configUnder(env) {
  const previous = { ...process.env }
  Object.assign(process.env, env)
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]
  try {
    return (await import(`${configUrl}?env=${encodeURIComponent(JSON.stringify(env))}`)).default
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
  }
}

test("a production build exposes the instant-navigation testing API only when explicitly asked", async () => {
  for (const flag of [undefined, "false", "1", "true"]) {
    const config = await configUnder({ NODE_ENV: "production", NEXT_INSTANT_NAVIGATION_TESTING: flag })
    assert.equal(config.experimental.exposeTestingApiInProductionBuild, flag === "true", String(flag))
  }
})
