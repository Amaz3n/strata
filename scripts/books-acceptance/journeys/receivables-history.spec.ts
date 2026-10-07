import { expect, test } from "@playwright/test"
import { applyTheme, expectNoHorizontalOverflow, journey, signIn, watchErrors } from "./support"

// B03.1: a void Arc never dated is named in aging rather than dropped silently;
// recording its reviewed date puts it back; the customer statement is aging's slice.
test("receivables history: an undated void is listed and dated; statements read aging's population", async ({ page }, info) => {
  const users = journey("receivables-history")
  const noErrors = watchErrors(page)
  await applyTheme(page, info.project.name)
  await signIn(page, users.owner, users.password)

  await page.goto("/reports/ar-aging?asOf=2026-07-31&view=invoices")
  await page.waitForLoadState("networkidle")
  await expect(page.getByText(/1 voided invoice has no record of when it was voided \(RH-OLD\)/).filter({ visible: true }).first()).toBeVisible()
  await expect(page.getByText("$500.00").filter({ visible: true }).first()).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: info.outputPath("aging-undated.png"), fullPage: true })

  await page.goto(`/billing?invoice=${users.periods.invoice}`)
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: "Accounting", exact: true }).click()
  const card = page.getByRole("region", { name: "Void date" }).filter({ visible: true }).first()
  await expect(card.getByText("Void date unknown")).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: info.outputPath("void-date-card.png"), fullPage: true })
  if (info.project.name !== "desktop") return noErrors()

  await card.getByLabel("Voided on").fill("2026-07-20")
  await card.getByLabel("What the date rests on").fill("Void record in the previous accounting system")
  await card.getByRole("button", { name: "Record void date" }).click()
  await expect(page.getByText("Void date recorded")).toBeVisible()
  await expect(page.getByRole("region", { name: "Void date" })).toHaveCount(0)

  await page.goto("/reports/ar-aging?asOf=2026-07-15&view=invoices")
  await page.waitForLoadState("networkidle")
  await expect(page.getByText(/no record of when/)).toHaveCount(0)
  await expect(page.getByText("$1,500.00").filter({ visible: true }).first()).toBeVisible()
  await page.screenshot({ path: info.outputPath("aging-dated.png"), fullPage: true })

  await page.goto(`/directory/${users.periods.client}`)
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: "Statement", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "As of today" })).toBeVisible()
  await page.screenshot({ path: info.outputPath("statement-menu.png"), fullPage: true })
  const pdf = await page.request.get(`/directory/${users.periods.client}/statement?as_of=2026-07-15`)
  expect(pdf.status()).toBe(200)
  expect(pdf.headers()["content-type"]).toBe("application/pdf")
  const invalid = await page.request.get(`/directory/${users.periods.client}/statement?as_of=2026-02-31`)
  expect(invalid.status()).toBe(400)
  noErrors()
})
