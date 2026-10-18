import { expect, request, test } from "@playwright/test"
import { applyTheme, expectNoHorizontalOverflow, journey, signIn, watchErrors } from "./support"

// B05: the owner prepares the year's 1099 package, the accountant approves it,
// and the filing file (full taxpayer IDs) downloads for the filer, never cached,
// and never without a session.
test("1099s: a package is prepared by one member, approved by another and its filing file downloads", async ({ browser, page, baseURL }, info) => {
  const users = journey("vendor-1099")
  const noErrors = watchErrors(page)
  await applyTheme(page, info.project.name)
  await signIn(page, users.owner, users.password)

  const loadYear = async (target: typeof page) => {
    await target.goto("/books/taxes")
    await target.waitForLoadState("networkidle")
    const section = target.getByRole("region", { name: "1099 filing" })
    await section.getByLabel("Tax year").fill("2026")
    await section.getByRole("button", { name: "Load" }).click()
    return section
  }
  const section = await loadYear(page)
  await expect(section.getByText("TIN ••• 3334")).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: info.outputPath("before.png"), fullPage: true })
  if (info.project.name !== "desktop") return noErrors()

  await section.getByRole("button", { name: "Prepare package" }).click()
  const prepared = section.getByRole("row", { name: /prepared/i })
  await expect(prepared).toContainText("$18,120.00")
  await expect(prepared.getByRole("button", { name: "Approve" })).toHaveCount(0)

  const reviewerContext = await browser.newContext()
  const reviewer = await reviewerContext.newPage()
  await applyTheme(reviewer, info.project.name)
  await signIn(reviewer, users.reviewer, users.password)
  const review = await loadYear(reviewer)
  await review.getByRole("row", { name: /prepared/i }).getByRole("button", { name: "Approve" }).click()
  await review.getByLabel("Review notes").fill("Matched to the payables register")
  await review.getByRole("button", { name: "Save" }).click()
  await expect(review.getByRole("row", { name: /approved/i })).toContainText("$18,120.00")
  await reviewerContext.close()

  await page.reload()
  const approved = (await loadYear(page)).getByRole("row", { name: /approved/i })
  await expect(approved.getByRole("link", { name: "Filing file" })).toBeVisible()
  await page.screenshot({ path: info.outputPath("approved.png"), fullPage: true })
  const href = await approved.getByRole("link", { name: "Filing file" }).getAttribute("href")
  expect(href).toBeTruthy()
  const file = await page.request.get(href ?? "")
  expect(file.status()).toBe(200)
  expect(file.headers()["cache-control"]).toContain("no-store")
  const csv = await file.text()
  expect(csv.split("\n")[0]).toContain("Recipient TIN")
  expect(csv).toContain("487654324,SSN,Pat Rivera")

  const anonymous = await request.newContext({ baseURL })
  const refused = await anonymous.get(href ?? "", { maxRedirects: 0 })
  expect(refused.status()).not.toBe(200)
  expect(await refused.text()).not.toContain("487654324")
  await anonymous.dispose()
  noErrors()
})
