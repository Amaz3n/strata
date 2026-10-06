import { expect, test } from "@playwright/test"
import { applyTheme, expectNoHorizontalOverflow, journey, signIn, watchErrors } from "./support"

// B09.3: documents say where they stand in the ledger, open their journal, and
// lead to the cure when posting is blocked.
test("posting status: a posted invoice opens its journal; a blocked bill leads to its cure", async ({ page }, info) => {
  const users = journey("posting-status")
  const noErrors = watchErrors(page)
  await applyTheme(page, info.project.name)
  await signIn(page, users.owner, users.password)
  const projectId = users.periods.project

  // The blocked bill: closed July, re-coded afterwards.
  await page.goto(`/projects/${projectId}/financials/payables?bill=${users.periods.bill}`)
  await page.waitForLoadState("networkidle")
  const billStatus = page.getByRole("region", { name: "Accounting posting" }).filter({ visible: true }).first()
  await expect(billStatus.getByText(/Posting blocked by a closed period/)).toBeVisible()
  await expect(billStatus.getByRole("link", { name: "Resolve in Books" })).toHaveAttribute("href", "/books/close")
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: info.outputPath("blocked-bill.png"), fullPage: true })
  if (info.project.name !== "desktop") return noErrors()

  // The posted invoice and its receipt.
  await page.goto(`/projects/${projectId}/financials/billing?invoice=${users.periods.invoice}`)
  await page.waitForLoadState("networkidle")
  const invoiceStatus = page.getByRole("region", { name: "Accounting posting" }).filter({ visible: true }).first()
  await expect(invoiceStatus.getByText("Journal verified for this revision")).toBeVisible()
  const journalLink = invoiceStatus.getByRole("link", { name: /^Journal 2026-07-05/ })
  await expect(journalLink).toBeVisible()
  await page.screenshot({ path: info.outputPath("posted-invoice.png"), fullPage: true })
  await journalLink.click()
  await expect(page).toHaveURL(new RegExp(`/books/ledger\\?q=${users.periods.invoice}`))
  await expect(page.getByText("PS-1", { exact: false }).first()).toBeVisible()
  noErrors()
})
