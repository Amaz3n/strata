import { expect, test } from "@playwright/test"
import { applyTheme, expectNoHorizontalOverflow, journey, signIn, watchErrors } from "./support"

// B12.2: a home worth less than it cost is written down to net realizable value
// after one member prepares the review and another approves it.
test("home impairment: a write-down is prepared by one member and posted by another", async ({ browser, page }, info) => {
  const users = journey("home-impairment")
  const projectId = users.periods.home
  const noErrors = watchErrors(page)
  await applyTheme(page, info.project.name)
  await signIn(page, users.owner, users.password)

  await page.goto(`/projects/${projectId}/financials/inventory`)
  await page.waitForLoadState("networkidle")
  await page.getByText("Impairment review").click()
  await expect(page.getByText("Cost carried today")).toContainText("$265,000.00")
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: info.outputPath("review.png"), fullPage: true })
  if (info.project.name !== "desktop") return noErrors()

  await page.getByLabel("Review date").fill("2026-07-20")
  await page.getByLabel("Expected selling price").fill("250000")
  await page.getByLabel("Cost to complete").fill("0")
  await page.getByLabel("Cost to sell").fill("10000")
  await expect(page.getByText("write-down $25,000.00")).toBeVisible()
  await page.getByLabel("Valuation evidence URL").fill("https://evidence.acceptance.example.test/broker-opinion.pdf")
  await page.getByLabel("Assumptions").fill("Two comparable resales closed below list; broker opinion attached.")
  await page.getByRole("button", { name: "Prepare review" }).click()
  await expect(page.getByText("Review prepared. Another member approves it.")).toBeVisible()
  await expect(page.getByText("Another member approves it.", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Approve write-down" })).toHaveCount(0)
  noErrors()

  // The accountant, who has no access to project pages, approves it on the Books desk.
  const reviewerContext = await browser.newContext()
  const reviewer = await reviewerContext.newPage()
  await signIn(reviewer, users.reviewer, users.password)
  await reviewer.goto("/books/inventory")
  await reviewer.waitForLoadState("networkidle")
  const held = reviewer.getByRole("region", { name: "Completed homes held for sale" })
  await expect(held.getByRole("row", { name: /Lot 3/ })).toContainText("$265,000.00")
  const waiting = reviewer.getByRole("region", { name: "Waiting for approval" })
  await expect(waiting).toContainText("$25,000.00")
  await reviewer.screenshot({ path: info.outputPath("desk.png"), fullPage: true })
  await waiting.getByRole("button", { name: "Approve write-down" }).click()
  await expect(reviewer.getByText("Write-down approved and posted")).toBeVisible()
  await expect(reviewer.getByText("Nothing is waiting for approval.")).toBeVisible()
  await expect(held.getByRole("row", { name: /Lot 3/ })).toContainText("$240,000.00")
  await reviewer.screenshot({ path: info.outputPath("approved.png"), fullPage: true })
  await reviewerContext.close()
})
