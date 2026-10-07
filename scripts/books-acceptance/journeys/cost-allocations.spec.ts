import { expect, test } from "@playwright/test"
import { applyTheme, expectNoHorizontalOverflow, journey, signIn, watchErrors } from "./support"

// B11.4: a shared cost pool reaches jobs only through an allocation one member
// proposes and another approves; it splits to the cent and the pool empties.
test("cost allocations: a pool is split to the cent and posts only after a second member approves", async ({ browser, page }, info) => {
  const users = journey("cost-allocations")
  const noErrors = watchErrors(page)
  await applyTheme(page, info.project.name)
  await signIn(page, users.owner, users.password)

  await page.goto("/books/cost-allocations")
  await page.waitForLoadState("networkidle")
  const pools = page.getByRole("region", { name: "Pools" })
  await expect(pools.getByRole("row", { name: /6010/ })).toContainText("$1,000.01")
  await expect(page.getByText("No allocations yet.")).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: info.outputPath("register.png"), fullPage: true })
  if (info.project.name !== "desktop") return noErrors()

  await page.getByRole("button", { name: "Allocate a pool" }).click()
  await page.getByLabel("Kind of cost").selectOption("insurance")
  await page.getByLabel("Amount to allocate").fill("1000.01")
  await page.getByLabel("Destination 1").selectOption({ label: "Riverside clinic" })
  await page.getByRole("button", { name: "Add destination" }).click()
  await page.getByLabel("Destination 2").selectOption({ label: "Harbor offices" })
  await page.getByLabel("Unique reference").fill("July insurance")
  await page.getByLabel("Supporting schedule URL").fill("https://evidence.acceptance.example.test/july-insurance.pdf")
  await page.getByLabel("Why this basis").fill("Both jobs ran the full month under the same policy.")
  await page.getByRole("button", { name: "Propose allocation" }).click()
  await expect(page.getByText("Allocation proposed. Another member approves it.")).toBeVisible()
  const row = page.getByRole("row", { name: /July insurance/ })
  await expect(row.getByText("Another member approves it.")).toBeVisible()
  await expect(row.getByRole("button", { name: "Approve and post" })).toHaveCount(0)
  await page.screenshot({ path: info.outputPath("proposed.png"), fullPage: true })
  noErrors()

  // The accountant approves it.
  const reviewerContext = await browser.newContext()
  const reviewer = await reviewerContext.newPage()
  await signIn(reviewer, users.reviewer, users.password)
  await reviewer.goto("/books/cost-allocations")
  await reviewer.waitForLoadState("networkidle")
  const pending = reviewer.getByRole("row", { name: /July insurance/ })
  await pending.getByRole("button", { name: "Approve and post" }).click()
  await expect(reviewer.getByText("Allocation approved and posted")).toBeVisible()
  await expect(pending.getByText("Posted", { exact: true })).toBeVisible()
  await expect(pending).toContainText("$500.01")
  await expect(pending).toContainText("$500.00")
  await expect(reviewer.getByText("No company expense is waiting to be allocated.")).toBeVisible()
  await reviewer.screenshot({ path: info.outputPath("approved.png"), fullPage: true })
  await reviewerContext.close()
})
