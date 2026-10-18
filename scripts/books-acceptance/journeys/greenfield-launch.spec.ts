import { expect, test } from "@playwright/test"
import { applyTheme, expectNoHorizontalOverflow, journey, signIn, watchErrors } from "./support"

// B15.1: a brand-new company makes Arc its official books from the cutover page,
// typing the attestation exactly.
test("greenfield launch: a new company makes Arc its official books", async ({ page }, info) => {
  const users = journey("greenfield-launch")
  const noErrors = watchErrors(page)
  await applyTheme(page, info.project.name)
  await signIn(page, users.owner, users.password)

  await page.goto("/books/cutover")
  await page.waitForLoadState("networkidle")
  await expect(page.getByLabel("First day Arc keeps the books")).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: info.outputPath("launch-form.png"), fullPage: true })
  if (info.project.name !== "desktop") return noErrors()

  await page.getByLabel("First day Arc keeps the books").fill("2026-07-01")
  const attestation = (await page.getByText(/^Type exactly: /).textContent())?.replace(/^Type exactly: /, "") ?? ""
  await page.getByLabel("Attestation").fill(attestation)
  await page.getByRole("button", { name: "Make Arc Books the sole ledger" }).click()
  await expect(page.getByText("Arc Books is now the sole official ledger")).toBeVisible()
  // The page refreshes itself: the launch form is gone once Arc is official.
  await expect(page.getByLabel("First day Arc keeps the books")).toHaveCount(0)
  await page.screenshot({ path: info.outputPath("launched.png"), fullPage: true })
  noErrors()
})
