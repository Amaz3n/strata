const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "..")
const vercel = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"))
const registrySource = fs.readFileSync(path.join(root, "lib/services/job-runs.ts"), "utf8")
const proxySource = fs.readFileSync(path.join(root, "proxy.ts"), "utf8")

test("every Vercel cron is registered for ops heartbeat and allowed through the proxy", () => {
  for (const cron of vercel.crons ?? []) {
    assert.match(registrySource, new RegExp(`path:\\s*["']${cron.path.replaceAll("/", "\\/")}["']`), `${cron.path} missing from CRON_JOBS`)
    assert.ok(proxySource.includes(`"${cron.path}"`), `${cron.path} missing from PUBLIC_API_ROUTES`)
  }
})
