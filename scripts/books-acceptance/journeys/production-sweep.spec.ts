import { test } from "@playwright/test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { journey, signIn, workspace } from "./support"
import { accounting, pages, sweepPages, type SweepResult } from "./sweep"

// EP14-07: the production builder's pages, opened as each production role at
// desktop width (mobile web is out of scope; field use is the iOS app). The owner opens every page under app/(app); each other role
// opens the pages a production builder's day touches. A person's own desk must open
// clean; elsewhere an authorization refusal is allowed (that is the role's permission
// boundary), a crash, a console error or a 5xx never is. The report goes to
// W/production-sweep-<role>-<viewport>.json and the counts are printed.
//
// PRODUCTION_SWEEP_ROLES=owner,sales   limits the roles;  APP_SWEEP_ONLY=/route,/route re-runs named pages.

// Arc's own staff consoles turn an organization's owner away, by a thrown permission or a redirect to /unauthorized.
const STAFF_REFUSAL = /Missing permission: platform\.|Only Arc platform owners|redirected to \/unauthorized/
const ADMIN_AND_TRADE: Array<[RegExp, RegExp]> = [
  [/^\/(admin|platform|emails\/preview)(\/|$)/, STAFF_REFUSAL],
  [/^\/trade(\/|$)/, /Enable Arc Trade in Company setup first/],
]

// The pages a production builder's day touches: the desks, the community, plan and
// start workbenches, and a home's workbench tabs.
const PRODUCTION_ROUTES = [
  "/", "/my-houses", "/my-work",
  "/sales", "/sales/[dealId]",
  "/communities", "/communities/[id]", "/communities/[id]/land", "/communities/[id]/offering", "/communities/[id]/settings",
  "/plans", "/plans/[id]",
  "/starts", "/starts/[id]", "/settings/starts",
  "/purchasing",
  "/design-studio", "/design-studio/catalog", "/design-studio/rules", "/design-studio/sheet/[projectId]",
  "/warranty", "/warranty/accounting", "/settings/warranty",
  "/projects", "/projects/[id]", "/projects/[id]/schedule", "/projects/[id]/budget", "/projects/[id]/selections", "/projects/[id]/commitments",
  "/projects/[id]/closing", "/projects/[id]/warranty", "/projects/[id]/daily-logs", "/projects/[id]/punch", "/projects/[id]/photos",
  "/projects/[id]/inspections", "/projects/[id]/financials", "/projects/[id]/financials/payables", "/projects/[id]/documents",
  "/reports", "/directory", "/payables", "/billing", "/schedule", "/tasks",
]

// A person's own desk, from docs/production-org-playbook.md: refused there is an error.
const OWN_DESK: Record<string, RegExp[]> = {
  owner: [],
  sales: [/^\/sales/, /^\/communities$/, /^\/communities\/\[id\](\/offering)?$/],
  land: [/^\/communities/],
  starts: [/^\/starts/, /^\/settings\/starts$/],
  purchasing: [/^\/purchasing$/],
  design: [/^\/design-studio/],
  superintendent: [/^\/my-houses$/, /^\/my-work$/],
  warranty: [/^\/warranty$/],
}
const ROLES = (process.env.PRODUCTION_SWEEP_ROLES?.split(",") ?? Object.keys(OWN_DESK))

for (const role of ROLES) {
  test(`production sweep: ${role}`, async ({ page }, info) => {
    test.setTimeout(120 * 60 * 1000)
    const users = journey("production")
    const email = role === "owner" ? users.owner : users.team?.[role]
    if (!email) throw new Error(`The production seed has no ${role} member`)
    await signIn(page, email, users.password)
    const id = users.periods
    const withProject = (route: string, projectId: string) => route.replace(/^\/projects\/\[id\]\/reports\/\[slug\]/, `/projects/${projectId}/reports/job-cost-detail`).replace(/^\/projects\/\[id\]/, `/projects/${projectId}`)
    // A home's key tabs are also opened on a released spec home and on a sold home waiting for release.
    const OTHER_HOMES = /^\/projects\/\[id\](\/(schedule|budget|selections|commitments|closing))?$/
    const resolve = (route: string): string[] => {
      if (/^\/starts\/\[id\]$/.test(route)) return [`/starts/${id.startPackage}`, `/starts/${id.releasedPackage}`]
      if (/^\/sales\/\[dealId\]$/.test(route)) return [`/sales/${id.deal}`, `/sales/${id.closedDeal}`]
      if (/^\/communities\/\[id\]/.test(route)) return [route.replace("[id]", id.community)]
      if (/^\/plans\/\[id\]$/.test(route)) return [`/plans/${id.plan}`]
      if (/^\/design-studio\/sheet\/\[projectId\]$/.test(route)) return [`/design-studio/sheet/${id.closedHome}`]
      if (/^\/projects\/\[id\]/.test(route)) return [withProject(route, id.closedHome), ...(OTHER_HOMES.test(route) ? [withProject(route, id.specHome), withProject(route, id.readyHome)] : [])]
      if (/^\/books\/close\/\[periodId\]/.test(route)) return [`/books/close/${id["2026-10"]}`]
      if (/^\/books\/banking\/\[accountId\]/.test(route)) return [`/books/banking/${id.bank}/reconcile`]
      if (/^\/(directory|companies)\/\[id\]/.test(route)) return [route.replace("[id]", id.vendor)]
      if (/^\/contacts\/\[id\]/.test(route)) return [route.replace("[id]", id.contact)]
      if (/^\/reports\/\[slug\]/.test(route)) return ["/reports/books-trial-balance"]
      if (/^\/settings\/imports\/\[importer\]/.test(route)) return ["/settings/imports/price_book"]
      return [route]
    }
    const only = process.env.APP_SWEEP_ONLY?.split(",")
    const routes = (role === "owner" ? [...new Set(pages())].sort() : PRODUCTION_ROUTES).filter((route) => !only || only.includes(route))
    const results: SweepResult[] = await sweepPages(page, info, {
      routes, resolve, refusedByDesign: role === "owner" ? ADMIN_AND_TRADE : [], ownDesk: OWN_DESK[role], anyRefusalAllowed: role !== "owner",
    })
    const viewport = info.project.name
    writeFileSync(join(workspace, `production-sweep-${role}-${viewport}${only ? "-only" : ""}.json`), JSON.stringify({ role, viewport, accounting: accounting(results), results }, null, 2))
    console.log(`production sweep ${role} (${viewport}): ${JSON.stringify(accounting(results))}`)
    const failing = results.filter((result) => result.status === "errors")
    if (failing.length) throw new Error(`${failing.length} pages with browser errors as ${role}:\n${failing.map((result) => `${result.url ?? result.route}: ${result.findings[0]}`).join("\n")}`)
  })
}
