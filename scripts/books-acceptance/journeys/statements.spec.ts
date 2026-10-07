import { expect, test } from "@playwright/test"
import { applyTheme, expectNoHorizontalOverflow, journey, signIn, watchErrors } from "./support"

// B07.2: a closed month reads as it was closed, and a P&L sliced by cost code
// drills from the slice to its account and from the account to its lines.
test("statements: a closed month reads as closed; a cost-code slice drills to its lines", async ({ page }, info) => {
  const users = journey("statements")
  const noErrors = watchErrors(page)
  await applyTheme(page, info.project.name)
  await signIn(page, users.owner, users.password)

  await page.goto("/reports/books-profit-loss?period=custom&_from=2026-07-01&_to=2026-07-31&comparison=none")
  await page.waitForLoadState("networkidle")
  await expect(page.getByText(/as closed \d{4}-\d{2}-\d{2}/).filter({ visible: true }).first()).toBeVisible()
  await expect(page.getByText("$250.00").filter({ visible: true }).first()).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: info.outputPath("closed-month.png"), fullPage: true })
  if (info.project.name !== "desktop") return noErrors()

  await page.goto("/reports/books-profit-loss?period=custom&_from=2026-07-01&_to=2026-07-31&comparison=none&dimension=cost_code_id")
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: "Expand 06-100 Rough carpentry" }).click()
  await expect(page.getByText(/5000\s+Job costs/).filter({ visible: true }).first()).toBeVisible()
  await page.getByRole("button", { name: "Inspect Direct costs: $1,000.00" }).click()
  await expect(page.getByRole("heading", { name: "Transaction detail by account" })).toBeVisible()
  await expect(page.getByText(/Accrual basis · 06-100 Rough carpentry/).filter({ visible: true })).toBeVisible()
  await expect(page.getByText("Framing").filter({ visible: true }).first()).toBeVisible()
  await page.screenshot({ path: info.outputPath("cost-code-drill.png"), fullPage: true })
  noErrors()
})
