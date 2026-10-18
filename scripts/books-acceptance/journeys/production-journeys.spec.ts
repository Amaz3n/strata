import { expect, test, type Locator, type Page } from "@playwright/test"
import { instant } from "@next/playwright"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { applyTheme, journey, rows, setupSql, signIn, watchErrors, workspace } from "./support"
import { axeAudit, keyboardWalk, type AxeFinding } from "./a11y"

// EP14-07: the production builder's four desk journeys, desktop only, in light and dark
// (playwright.production.config.ts runs this file as journeys-light and journeys-dark).
// Each journey goes through its loading, empty and error states and its real path, and
// every screen it stops on passes axe-core (WCAG 2.1 A/AA, serious and critical) and a
// keyboard walk. Findings are written to W/production-journeys-<journey>-<project>.json.
//
//   sales       desk → no-match search → deal → purchase agreement (blocked until a plan is on the lot)
//   starts      desk loading → desk → ready package: release controls reachable by keyboard
//   purchasing  desk loading → home budget → Foundation → approve a draft PO (first save fails)
//   warranty    desk → empty verify queue → WR-1 → schedule a service visit (first save fails)
//
// The release itself is not repeated here: it is one-way, and RELEASE-01 proves it.

// Token-level contrast findings, reported in the EP14 handback and not fixed here: each needs
// a fill-versus-text token split in app/globals.css, a design decision of its own. Every entry
// names the screens it appears on, the element it is, and the exact colour pair axe measured,
// so the same defect anywhere else, or any other defect on these screens, still fails.
const on = (fg: string, bg: string) => `foreground color: ${fg}, background color: ${bg}`
const KNOWN_OPEN: Array<{ screens: RegExp; has: string[]; why: string }> = [
  // Dark --primary (0.58): white on it is 4.32:1, and it reads 4.16:1 as text on its own tint.
  { screens: /^(purchasing desk|foundation bucket.*|edit commitment.*|sales desk.*|deal|purchase agreement|starts desk.*|ready start package|warranty request)$/, has: ['data-slot="button"', "bg-primary text-primary-foreground", on("#fcfcfc", "#3a70ee")], why: "dark: the default (primary) Button, white on --primary 4.32:1" },
  { screens: /^foundation bucket|^edit commitment/, has: ['data-slot="dialog-trigger"', on("#fcfcfc", "#3a70ee")], why: "dark: the financial setup banner's Set up button, white on --primary 4.32:1" },
  { screens: /^foundation bucket|^edit commitment/, has: ['data-slot="dropdown-menu-trigge', on("#fcfcfc", "#3a70ee")], why: "dark: the budget's primary menu button, white on --primary 4.32:1" },
  { screens: /^ready start package$/, has: ['data-slot="badge"', "bg-primary/10 text-primary", on("#3a70ee", "#0b1327")], why: "dark: the package's primary badge, --primary text on its tint 4.16:1" },
  // Dark --destructive (0.50) as text: 2.4-3.0:1.
  { screens: /^foundation bucket|^edit commitment/, has: ['<span class="flex flex-wrap items-center gap-2">', on("#bb061e", "#0d121b")], why: "dark: the destructive financial setup Alert title" },
  { screens: /^foundation bucket|^edit commitment/, has: ["<p>An active billing contract is required", on("#a9081e", "#0d121b")], why: "dark: the destructive financial setup Alert text" },
  { screens: /^foundation bucket|^edit commitment/, has: ["<p>Fixed-price projects need a contract value", on("#a9081e", "#0d121b")], why: "dark: the destructive financial setup Alert text" },
  { screens: /^purchase agreement$/, has: ["Cannot write an agreement yet", on("#bb061e", "#0f0912")], why: "dark: the agreement blocker heading in --destructive" },
  // Light --warning as text: 3.0-3.2:1.
  { screens: /^(deal|purchase agreement)$/, has: [">Not sent</span>", on("#d37812", "#f7f8fb")], why: "light: the deal's 'Not sent' state in --warning" },
  { screens: /^(starts desk|starts desk, at risk \(empty\)|ready start package)$/, has: ['targeted against a target of', on("#d37812", "#ffffff")], why: "light: the release-slot shortfall in --warning" },
  // Light state-tint badges on the sales desk: --warning and --chart-2 text on their own tints.
  { screens: /^sales desk$/, has: ['data-slot="badge"', on("#d37812", "#f3ebe4")], why: "light: a warning-tint stage badge, 2.75:1" },
  { screens: /^sales desk$/, has: ['data-slot="badge"', on("#00939a", "#deeef1")], why: "light: a chart-tint stage badge, 3.12:1" },
]

type Report = Record<string, { axe: AxeFinding[]; keyboard: string[] }>

function open(screen: string, findings: AxeFinding[]) {
  return findings.filter((finding) => !(finding.rule === "color-contrast" && KNOWN_OPEN.some((known) =>
    known.screens.test(screen) && known.has.every((part) => finding.summary.includes(part)))))
}

/** axe and a keyboard walk on the screen as it stands; unknown findings fail the journey. */
async function accessible(page: Page, report: Report, screen: string, { walk = true, scope }: { walk?: boolean; scope?: Locator } = {}) {
  const axe = await axeAudit(page)
  const keyboard = walk ? (await keyboardWalk(page, 40)).problems : []
  report[screen] = { axe, keyboard }
  expect.soft(open(screen, axe).map((finding) => `${finding.rule}: ${finding.summary}`), `axe on ${screen}`).toEqual([])
  expect.soft(keyboard, `keyboard on ${screen}`).toEqual([])
  if (scope) await expect(scope).toBeVisible()
}

/** Tabs inside an open dialog until `target` has focus (focus must stay in the dialog). */
async function tabInDialog(page: Page, dialog: Locator, target: Locator, limit = 40) {
  for (let presses = 1; presses <= limit; presses++) {
    await page.keyboard.press("Tab")
    expect(await dialog.evaluate((element) => element.contains(document.activeElement)), "focus stays in the dialog").toBe(true)
    if (await target.evaluate((element) => element === document.activeElement)) return presses
  }
  throw new Error(`could not reach ${target} by keyboard`)
}

// Each journey's findings, written whether it passes or fails.
const reports = new Map<string, Report>()
function reportFor(name: string) {
  const report: Report = {}
  reports.set(name, report)
  return report
}
test.afterEach(async ({}, info) => {
  for (const [name, report] of reports) writeFileSync(join(workspace, `production-journeys-${name}-${info.project.name}.json`), JSON.stringify(report, null, 2))
  reports.clear()
})

const users = () => journey("production")


test("sales: desk, empty search, deal, purchase agreement", async ({ page }, info) => {
  test.setTimeout(10 * 60 * 1000)
  await applyTheme(page, info.project.name)
  const noErrors = watchErrors(page)
  const report = reportFor("sales")
  const u = users()
  await signIn(page, u.team?.sales ?? "", u.password)

  // Loading: with the deals held back (Next's instant-navigation lock), the desk shows
  // the board's skeleton, not a blank page; the board replaces it when they land.
  await page.goto("/my-work")
  await page.waitForLoadState("networkidle")
  await instant(page, async () => {
    await page.getByRole("link", { name: "Sales", exact: true }).first().click()
    await expect(page.getByRole("status", { name: "Loading sales" })).toBeVisible()
  })
  const search = page.getByRole("textbox", { name: "Search deals" })
  await expect(search).toBeVisible()
  await expect(page.getByRole("status", { name: "Loading sales" })).toHaveCount(0)
  await accessible(page, report, "sales desk")

  // Empty: a search that matches nothing says so and offers the way back.
  await search.fill("zzqx no such buyer")
  await expect(page.getByText("Nothing matches")).toBeVisible()
  await accessible(page, report, "sales desk, no match", { walk: false })
  await page.getByRole("button", { name: "Clear filters" }).click()
  await expect(page.getByText("Priya Nair").first()).toBeVisible()

  // The deal: one next move, and the agreement composer opens over it.
  await page.getByText("Priya Nair").first().click()
  await expect(page.getByRole("heading", { level: 1, name: "Priya Nair" })).toBeVisible()
  await accessible(page, report, "deal")
  const write = page.getByRole("button", { name: "Write the purchase agreement" })
  await write.focus()
  await page.keyboard.press("Enter")
  const agreement = page.getByRole("dialog", { name: "Purchase agreement" })
  await expect(agreement).toBeVisible()
  // The lot has no plan yet: the agreement refuses to be written and says why.
  await expect(agreement.getByText("Cannot write an agreement yet")).toBeVisible()
  await expect(agreement.getByText("Assign a plan to the lot before writing the agreement")).toBeVisible()
  await expect(agreement.getByRole("button", { name: "Write & send for signature" })).toBeDisabled()
  await accessible(page, report, "purchase agreement", { walk: false })
  await tabInDialog(page, agreement, agreement.getByRole("button", { name: "Cancel" }))
  await page.keyboard.press("Escape")
  await expect(agreement).toBeHidden()
  await expect(write, "focus returns to the button that opened the agreement").toBeFocused()

  // Error: a deal that does not exist is a clean not-found, inside the app chrome.
  await page.goto("/sales/r:00000000-0000-4000-8000-000000000000")
  await expect(page.getByRole("heading", { name: "This page could not be found." })).toBeVisible()
  await expect(page.getByRole("link", { name: "Sales" }).first()).toBeVisible()

  noErrors()
})

test("starts: loading, desk, ready package by keyboard", async ({ page }, info) => {
  test.setTimeout(10 * 60 * 1000)
  await applyTheme(page, info.project.name)
  const noErrors = watchErrors(page)
  const report = reportFor("starts")
  const u = users()
  await signIn(page, u.team?.starts ?? "", u.password)

  // Loading: with the desk's data held back (Next's instant-navigation lock), the Starts skeleton stands in.
  await page.goto("/my-work")
  await page.waitForLoadState("networkidle")
  await instant(page, async () => {
    await page.getByRole("link", { name: "Starts", exact: true }).first().click()
    await expect(page.getByRole("status", { name: "Loading starts" })).toBeVisible()
  })
  await expect(page.getByRole("button", { name: /ready to release/ })).toBeVisible()
  await accessible(page, report, "starts desk")

  // Empty: the at-risk filter on a healthy pipeline.
  await page.getByRole("button", { name: /^0 at risk$/ }).click()
  await accessible(page, report, "starts desk, at risk (empty)", { walk: false })

  // The ready package: every release control is reachable from the keyboard, inside the sheet.
  await page.goto(`/starts?package=${u.periods.startPackage}`)
  const sheet = page.getByRole("dialog", { name: /Cypress Landing · 3/ })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText("Every gate is clear")).toBeVisible()
  await accessible(page, report, "ready start package", { walk: false })
  for (const control of [sheet.getByRole("button", { name: "Release start" }), sheet.getByRole("combobox", { name: "Target week" }), sheet.getByRole("combobox", { name: "Superintendent" })]) {
    await tabInDialog(page, sheet, control)
  }
  await page.keyboard.press("Escape")
  await expect(sheet).toBeHidden()

  // Error: a package that does not exist returns to the desk without a sheet.
  await page.goto("/starts/00000000-0000-4000-8000-000000000000")
  await expect(page).toHaveURL(/\/starts$/)
  await expect(page.getByRole("dialog")).toHaveCount(0)

  noErrors()
})

test("purchasing: loading, budget bucket, approve a draft purchase order", async ({ page }, info) => {
  test.setTimeout(10 * 60 * 1000)
  await applyTheme(page, info.project.name)
  const noErrors = watchErrors(page)
  const report = reportFor("purchasing")
  const u = users()
  // A draft order the owner wrote, which the purchasing manager may approve, and one they
  // wrote themselves, which they may not (separation of duties is the error state).
  const title = `Journey PO ${info.project.name} — foundation extras`
  const ownTitle = `Journey PO ${info.project.name} — own order`
  const owner = rows<{ id: string }>(`select id from auth.users where email = '${u.owner}'`)[0].id
  // The home's Foundation budget line: a bucket lists the orders allocated to its line.
  const foundation = rows<{ costCode: string; line: string }>(`
    select bl.cost_code_id "costCode", bl.id line from budget_lines bl join budgets b on b.id = bl.budget_id join cost_codes cc on cc.id = bl.cost_code_id
    where b.org_id = '${u.orgId}' and b.project_id = '${u.periods.specHome}' and cc.code = '03-300' limit 1`)[0]
  const purchaser = rows<{ id: string }>(`select id from auth.users where email = '${u.team?.purchasing}'`)[0].id
  // The purchasing manager is on no team for this home: purchasing works every home in its
  // divisions from org-level commitment.read (20261021210000). Earlier runs of this journey
  // seated them as a workaround; that seat is taken away so the run proves the read.
  // The vendor, Gulf Concrete, has no prequalification, so approval asks for an override.
  setupSql(`
    delete from project_members where org_id = '${u.orgId}' and project_id = '${u.periods.specHome}' and user_id = '${purchaser}';
    delete from commitment_lines where commitment_id in (select id from commitments where org_id = '${u.orgId}' and title in ('${title}', '${ownTitle}'));
    delete from commitments where org_id = '${u.orgId}' and title in ('${title}', '${ownTitle}');
    with po as (
      insert into commitments (org_id, project_id, company_id, commitment_type, title, status, total_cents, metadata)
      values ('${u.orgId}', '${u.periods.specHome}', '${u.periods.vendor}', 'purchase_order', '${title}', 'draft', 125000, jsonb_build_object('created_by_user_id', '${owner}')),
             ('${u.orgId}', '${u.periods.specHome}', '${u.periods.vendor}', 'purchase_order', '${ownTitle}', 'draft', 40000, jsonb_build_object('created_by_user_id', '${purchaser}'))
      returning id, total_cents
    )
    insert into commitment_lines (org_id, commitment_id, cost_code_id, budget_line_id, description, unit_cost_cents, quantity)
    select '${u.orgId}', po.id, '${foundation.costCode}', '${foundation.line}', 'Foundation extras', po.total_cents, 1 from po;`)
  await signIn(page, u.team?.purchasing ?? "", u.password)

  // Loading: with the desk's data held back, the Purchasing skeleton stands in.
  await page.goto("/my-work")
  await page.waitForLoadState("networkidle")
  await instant(page, async () => {
    await page.getByRole("link", { name: "Purchasing", exact: true }).first().click()
    await expect(page.getByRole("status", { name: "Loading purchasing" })).toBeVisible()
  })
  await expect(page.getByRole("heading", { name: "Vendor price agreements" })).toBeVisible()
  await accessible(page, report, "purchasing desk")

  // The home's budget: the Foundation bucket lists the draft.
  await page.goto(`/projects/${u.periods.specHome}/budget`)
  await page.getByRole("button", { name: "Open Foundation" }).click()
  const bucket = page.getByRole("dialog", { name: "Foundation" })
  await expect(bucket.getByText(title)).toBeVisible()
  await accessible(page, report, "foundation bucket", { walk: false })

  // Empty: no subcontracts on this cost code.
  await bucket.getByRole("combobox", { name: "Commitment type" }).click()
  await page.getByRole("option", { name: /Subcontract/ }).click()
  await expect(bucket.getByText(title)).toBeHidden()
  await accessible(page, report, "foundation bucket, subcontracts (empty)", { walk: false })
  await bucket.getByRole("combobox", { name: "Commitment type" }).click()
  await page.getByRole("option", { name: "All commitments" }).click()

  const status = (name: string) => rows<{ status: string }>(`select status from commitments where org_id = '${u.orgId}' and title = '${name}'`)[0].status
  const editDialog = page.getByRole("dialog", { name: /Edit commitment/ })
  const approve = async (name: string) => {
    await editDialog.getByRole("combobox", { name: "Status" }).click()
    await page.getByRole("option", { name: "Approved" }).click()
    await editDialog.getByRole("button", { name: /^Save/ }).click()
  }

  const notifications = page.getByRole("region", { name: /Notifications/ })

  // Error: approving an order you wrote yourself is refused, and says so. The dialog keeps
  // the edit and the order stays a draft.
  await bucket.getByRole("button", { name: `Actions for ${ownTitle}` }).click()
  await page.getByRole("menuitem", { name: "Edit commitment" }).click()
  await expect(editDialog).toBeVisible()
  await approve(ownTitle)
  await expect(notifications.getByText(/someone else has to approve it/)).toBeVisible()
  await expect(editDialog).toBeVisible()
  expect(status(ownTitle), "the creator's own approval is refused").toBe("draft")
  await page.keyboard.press("Escape")
  await expect(editDialog).toBeHidden()

  // Approve the owner's order through the edit dialog, opened from the row's actions by keyboard.
  const actions = bucket.getByRole("button", { name: `Actions for ${title}` })
  await tabInDialog(page, bucket, actions, 80)
  await expect(actions, "the row's actions show when focused").toHaveCSS("opacity", "1")
  await page.keyboard.press("Enter")
  await page.getByRole("menuitem", { name: "Edit commitment" }).click()
  await expect(editDialog).toBeVisible()
  await accessible(page, report, "edit commitment", { walk: false })
  // The vendor has no prequalification: the first save asks why, the order stays a draft.
  await approve(title)
  await expect(notifications.getByText("This trade's prequalification needs an override")).toBeVisible()
  const why = editDialog.getByRole("textbox", { name: "Why you're proceeding despite prequalification" })
  await expect(why).toBeFocused()
  expect(status(title), "approval without a justification is refused").toBe("draft")
  await accessible(page, report, "edit commitment, prequalification override", { walk: false })
  await why.fill("Journey: the owner cleared this trade on site; prequalification paperwork to follow.")
  await editDialog.getByRole("button", { name: /^Save/ }).click()
  await expect(editDialog).toBeHidden()
  await expect.poll(() => status(title)).toBe("approved")
  const note = rows<{ note: string }>(`select metadata->>'prequal_override_note' note from commitments where org_id = '${u.orgId}' and title = '${title}'`)[0].note
  expect(note, "the justification is kept on the order").toMatch(/cleared this trade on site/)

  noErrors()
})

test("warranty: desk, empty verify queue, schedule a service visit", async ({ page }, info) => {
  test.setTimeout(10 * 60 * 1000)
  await applyTheme(page, info.project.name)
  const noErrors = watchErrors(page)
  const report = reportFor("warranty")
  const u = users()
  await signIn(page, u.team?.warranty ?? "", u.password)

  // Loading: with the desk's data held back, the warranty skeleton stands in.
  await page.goto("/my-work")
  await page.waitForLoadState("networkidle")
  await instant(page, async () => {
    await page.getByRole("link", { name: "Warranty", exact: true }).first().click()
    await expect(page.getByRole("status", { name: "Loading warranty" })).toBeVisible()
  })
  await expect(page.getByRole("tab", { name: "Queue" })).toBeVisible()
  await accessible(page, report, "warranty queue")

  // Empty: nothing waits for verification.
  await page.getByRole("tab", { name: "Verify" }).click()
  await expect(page.getByText("No visits awaiting verification on this page.")).toBeVisible()
  await accessible(page, report, "warranty verify (empty)", { walk: false })

  // WR-1: schedule a visit in a window no earlier run used (one minute per run, a year out).
  await page.getByRole("tab", { name: "Queue" }).click()
  const wr1 = page.getByRole("button", { name: "WR-1" })
  await wr1.click()
  const sheet = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Schedule visit" }) })
  await expect(sheet).toBeVisible()
  await accessible(page, report, "warranty request", { walk: false })
  // Each run takes its own three-hour slot, so the trade is never double-booked by an earlier run's two-hour visit.
  const start = new Date(Date.UTC(2028, 0, 1, 12) + (Math.floor(Date.now() / 1000) % 200000) * 3 * 3600 * 1000)
  const local = (date: Date) => date.toISOString().slice(0, 16)
  // The org has no warranty technicians yet, so the visit goes to a trade.
  await sheet.getByRole("combobox", { name: "Who makes the visit" }).click()
  await page.getByRole("option", { name: "Trade" }).click()
  await sheet.getByRole("textbox", { name: "Trade", exact: true }).fill("Gulf")
  // The visit's trade list, which sits above the backcharge's own trade list, has found it.
  await expect(sheet.getByRole("button", { name: "Gulf Concrete" }).first()).toBeVisible()
  await sheet.getByRole("button", { name: "Gulf Concrete" }).first().click()
  const end = new Date(start.getTime() + 2 * 3600 * 1000)
  const visits = () => rows<{ n: number }>(`select count(*)::int n from warranty_service_visits where org_id = '${u.orgId}' and request_id = '${u.periods.warrantyRequest}'`)[0].n
  const before = visits()

  // Error: a window that ends before it starts is refused, says why, and schedules nothing.
  await sheet.getByRole("textbox", { name: /Window start/ }).fill(local(end))
  await sheet.getByRole("textbox", { name: /Window end/ }).fill(local(start))
  await sheet.getByRole("button", { name: "Schedule visit" }).click()
  await expect(page.getByRole("region", { name: /Notifications/ }).getByText(/window|before|after|end/i).first()
    .or(sheet.getByRole("alert").first())).toBeVisible()
  expect(visits(), "a refused window schedules nothing").toBe(before)

  await sheet.getByRole("textbox", { name: /Window start/ }).fill(local(start))
  await sheet.getByRole("textbox", { name: /Window end/ }).fill(local(end))
  await sheet.getByRole("button", { name: "Schedule visit" }).click()
  await expect.poll(visits).toBe(before + 1)

  // Error: an unknown request leaves the desk as it was, with no sheet.
  await page.goto("/warranty?request=00000000-0000-4000-8000-000000000000")
  await expect(page.getByRole("tab", { name: "Queue" })).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)

  noErrors()
})
