import { expect, test } from "@playwright/test"
import { applyTheme, expectNoHorizontalOverflow, journey, signIn, watchErrors } from "./support"

// B14: a builder with a land company sees both companies, what each owns, and
// each company's own trial balance, with consolidated eliminating what they owe
// each other.
test("two companies: ownership is shown and each company has its own trial balance", async ({ page }, info) => {
  const users = journey("two-companies")
  const land = users.periods.land
  const noErrors = watchErrors(page)
  await applyTheme(page, info.project.name)
  await signIn(page, users.owner, users.password)

  await page.goto("/books/entities")
  await page.waitForLoadState("networkidle")
  const companies = page.getByRole("region", { name: "Companies", exact: true })
  await expect(companies).toContainText("Cedar Ridge Land Co")
  await expect(companies).toContainText("Primary")
  const accounts = page.getByRole("region", { name: "Cash and card accounts" })
  await expect(accounts.getByRole("row", { name: /1005/ })).toContainText("Cedar Ridge Land Co")
  await expect(accounts.getByRole("row", { name: /1005/ })).toContainText("Fixed by postings")
  const owed = page.getByRole("region", { name: "Owed between companies" })
  await expect(owed).toContainText("$30,000.00")
  await expect(owed).toContainText("Agrees")
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: info.outputPath("companies.png"), fullPage: true })

  await page.goto(`/reports/books-trial-balance?asOf=2026-07-31&company=${land}`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByRole("row", { name: /1180/ })).toContainText("$30,000.00")
  await expect(page.getByRole("row", { name: /1005/ })).toBeVisible()
  await page.screenshot({ path: info.outputPath("land-trial-balance.png"), fullPage: true })

  await page.goto("/reports/books-trial-balance?asOf=2026-07-31&company=")
  await page.waitForLoadState("networkidle")
  await expect(page.getByRole("row", { name: /5000/ })).toContainText("$30,000.00")
  await expect(page.getByRole("row", { name: /1180/ })).toHaveCount(0)
  await expect(page.getByRole("row", { name: /2180/ })).toHaveCount(0)
  await page.screenshot({ path: info.outputPath("consolidated-trial-balance.png"), fullPage: true })
  noErrors()
})
