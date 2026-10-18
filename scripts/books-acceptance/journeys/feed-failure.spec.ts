import { expect, test } from "@playwright/test"
import { applyTheme, expectNoHorizontalOverflow, journey, rows, setupSql, signIn, watchErrors } from "./support"

// B08.2: a failing bank feed is visible and does not stop a manual
// reconciliation from a statement file.
test("feed failure: the account needs attention and its statement still closes by hand", async ({ page }, info) => {
  const users = journey("feed-failure")
  const bankAccountId = users.periods.bankAccount
  setupSql(`delete from public.bank_reconciliation_items where reconciliation_id in (select id from public.bank_reconciliations where bank_account_id='${bankAccountId}');
    delete from public.bank_reconciliations where bank_account_id='${bankAccountId}';`, "supabase_admin")
  const noErrors = watchErrors(page)
  await applyTheme(page, info.project.name)
  await signIn(page, users.owner, users.password)
  await page.goto(`/books/banking/${bankAccountId}/reconcile`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("Needs attention", { exact: true }).filter({ visible: true }).first()).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: info.outputPath("needs-attention.png"), fullPage: true })
  if (info.project.name !== "desktop") return noErrors()
  const desk = page.getByRole("region", { name: "Statement reconciliation" })
  await desk.getByLabel("Statement start").fill("2026-07-01")
  await desk.getByLabel("Statement end").fill("2026-07-31")
  await desk.getByLabel("Beginning balance").fill("0.00")
  await desk.getByLabel("Ending balance").fill("-25.00")
  await desk.getByRole("button", { name: "Open statement" }).click()
  await expect(page.getByText("Statement opened", { exact: true })).toBeVisible()
  await desk.getByRole("button", { name: "Close reconciliation" }).click()
  await expect(page.getByText("Reconciliation closed", { exact: true })).toBeVisible()
  const [statement] = rows<{ status: string }>(`select status from public.bank_reconciliations where bank_account_id='${bankAccountId}'`)
  expect(statement.status).toBe("closed")
  noErrors()
})
