import { test } from "@playwright/test"
import { readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { journey, signIn, workspace } from "./support"

// B15.3: every page of the signed-in app is opened as a builder's owner, and
// what the browser saw is recorded per page: uncaught exceptions, console
// errors (hydration mismatches included), server responses of 500 or more, and
// a crash screen. Project pages use the seeded job; pages that need a record the
// seed does not create are listed as skipped, never silently passed.
const root = join(__dirname, "../../../app/(app)")
const DEVELOPMENT_ONLY = /Failed to execute 'measure' on 'Performance'|Download the React DevTools|\[Fast Refresh\]|\[HMR\]/
// Pages an organization's owner is meant to be turned away from: Arc's own staff
// consoles, and Arc Trade before the company enables it. Anywhere else a refusal
// is an error (that is how a missing owner permission shows up).
const REFUSED_BY_DESIGN: Array<[RegExp, RegExp]> = [
  [/^\/admin(\/|$)/, /Missing permission: platform\.|Only Arc platform owners/],
  [/^\/trade(\/|$)/, /Enable Arc Trade in Company setup first/],
]

function pages(directory: string, prefix = ""): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (!statSync(path).isDirectory()) return name === "page.tsx" ? [prefix || "/"] : []
    return pages(path, /^\(.*\)$/.test(name) ? prefix : `${prefix}/${name}`)
  })
}

test("app sweep: every page loads without browser errors", async ({ page }, info) => {
  test.setTimeout(90 * 60 * 1000)
  const users = journey("app-sweep")
  const projectId = users.periods.project
  const july = users.periods["2026-07"]
  await signIn(page, users.owner, users.password)
  const { vendor, bank, contact } = users.periods
  const resolve = (route: string) => route
    .replace(/^\/projects\/\[id\]\/reports\/\[slug\]/, `/projects/${projectId}/reports/job-cost-detail`)
    .replace(/^\/projects\/\[id\]/, `/projects/${projectId}`)
    .replace(/^\/books\/close\/\[periodId\]/, `/books/close/${july}`)
    .replace(/^\/books\/banking\/\[accountId\]/, `/books/banking/${bank}`)
    .replace(/^\/(directory|companies)\/\[id\]/, `/$1/${vendor}`)
    .replace(/^\/contacts\/\[id\]/, `/contacts/${contact}`)
    .replace(/^\/reports\/\[slug\]/, "/reports/books-trial-balance")
    .replace(/^\/settings\/imports\/\[importer\]/, "/settings/imports/cost_codes")
  const results: Array<{ route: string; url?: string; status: "clean" | "errors" | "skipped" | "refused"; findings: string[] }> = []
  // APP_SWEEP_ONLY=route,route re-checks named pages while fixing them.
  const only = process.env.APP_SWEEP_ONLY?.split(",")
  for (const route of [...new Set(pages(root))].sort().filter((route) => !only || only.includes(route))) {
    const url = resolve(route)
    if (url.includes("[")) { results.push({ route, status: "skipped", findings: ["needs a record the sweep does not seed"] }); continue }
    const findings: string[] = []
    const onError = (error: Error) => { if (!DEVELOPMENT_ONLY.test(error.message)) findings.push(`exception: ${error.message.slice(0, 300)}`) }
    const onConsole = (message: { type(): string; text(): string }) => {
      if (message.type() === "error" && !DEVELOPMENT_ONLY.test(message.text())) findings.push(`console: ${message.text().slice(0, 300)}`)
    }
    const onResponse = (response: { status(): number; url(): string }) => {
      if (response.status() >= 500 && response.url().startsWith("http://localhost:3210")) findings.push(`server ${response.status()}: ${response.url().replace("http://localhost:3210", "").slice(0, 200)}`)
    }
    page.on("pageerror", onError); page.on("console", onConsole); page.on("response", onResponse)
    try {
      await page.goto(url, { waitUntil: "load", timeout: 180_000 })
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined)
      const crash = await page.getByText(/Application error|Something went wrong|This page couldn.t load|Unhandled Runtime Error/i).first().isVisible().catch(() => false)
      if (crash) findings.push("crash screen")
    } catch (error) {
      findings.push(`navigation: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`)
    } finally {
      page.off("pageerror", onError); page.off("console", onConsole); page.off("response", onResponse)
    }
    const refusal = REFUSED_BY_DESIGN.find(([pattern]) => pattern.test(route))
    const status = !findings.length ? "clean" : refusal && findings.every((finding) => refusal[1].test(finding)) ? "refused" : "errors"
    results.push({ route, url, status, findings: [...new Set(findings)] })
  }
  writeFileSync(info.outputPath("app-sweep.json"), JSON.stringify(results, null, 2))
  writeFileSync(join(workspace, only ? "app-sweep-only.json" : "app-sweep.json"), JSON.stringify(results, null, 2))
  const failing = results.filter((result) => result.status === "errors")
  if (failing.length) throw new Error(`${failing.length} pages with browser errors:\n${failing.map((result) => `${result.route}: ${result.findings[0]}`).join("\n")}`)
})
