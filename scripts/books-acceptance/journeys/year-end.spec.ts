import { expect, test } from "@playwright/test"
import { applyTheme, expectNoHorizontalOverflow, journey, rows, signIn, watchErrors } from "./support"

// B01.2 / B01.3: a closed fiscal year can only be corrected newest first, and
// reopening and reclosing the year end posts nothing when nothing changed.
test.describe.configure({ mode: "serial" })

test("year end: out-of-order reopen is explained, reopen and reclose leave one year-end entry", async ({ page }, info) => {
  const users = journey("year-end")
  const noErrors = watchErrors(page)
  await applyTheme(page, info.project.name)
  await signIn(page, users.owner, users.password)

  // February closed under a closed year end: guidance instead of a reopen button.
  await page.goto(`/books/close/${users.periods["2026-02"]}`)
  await expect(page.getByText("Periods reopen newest first").filter({ visible: true })).toHaveCount(1)
  await expectNoHorizontalOverflow(page)
  await expect(page.getByRole("button", { name: "Reopen for a correction" })).toHaveCount(0)
  await page.screenshot({ path: info.outputPath("february-guidance.png"), fullPage: true })

  // The desktop run corrects the year; the mobile run only verifies presentation.
  if (info.project.name !== "desktop") return noErrors()

  await page.goto(`/books/close/${users.periods["2026-03"]}`)
  await page.getByRole("button", { name: "Reopen for a correction" }).click()
  await page.getByLabel("Correction and supporting evidence").fill("Browser acceptance: review the year end with no change")
  await page.getByRole("button", { name: "Reopen period" }).click()
  await expect(page.getByText("Period reopened", { exact: true })).toBeVisible()

  await page.getByRole("button", { name: /Run checks/ }).click()
  await expect(page.getByText("Period checks updated", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Close period" }).click()
  await page.getByRole("button", { name: "Confirm close" }).click()
  await expect(page.getByText("Period closed", { exact: true })).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await page.screenshot({ path: info.outputPath("march-reclosed.png"), fullPage: true })

  const [march] = rows<{ status: string }>(`select status from public.accounting_periods where id='${users.periods["2026-03"]}'`)
  expect(march.status).toBe("closed")
  const [entries] = rows<{ n: number }>(`select count(*)::int n from public.journal_entries where org_id='${users.orgId}' and source_type='year_end_close' and status='posted'`)
  expect(entries.n).toBe(1)
  noErrors()
})

test("year end: an accountant without reopen permission is not offered a reopen", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Permission behaviour is viewport-independent")
  const users = journey("year-end")
  const noErrors = watchErrors(page)
  await signIn(page, users.reviewer, users.password)
  await page.goto(`/books/close/${users.periods["2026-03"]}`)
  await expect(page.getByRole("heading", { name: "March 2026" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Reopen for a correction" })).toHaveCount(0)
  const [march] = rows<{ status: string }>(`select status from public.accounting_periods where id='${users.periods["2026-03"]}'`)
  expect(march.status).toBe("closed")
  noErrors()
})
