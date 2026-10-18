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
  // July's journal still stands; the re-code is what the closed period holds back.
  await expect(billStatus.getByRole("link", { name: /^Last journal 2026-07-10/ })).toBeVisible()
  await expect(billStatus.getByText(/atomically/)).toHaveCount(0)
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: info.outputPath("blocked-bill.png"), fullPage: true })
  if (info.project.name !== "desktop") return noErrors()

  // Loading, then an unreachable status service, then Refresh once it is back.
  const isStatusRequest = (body: string | null) => Boolean(body?.includes('"sourceType":"vendor_bill"'))
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/*", async (route) => {
    if (route.request().method() !== "POST" || !isStatusRequest(route.request().postData())) return route.fallback()
    await held
    await route.abort()
  })
  await billStatus.getByRole("button", { name: "Refresh" }).click()
  await expect(billStatus.getByText("Checking posting…")).toBeVisible()
  release()
  await expect(billStatus.getByText("Accounting status is unavailable")).toBeVisible()
  await page.unrouteAll({ behavior: "wait" })
  await billStatus.getByRole("button", { name: "Refresh" }).click()
  await expect(billStatus.getByText(/Posting blocked by a closed period/)).toBeVisible()

  // The posted invoice and its receipt.
  await page.goto(`/projects/${projectId}/financials/billing?invoice=${users.periods.invoice}`)
  await page.waitForLoadState("networkidle")
  // The invoice reads by its own date, the one its journal posts on.
  await expect(page.getByText("Jul 5, 2026").first()).toBeVisible()
  // The applied receipt reports its own journal in the invoice's activity.
  await page.getByRole("button", { name: "Activity", exact: true }).click()
  const paymentStatus = page.getByRole("region", { name: "Accounting posting" }).filter({ visible: true }).first()
  await expect(paymentStatus.getByText("Journal verified for this revision")).toBeVisible()
  await expect(paymentStatus.getByRole("link", { name: /^Journal 2026-07-08/ })).toBeVisible()
  await page.getByRole("button", { name: "Accounting", exact: true }).click()
  const invoiceStatus = page.getByRole("region", { name: "Accounting posting" }).filter({ visible: true }).first()
  await expect(invoiceStatus.getByText("Journal verified for this revision")).toBeVisible()
  const journalLink = invoiceStatus.getByRole("link", { name: /^Journal 2026-07-05/ })
  await expect(journalLink).toBeVisible()
  await page.screenshot({ path: info.outputPath("posted-invoice.png"), fullPage: true })
  await journalLink.click()
  await expect(page).toHaveURL(/\/books\/ledger\?entry=[0-9a-f-]{36}$/)
  await expect(page.getByText("Linked entry", { exact: true })).toBeVisible()
  // The search lands on exactly the invoice's journal.
  await expect(page.getByText("1 entry", { exact: true })).toBeVisible()
  await expect(page.getByText("Consulting", { exact: true }).filter({ visible: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath("invoice-journal.png"), fullPage: true })
  noErrors()
})
