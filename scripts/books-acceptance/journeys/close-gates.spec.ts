import { expect, test } from "@playwright/test"
import { applyTheme, expectNoHorizontalOverflow, journey, signIn, watchErrors } from "./support"

// B01.3: genuine problems block close for their precise causes, each leads to
// its cure, and a read-only reviewer cannot run or change the checks.
test("close gates: each blocking check names its cause and leads to its cure", async ({ page }, info) => {
  const users = journey("close-gates")
  const noErrors = watchErrors(page)
  await applyTheme(page, info.project.name)
  await signIn(page, users.owner, users.password)
  await page.goto(`/books/close/${users.periods["2026-07"]}`)
  const controls = page.getByRole("region", { name: "Period controls" })
  await expect(controls.getByText("Bank and card accounts reconciled", { exact: true })).toBeVisible()
  await expect(controls.getByText("Clearing and undeposited-funds accounts reviewed", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Close period" })).toBeDisabled()
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: info.outputPath("blocked.png"), fullPage: true })
  if (info.project.name !== "desktop") return noErrors()
  // A failing check opens to the place where it is cured.
  await controls.getByText("Bank and card accounts reconciled", { exact: true }).click()
  await expect(controls.getByRole("link", { name: /Review source/ }).filter({ visible: true })).toHaveAttribute("href", "/books/banking")
  // A ledger that does not tie to its subledger is found entry by entry by the proof.
  await controls.getByText("GL job cost ties to the job-cost subledger", { exact: true }).click()
  await controls.getByRole("button", { name: "Run ledger proof" }).filter({ visible: true }).click()
  await expect(page.getByText(/Ledger proof finished/)).toBeVisible()
  await page.getByRole("button", { name: /Run checks/ }).click()
  await expect(page.getByText("Period checks updated", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Close period" })).toBeDisabled()
  noErrors()
})

test("close gates: a read-only reviewer sees the period but cannot run checks or close", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Permission behaviour is viewport-independent")
  const users = journey("close-gates")
  const noErrors = watchErrors(page)
  await signIn(page, users.reviewer, users.password)
  await page.goto(`/books/close/${users.periods["2026-07"]}`)
  await expect(page.getByText("Your role can review this period", { exact: false }).filter({ visible: true })).toHaveCount(1)
  await expect(page.getByRole("button", { name: /Run checks/ })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Close period" })).toHaveCount(0)
  noErrors()
})
