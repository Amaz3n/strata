import { expect, test } from "@playwright/test"
import { applyTheme, expectNoHorizontalOverflow, journey, signIn, watchErrors } from "./support"

// B04.1: on a job with two contracts, costs shared between their schedules and an
// invoice that names no contract are shown with their cure in the WIP review,
// and fixing them clears the way to prepare each contract.
test("contract WIP: shared costs and unassigned invoices are placed before each contract's WIP", async ({ page }, info) => {
  const users = journey("contract-wip")
  const noErrors = watchErrors(page)
  await applyTheme(page, info.project.name)
  await signIn(page, users.owner, users.password)

  await page.goto(`/books/close/${users.periods["2026-07"]}`)
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: /Run checks/ }).click()
  await page.getByText("WIP and POC reviewed through period end").filter({ visible: true }).first().click()
  await page.getByRole("button", { name: "Review period-end WIP" }).click()
  const ownership = page.getByRole("region", { name: "Contract ownership" })
  await expect(ownership.getByText("Costs and billings need a contract")).toBeVisible()
  await expect(ownership.getByText(/Costs under 01-500 do not belong to one contract/).first()).toBeVisible()
  await expect(ownership.getByText(/Invoices CW-IU do not say which contract they bill/).first()).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: info.outputPath("ownership.png"), fullPage: true })
  if (info.project.name !== "desktop") return noErrors()

  await ownership.getByLabel("Fixed-price construction contract (%)").fill("60")
  await ownership.getByLabel("Site work (%)").fill("40")
  await ownership.getByLabel("Basis for this split").fill("General conditions follow each contract's share of the schedule.")
  await ownership.getByRole("button", { name: "Record split" }).click()
  await expect(page.getByText("Cost split recorded. Prepare the affected contracts again.")).toBeVisible()
  await ownership.getByLabel(/Invoice CW-IU/).selectOption({ label: "Site work" })
  await ownership.getByRole("button", { name: "Assign" }).click()
  await expect(page.getByText("Invoice assigned to its contract.")).toBeVisible()
  await expect(page.getByRole("region", { name: "Contract ownership" })).toHaveCount(0)
  await expect(page.getByRole("option", { name: /Browser acceptance — contract WIP — custom home · Site work/ })).toHaveCount(1)
  await page.screenshot({ path: info.outputPath("ready-to-prepare.png"), fullPage: true })

  // Each contract is prepared on its own, then approved together.
  await page.getByText("Prepare or revise period-end WIP").click()
  for (const [contract, original, eac] of [["Fixed-price construction contract", "1000000", "800000"], ["Site work", "200000", "180000"]]) {
    await page.getByLabel("Project or contract").selectOption({ label: `Browser acceptance — contract WIP — custom home · ${contract}` })
    await page.getByLabel("Original contract ($)").fill(original)
    await page.getByLabel("Estimate at completion ($)").fill(eac)
    await page.getByLabel("Basis for this period").fill("Contract value and estimate per this contract's own schedule.")
    await page.getByRole("button", { name: "Prepare dated snapshot" }).click()
    await expect(page.getByText("Period-end WIP prepared. Review the updated figures before approval.").last()).toBeVisible()
  }
  // The workspace reloads after each preparation; wait for the second contract's figures.
  await expect(page.getByText("$22,222.22").first()).toBeVisible()
  await page.waitForLoadState("networkidle")
  await page.getByLabel("Review explanation").fill("Independent review of each contract's WIP position.")
  await page.getByRole("button", { name: "Approve these WIP snapshots" }).click()
  await expect(page.getByText("WIP review saved and close checklist refreshed")).toBeVisible()
  // The check now passes, so it lists under All rather than Needs attention.
  await page.getByRole("button", { name: /^All/ }).click()
  await page.getByText("WIP and POC reviewed through period end").filter({ visible: true }).first().click()
  await page.getByRole("button", { name: "Review period-end WIP" }).click()
  const approval = page.getByRole("region", { name: "WIP approval" })
  await expect(approval.getByText(/^Approved/)).toBeVisible()
  await expect(approval.getByText("Independent review of each contract's WIP position.")).toBeVisible()
  await page.screenshot({ path: info.outputPath("approved.png"), fullPage: true })
  await page.keyboard.press("Escape")

  // The WIP schedule has a row per contract and presents over- and under-billing apart.
  await page.goto("/reports/wip-over-under?asOf=2026-07-31")
  await page.waitForLoadState("networkidle")
  await expect(page.getByText(/custom home · Site work/).filter({ visible: true }).first()).toBeVisible()
  await expect(page.getByText(/custom home · Fixed-price construction contract/).filter({ visible: true }).first()).toBeVisible()
  await expect(page.getByRole("columnheader", { name: /Billings in excess/ })).toBeVisible()
  await expect(page.getByRole("columnheader", { name: /Costs in excess/ })).toBeVisible()
  await expect(page.getByText("1 project · 2 positions").filter({ visible: true }).first()).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: info.outputPath("wip-schedule.png"), fullPage: true })
  noErrors()
})
