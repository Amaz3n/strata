import { test } from "@playwright/test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { journey, signIn, workspace } from "./support"
import { accounting, pages, sweepPages } from "./sweep"

// B15.3: every page of the signed-in app is opened as a builder's owner, and
// what the browser saw is recorded per page (see sweep.ts). Project pages use the
// seeded job; pages that need a record the seed does not create are listed as
// skipped, never silently passed. The production pages are swept by
// production-sweep.spec.ts against the production seed.
// Pages an organization's owner is meant to be turned away from: Arc's own staff
// consoles, and Arc Trade before the company enables it. Anywhere else a refusal
// is an error (that is how a missing owner permission shows up).
const REFUSED_BY_DESIGN: Array<[RegExp, RegExp]> = [
  [/^\/(admin|platform)(\/|$)/, /Missing permission: platform\.|Only Arc platform owners|redirected to \/unauthorized/],
  [/^\/trade(\/|$)/, /Enable Arc Trade in Company setup first/],
]

test("app sweep: every page loads without browser errors", async ({ page }, info) => {
  test.setTimeout(90 * 60 * 1000)
  const users = journey("app-sweep")
  const projectId = users.periods.project
  const july = users.periods["2026-07"]
  await signIn(page, users.owner, users.password)
  const { vendor, bank, contact } = users.periods
  const resolve = (route: string) => [route
    .replace(/^\/projects\/\[id\]\/reports\/\[slug\]/, `/projects/${projectId}/reports/job-cost-detail`)
    .replace(/^\/projects\/\[id\]/, `/projects/${projectId}`)
    .replace(/^\/books\/close\/\[periodId\]/, `/books/close/${july}`)
    .replace(/^\/books\/banking\/\[accountId\]/, `/books/banking/${bank}`)
    .replace(/^\/(directory|companies)\/\[id\]/, `/$1/${vendor}`)
    .replace(/^\/contacts\/\[id\]/, `/contacts/${contact}`)
    .replace(/^\/reports\/\[slug\]/, "/reports/books-trial-balance")
    .replace(/^\/settings\/imports\/\[importer\]/, "/settings/imports/cost_codes")]
  // APP_SWEEP_ONLY=route,route re-checks named pages while fixing them.
  const only = process.env.APP_SWEEP_ONLY?.split(",")
  const routes = [...new Set(pages())].sort().filter((route) => !only || only.includes(route))
  const results = await sweepPages(page, info, { routes, resolve, refusedByDesign: REFUSED_BY_DESIGN })
  writeFileSync(info.outputPath("app-sweep.json"), JSON.stringify(results, null, 2))
  writeFileSync(join(workspace, only ? "app-sweep-only.json" : "app-sweep.json"), JSON.stringify(results, null, 2))
  console.log(`app sweep (${info.project.name}): ${JSON.stringify(accounting(results))}`)
  const failing = results.filter((result) => result.status === "errors")
  if (failing.length) throw new Error(`${failing.length} pages with browser errors:\n${failing.map((result) => `${result.route}: ${result.findings[0]}`).join("\n")}`)
})
