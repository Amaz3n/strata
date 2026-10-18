import { expect, test } from "@playwright/test"
import { applyTheme, expectNoHorizontalOverflow, journey, signIn, watchErrors } from "./support"

// B11.1: each job's revenue policy is a record with its source; a changed
// billing setting is flagged, not applied; a change is proposed by one member
// and approved by another.
test("revenue policies: inferred policies are labeled, drift is flagged, and a change needs a second approver", async ({ browser, page }, info) => {
  const users = journey("revenue-policies")
  const noErrors = watchErrors(page)
  await applyTheme(page, info.project.name)
  await signIn(page, users.owner, users.password)

  await page.goto("/books/revenue-policies")
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("3 jobs are on an inferred policy.")).toBeVisible()
  await expect(page.getByText("Inferred, not reviewed").filter({ visible: true })).toHaveCount(3)
  await expect(page.getByText("Billing settings now say at closing").filter({ visible: true })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: info.outputPath("register.png"), fullPage: true })
  if (info.project.name !== "desktop") return noErrors()

  const custom = page.getByRole("row", { name: /Custom home/ })
  await custom.getByRole("button", { name: "Confirm or change" }).click()
  await page.getByLabel("Why").fill("Fixed-price construction contract; revenue is earned over time by cost to cost.")
  await page.getByRole("button", { name: "Propose policy" }).click()
  await expect(page.getByText("Policy proposed. Another member approves it.")).toBeVisible()
  await expect(custom.getByText("Another member approves it.")).toBeVisible()
  await expect(custom.getByRole("button", { name: "Approve" })).toHaveCount(0)
  await page.screenshot({ path: info.outputPath("proposed.png"), fullPage: true })
  noErrors()

  // The accountant approves it.
  const reviewerContext = await browser.newContext()
  const reviewer = await reviewerContext.newPage()
  await signIn(reviewer, users.reviewer, users.password)
  await reviewer.goto("/books/revenue-policies")
  await reviewer.waitForLoadState("networkidle")
  const row = reviewer.getByRole("row", { name: /Custom home/ })
  await row.getByRole("button", { name: "Approve" }).click()
  await expect(reviewer.getByText("Revenue policy approved")).toBeVisible()
  await expect(row.getByText("Approved", { exact: true })).toBeVisible()
  await expect(reviewer.getByText("2 jobs are on an inferred policy.")).toBeVisible()
  await reviewer.screenshot({ path: info.outputPath("approved.png"), fullPage: true })
  await reviewerContext.close()
})
