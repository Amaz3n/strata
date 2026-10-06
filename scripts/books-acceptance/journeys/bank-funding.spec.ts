import { expect, test } from "@playwright/test"
import { journey, rows, setupSql, signIn, watchErrors } from "./support"

// B08.3: a bill payment records the account the money actually left.
test("paid from: a bill payment records the chosen cash account", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Single-run mutation")
  const users = journey("bank-funding")
  const billId = users.periods.bill
  // Every run starts from the approved, unpaid bill.
  setupSql(`delete from public.payments where bill_id='${billId}'; update public.vendor_bills set status='approved', paid_cents=0, paid_at=null where id='${billId}';`, "supabase_admin")
  const noErrors = watchErrors(page)
  await signIn(page, users.owner, users.password)
  const [bill] = rows<{ project_id: string }>(`select project_id from public.vendor_bills where id='${billId}'`)
  await page.goto(`/projects/${bill.project_id}/financials/payables?bill=${billId}`)
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: "Record payment" }).click()
  await expect(page.getByRole("button", { name: "Post payment" })).toBeVisible()
  // Two cash accounts: the payment must say which one the money left.
  await page.getByText("Paid from", { exact: true }).locator("..").getByRole("combobox").click()
  await page.getByRole("option", { name: "1005 · Payroll checking" }).click()
  const checkNumber = page.getByPlaceholder("1042")
  if (await checkNumber.isVisible()) await checkNumber.fill("2207")
  await page.screenshot({ path: info.outputPath("payment.png"), fullPage: true })
  await page.getByRole("button", { name: "Post payment" }).click()
  await expect.poll(() => rows<{ account: string }>(`select g.code account from public.payments p join public.gl_accounts g on g.id=(p.metadata->>'books_payment_account_id')::uuid where p.bill_id='${billId}'`)).toEqual([{ account: "1005" }])
  noErrors()
})
