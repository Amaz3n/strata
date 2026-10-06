import { expect, test } from "@playwright/test"
import { applyTheme, expectNoHorizontalOverflow, journey, rows, setupSql, signIn, watchErrors } from "./support"

// B08: a statement is opened and closed in the app; outstanding book entries
// read as dates and memos, and a voided check clears against its void.
test("bank statement: a voided check clears as an offset and the statement closes", async ({ page }, info) => {
  const users = journey("bank-statement")
  const bankAccountId = users.periods.bankAccount
  // Every run starts from no statements and no offsets for this account.
  setupSql(`delete from public.books_bank_offset_lines where offset_id in (select id from public.books_bank_offsets where bank_account_id='${bankAccountId}');
    delete from public.books_bank_offsets where bank_account_id='${bankAccountId}';
    delete from public.bank_reconciliation_items where reconciliation_id in (select id from public.bank_reconciliations where bank_account_id='${bankAccountId}');
    delete from public.bank_reconciliations where bank_account_id='${bankAccountId}';`, "supabase_admin")
  const noErrors = watchErrors(page)
  await applyTheme(page, info.project.name)
  await signIn(page, users.owner, users.password)
  await page.goto(`/books/banking/${bankAccountId}/reconcile`)
  const desk = page.getByRole("region", { name: "Statement reconciliation" })
  await expect(desk).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: info.outputPath("statements.png"), fullPage: true })
  if (info.project.name !== "desktop") return noErrors()

  await desk.getByLabel("Statement start").fill("2026-07-01")
  await desk.getByLabel("Statement end").fill("2026-07-31")
  await desk.getByLabel("Beginning balance").fill("0.00")
  await desk.getByLabel("Ending balance").fill("0.00")
  await desk.getByRole("button", { name: "Open statement" }).click()
  await expect(page.getByText("Statement opened", { exact: true })).toBeVisible()

  await expect(desk.getByText("Check 301 to framing supplier")).toBeVisible()
  await desk.getByRole("checkbox", { name: /Check 301 to framing supplier/ }).check()
  await desk.getByRole("checkbox", { name: /Reversal|Check 301 voided/ }).check()
  await desk.getByLabel("Why these entries cancel").fill("Check 301 voided before it was presented")
  await desk.getByRole("button", { name: "Clear as offsetting entries" }).click()
  await expect(page.getByText("Entries cleared as an offset", { exact: true })).toBeVisible()
  await expect(desk.getByText("Outstanding book entries")).toHaveCount(0)

  await desk.getByRole("button", { name: "Close reconciliation" }).click()
  await expect(page.getByText("Reconciliation closed", { exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath("closed.png"), fullPage: true })
  const [statement] = rows<{ status: string; offsets: number }>(`select status, jsonb_array_length(evidence->'book_offsets') offsets from public.bank_reconciliations where bank_account_id='${bankAccountId}'`)
  expect(statement).toEqual({ status: "closed", offsets: 1 })
  noErrors()
})
