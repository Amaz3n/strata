import { expect, request, test } from "@playwright/test"
import { applyTheme, expectNoHorizontalOverflow, journey, signIn, watchErrors } from "./support"

// B10: the cash P&L shows owner money and equipment in its bridge and lists book
// depreciation without deducting it; the reviewed tax workpaper downloads over
// the signed-in session, never cached, and not without a session.
test("cash basis: bridge, book-only entries and the reviewed tax workpaper", async ({ page, baseURL }, info) => {
  const users = journey("cash-basis")
  const period = "custom&_from=2026-08-01&_to=2026-08-31"
  const noErrors = watchErrors(page)
  await applyTheme(page, info.project.name)
  await signIn(page, users.owner, users.password)

  await page.goto(`/reports/books-cash-profit-loss?period=${period}`)
  await page.waitForLoadState("networkidle")
  const reconciliation = page.getByRole("region", { name: "Cash movement reconciliation" })
  await expect(reconciliation.getByRole("row", { name: /Owner contributions and distributions/ })).toContainText("$3,000.00")
  await expect(reconciliation.getByRole("row", { name: /Equipment bought and sold/ })).toContainText("$1,200.00")
  await expect(page.getByRole("region", { name: "Book entries not on the cash basis" }).getByRole("row", { name: /6080/ })).toContainText("$100.00")
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: info.outputPath("cash-profit-loss.png"), fullPage: true })

  await page.goto(`/reports/books-tax-workpaper?period=${period}`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("Checked against the depreciation schedule").first()).toBeVisible()
  await page.screenshot({ path: info.outputPath("tax-workpaper.png"), fullPage: true })
  if (info.project.name !== "desktop") return noErrors()

  for (const slug of ["books-tax-workpaper", "books-cash-profit-loss"]) {
    const csv = await page.request.get(`/api/reports/${slug}?period=${period}&format=csv`)
    expect(csv.status()).toBe(200)
    expect(csv.headers()["cache-control"]).toContain("no-store")
    expect(await csv.text()).toContain(slug === "books-tax-workpaper" ? "Checked against the depreciation schedule" : "Equipment bought and sold")
  }
  const pdf = await page.request.get(`/api/reports/books-tax-workpaper?period=${period}&format=pdf`)
  expect(pdf.status()).toBe(200)
  expect((await pdf.body()).subarray(0, 4).toString()).toBe("%PDF")

  const anonymous = await request.newContext({ baseURL })
  const refused = await anonymous.get(`/api/reports/books-tax-workpaper?period=${period}&format=csv`, { maxRedirects: 0 })
  expect(refused.status()).not.toBe(200)
  expect(await refused.text()).not.toContain("Checked against the depreciation schedule")
  await anonymous.dispose()
  noErrors()
})
