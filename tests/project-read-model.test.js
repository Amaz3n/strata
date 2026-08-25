const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "..")

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8")
}

const OVERVIEW_PAGE = "app/(app)/projects/[id]/page.tsx"
const READ_MODEL = "lib/services/project-overview.ts"

test("the project overview streams identity, health and operations as separate bands", () => {
  const page = source(OVERVIEW_PAGE)

  // Four boundaries: the outer one that owns identity, plus one per band. A
  // single boundary means the slowest read on the page gates the project name.
  assert.equal((page.match(/<Suspense/g) ?? []).length, 4)
  for (const band of ["StatsBand", "AttentionBand", "WeekBand"]) {
    assert.match(page, new RegExp(`<${band}\\b`), band)
  }

  // Every band owns an error state, so a financial timeout degrades one section
  // instead of replacing the whole workbench with the route error page.
  assert.equal((page.match(/<SectionErrorBoundary/g) ?? []).length, 3)

  // The week band reads operations only — it must not be coupled to financials.
  const weekBand = page.slice(page.indexOf("async function WeekBand"))
  assert.doesNotMatch(weekBand.slice(0, 400), /getProjectOverviewFinancials/)
})

test("nothing on the overview render path loads an org-wide catalog", () => {
  const page = source(OVERVIEW_PAGE)
  for (const catalog of [
    "getClientContactsAction",
    "getOrgCompaniesAction",
    "getProjectTeamAction",
    "getProjectVendorsAction",
  ]) {
    assert.doesNotMatch(page, new RegExp(catalog), catalog)
  }

  // They load when a sheet is opened, and are warmed on pointer intent.
  const header = source("components/projects/overview/project-overview-actions.tsx")
  assert.match(header, /getProjectOverviewCatalogsAction/)
  assert.match(header, /onPointerEnter=\{\(\) => void warmCatalogs\(\)\}/)
})

test("the overview reconstructs the project budget at most once", () => {
  const readModel = source(READ_MODEL)

  // getProjectPocPosition rebuilds the entire budget through the service client.
  // The overview called it for `billedCents` alone — a number the invoice sum in
  // this same loader already produces.
  const imports = readModel.slice(0, readModel.indexOf("// ====="))
  assert.doesNotMatch(imports, /from "@\/lib\/services\/poc"/)
  assert.equal((readModel.match(/getBudgetWithActuals\(/g) ?? []).length, 1)
})

test("the authorized POC position reads through the request-cached reconstruction", () => {
  const poc = source("lib/services/poc.ts")
  const authorized = poc.slice(poc.indexOf("export async function getProjectPocPosition"))
  assert.match(authorized, /getBudgetWithActuals\(projectId, context\.orgId\)/)
  assert.doesNotMatch(authorized, /getBudgetWithActualsForService/)
})

test("the read model has no section the overview does not render", () => {
  const readModel = source(READ_MODEL)
  for (const dead of ["recentFiles", "recentActivity", "proposals", "closeoutCounts", "warrantyCounts"]) {
    assert.doesNotMatch(readModel, new RegExp(dead), dead)
  }
})

test("every list the operations band returns is explicitly capped", () => {
  const readModel = source(READ_MODEL)
  const selects = readModel.match(/\.select\([^)]*\)[\s\S]*?(?=\n {4}supabase|\n {2}\])/g) ?? []
  assert.ok(selects.length > 0)

  // Bounded rows, and the UI is told when the cap actually bit.
  assert.match(readModel, /attentionTruncated/)
  assert.match(readModel, /comingUpTruncated/)
  const blockers = source("components/projects/overview/project-overview-blockers.tsx")
  assert.match(blockers, /truncated &&/)
  const week = source("components/projects/overview/project-overview-week.tsx")
  assert.match(week, /truncated &&/)
})

test("a failed overview query becomes a band error, never a healthy zero", () => {
  const readModel = source(READ_MODEL)
  assert.match(readModel, /function fail\(/)
  assert.match(readModel, /throw new Error\(`Failed to load \$\{what\}/)
  // No swallow-and-return-empty anywhere in the read model.
  assert.doesNotMatch(readModel, /catch\s*\([\s\S]{0,40}\)\s*\{\s*return (\[\]|0|null)/)
})

test("the sidebar project list is server-rendered, not fetched after hydration", () => {
  const chrome = source("lib/services/app-chrome.ts")
  const switcher = source("components/layout/sidebar-project-switcher.tsx")

  // The list arrives with the chrome, so it is in the App Shell rather than a
  // round trip that cannot start until hydration finishes.
  assert.match(chrome, /listProjectNavigationItemsWithClient/)
  assert.match(switcher, /projects: ProjectNavigationItem\[\]/)
  assert.doesNotMatch(switcher, /useSidebarProjects|await fetch\(/)
  assert.equal(fs.existsSync(path.join(root, "components/layout/use-sidebar-projects.ts")), false)

  // The route survives for on-demand callers, and still reports real failures.
  const route = source("app/api/projects/route.ts")
  const failure = route.slice(route.indexOf("} catch"))
  assert.doesNotMatch(failure, /projects: \[\]/)
  assert.match(failure, /status: 500/)
})

test("the authenticated chrome is one private cache entry with a shell-eligible lifetime", () => {
  const chrome = source("lib/services/app-chrome.ts")
  const auth = source("lib/auth/context.ts")
  const config = source("next.config.mjs")

  assert.match(chrome, /"use cache: private"/)
  assert.match(chrome, /cacheLife\("session"\)/)
  assert.match(auth, /cacheLife\("session"\)/)

  // Content reaches a route's App Shell only when `stale` clears 5 minutes, and
  // is dropped from prerenders entirely when `expire` is under 5 minutes. The
  // `seconds` preset (expire: 1 minute) failed both, which kept every read
  // downstream of the session out of the shell.
  assert.doesNotMatch(auth, /cacheLife\("seconds"\)/)
  const profile = config.slice(config.indexOf("session: {"))
  assert.match(profile.slice(0, 200), /stale:\s*600/)
  assert.match(profile.slice(0, 200), /expire:\s*3600/)
})

test("the private chrome cache never reaches a request API it may not call", () => {
  const chrome = source("lib/services/app-chrome.ts")
  const entry = chrome.slice(
    chrome.indexOf("export async function getAppChromeContext"),
    chrome.indexOf("async function loadAppChromeContext"),
  )

  // `connection()` is the one request API a private cache is forbidden from
  // calling. It belongs in this uncached entry point, before auth recovery and
  // before the private chrome cache opens; shared auth helpers cannot own it.
  assert.ok(
    entry.indexOf("await connection()") <
      entry.indexOf("const { user } = await getAuthContext()"),
  )
  assert.match(entry, /getAuthContext\(\)/)
  assert.match(entry, /if \(!user\) return SIGNED_OUT_CHROME/)
  assert.doesNotMatch(entry, /"use cache: private"/)

  const auth = source("lib/auth/context.ts")
  const authEntry = auth.slice(
    auth.indexOf("export const getAuthContext"),
    auth.indexOf("export async function requireAuth"),
  )
  assert.doesNotMatch(authEntry, /^\s*await connection\(\)/m)
})

test("an instant opt-out is a redirect, never a page that gave up", () => {
  // `instant = false` says "this segment is allowed to block". That is honest for
  // a redirect, which is not a destination and can never render. On a real page
  // it hides a blocking read instead of fixing it.
  const appRoot = path.join(root, "app", "(app)")
  const optedOut = []
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.name === "page.tsx" || entry.name === "layout.tsx") {
        const contents = fs.readFileSync(absolute, "utf8")
        if (/export const instant = false/.test(contents)) optedOut.push([absolute, contents])
      }
    }
  }
  walk(appRoot)

  assert.ok(optedOut.length > 0)
  for (const [absolute, contents] of optedOut) {
    assert.match(contents, /\bredirect\(/, path.relative(root, absolute))
  }
})

test("every write that moves the cached chrome clears the client cache", () => {
  // A private cache lives in browser memory and is only dropped when a Server
  // Action calls a revalidation function. A cookie write on its own is invisible
  // to it, so org switch, desk scope and sign-out each have to say so.
  for (const [file, needle] of [
    ["app/actions/orgs.ts", /refresh\(\)/],
    ["app/(app)/desk-context-actions.ts", /refresh\(\)/],
    ["app/(auth)/auth/actions.ts", /refresh\(\)/],
  ]) {
    const contents = source(file)
    assert.match(contents, /from "next\/cache"/, file)
    assert.match(contents, needle, file)
  }
})

test("the project switcher runtime-prefetches its destination on intent", () => {
  const switcher = source("components/layout/sidebar-project-switcher.tsx")

  // A real Link, because only `<Link prefetch>` resolves the destination's URL
  // data ahead of the click. `router.prefetch` warms the shared App Shell, which
  // for a params-only route like /projects/[id] holds nothing about the project.
  assert.match(switcher, /<OptimisticLink/)
  assert.match(switcher, /prefetch=\{warmed\.has\(project\.id\)\}/)
  assert.match(switcher, /onPointerEnter=\{\(\) => handleIntent\(project\.id\)\}/)
  assert.match(switcher, /onFocus=\{\(\) => handleIntent\(project\.id\)\}/)

  // And the one read that prefetch can actually resolve early is cached.
  const projects = source("lib/services/projects.ts")
  const identity = projects.slice(projects.indexOf("export async function getProjectIdentity"))
  assert.match(identity.slice(0, 400), /"use cache: private"/)
  assert.match(identity.slice(0, 400), /cacheLife\("session"\)/)
})

test("the org-wide schedule scan is paged and scopable", () => {
  const schedule = source("lib/services/schedule.ts")
  assert.match(schedule, /SCHEDULE_SUMMARY_PAGE_SIZE/)
  assert.match(schedule, /SCHEDULE_SUMMARY_MAX_PAGES/)
  assert.match(schedule, /if \(projectIds\) query = query\.in\("project_id", projectIds\)/)

  const index = source("app/(app)/projects/page.tsx")
  assert.match(index, /listProjectScheduleSummariesAction\(projects\.map/)
})

test("the latency budgets the bands are measured against live next to the spans", () => {
  const spans = source("lib/observability/spans.ts")
  for (const span of ["project.identity", "project.operations", "project.financials"]) {
    assert.match(spans, new RegExp(`"${span.replace(".", "\\.")}"`), span)
  }
  assert.match(spans, /perf\.span\.over_budget/)

  const page = source(OVERVIEW_PAGE)
  assert.match(page, /withSpan\("project\.identity"/)
  const readModel = source(READ_MODEL)
  assert.match(readModel, /withSpan\("project\.operations"/)
  assert.match(readModel, /withSpan\("project\.financials"/)
})
