require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const { NextRequest } = require("next/server")

const { isAuthorizedCronRequest } = require("@/lib/services/cron-auth")
const { CRON_JOBS } = require("@/lib/services/job-runs")
const { proxy } = require("@/proxy")

const root = path.resolve(__dirname, "..")
const vercel = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"))

function cronRequest(headers = {}) {
  return { headers: new Headers(headers) }
}

function withEnv(env, run) {
  const previous = { NODE_ENV: process.env.NODE_ENV, CRON_SECRET: process.env.CRON_SECRET }
  const apply = (values) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  apply(env)
  try {
    return run()
  } finally {
    apply(previous)
  }
}

// Every /api/jobs/* route is publicly reachable, so this gate is the only thing
// between the open internet and the nightly projection, reconciliation and
// payment jobs.

test("in production, a cron route without a configured secret denies everyone", () => {
  withEnv({ NODE_ENV: "production", CRON_SECRET: undefined }, () => {
    // `x-vercel-cron` is attacker-settable on a public route.
    assert.equal(isAuthorizedCronRequest(cronRequest({ "x-vercel-cron": "1" })), false)
    assert.equal(isAuthorizedCronRequest(cronRequest()), false)
  })
})

test("a configured cron secret is required and sufficient", () => {
  withEnv({ NODE_ENV: "production", CRON_SECRET: "s3cret" }, () => {
    for (const [headers, allowed] of [
      [{ authorization: "Bearer s3cret" }, true],
      [{ "x-cron-secret": "s3cret" }, true],
      [{ authorization: "Bearer wrong" }, false],
      [{ "x-vercel-cron": "1" }, false],
    ]) {
      assert.equal(isAuthorizedCronRequest(cronRequest(headers)), allowed, JSON.stringify(headers))
    }
  })
})

test("local development is open only while no secret is configured", () => {
  withEnv({ NODE_ENV: "development", CRON_SECRET: undefined }, () => {
    assert.equal(isAuthorizedCronRequest(cronRequest()), true)
  })
  withEnv({ NODE_ENV: "development", CRON_SECRET: "s3cret" }, () => {
    assert.equal(isAuthorizedCronRequest(cronRequest()), false)
    assert.equal(isAuthorizedCronRequest(cronRequest({ authorization: "Bearer s3cret" })), true)
  })
})

// Repository invariants: what Vercel schedules, the ops registry watches, the
// proxy lets through, and the shared gate protects must be the same set.

test("every Vercel cron is in CRON_JOBS with the same schedule, and nothing else is", () => {
  const registry = new Map(CRON_JOBS.map((job) => [job.path, job.schedule]))
  for (const cron of vercel.crons) {
    assert.equal(registry.get(cron.path), cron.schedule, `${cron.path} missing from CRON_JOBS or on another schedule`)
  }
  const scheduled = new Set(vercel.crons.map((cron) => cron.path))
  assert.deepEqual(CRON_JOBS.map((job) => job.path).filter((route) => !scheduled.has(route)), [])
})

test("the proxy passes every cron route through without a session", async () => {
  for (const cron of vercel.crons) {
    const response = await proxy(new NextRequest(`https://arc.test${cron.path}`))
    assert.equal(response.headers.get("x-middleware-next"), "1", `${cron.path} missing from PUBLIC_API_ROUTES`)
  }
})

test("every job route is gated by the shared helper and none re-implements it", () => {
  const apiDir = path.join(root, "app/api")
  const routes = []
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === "route.ts") routes.push([path.relative(apiDir, full), fs.readFileSync(full, "utf8")])
    }
  }
  walk(apiDir)

  const ungated = routes
    .filter(([route]) => /^jobs\/[^/]+\/route\.ts$/.test(route))
    .filter(([, source]) => !source.includes("isAuthorizedCronRequest"))
  assert.deepEqual(ungated.map(([route]) => route), [], "job routes with no cron gate")

  // Fifteen routes once drifted into nine hand-rolled gates, four of which
  // trusted the forgeable x-vercel-cron header.
  const inlined = routes.filter(([, source]) => /process\.env\.CRON_SECRET|x-vercel-cron/.test(source))
  assert.deepEqual(inlined.map(([route]) => route), [], "routes re-implementing the cron gate")
})
