import { expect, test } from "@playwright/test"
import { applyTheme, expectNoHorizontalOverflow, journey, rows, signIn, watchErrors } from "./support"

// B01.1: a close that stopped after freezing its period is visible and can be
// resumed from the close screen.
test("abandoned close: the stuck period explains itself and resumes to closed", async ({ page }, info) => {
  const users = journey("abandoned-close")
  const noErrors = watchErrors(page)
  await applyTheme(page, info.project.name)
  await signIn(page, users.owner, users.password)
  await page.goto(`/books/close/${users.periods["2026-07"]}`)
  await expect(page.getByText("This close stopped before it finished", { exact: false }).filter({ visible: true })).toHaveCount(1)
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: info.outputPath("abandoned.png"), fullPage: true })
  if (info.project.name !== "desktop") return noErrors()
  await page.getByRole("button", { name: "Resume close" }).click()
  await expect(page.getByText("Period closed", { exact: true })).toBeVisible()
  const [period] = rows<{ status: string; close_started_at: string | null }>(`select status, close_started_at from public.accounting_periods where id='${users.periods["2026-07"]}'`)
  expect(period).toEqual({ status: "closed", close_started_at: null })
  noErrors()
})
