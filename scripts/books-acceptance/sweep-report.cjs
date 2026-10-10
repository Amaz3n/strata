#!/usr/bin/env node
// Reads a workspace's production-sweep-<role>-<viewport>.json reports and prints one
// line of counts per role, then every page that errored.
//   node scripts/books-acceptance/sweep-report.cjs --workspace W [--errors]
const fs = require("node:fs"),
  path = require("node:path")

const workspace = process.argv[process.argv.indexOf("--workspace") + 1]
if (!workspace || process.argv.indexOf("--workspace") < 0) throw Error("Use --workspace DIR [--errors]")
const files = fs.readdirSync(workspace).filter((name) => /^production-sweep-[a-z]+-desktop\.json$/.test(name)).sort()
if (!files.length) throw Error(`No production sweep reports in ${workspace}`)
console.log("role            viewport     pages clean refused errors skipped flaky")
for (const file of files) {
  const { role, viewport, accounting: a } = JSON.parse(fs.readFileSync(path.join(workspace, file), "utf8"))
  console.log(`${role.padEnd(15)} ${viewport.padEnd(12)} ${[a.pages, a.clean, a.refused, a.errors, a.skipped, a.flakyFirstLoads].map((n) => String(n).padStart(5)).join(" ")}`)
}
if (process.argv.includes("--errors")) {
  for (const file of files) {
    const { role, viewport, results } = JSON.parse(fs.readFileSync(path.join(workspace, file), "utf8"))
    for (const result of results.filter((r) => r.status === "errors")) console.log(`${role} ${viewport} ${result.url ?? result.route}: ${result.findings[0].replace(/\s+/g, " ").slice(0, 200)}`)
  }
}
