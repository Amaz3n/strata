import { expect, test, type Page } from "@playwright/test"
import { instant } from "@next/playwright"

const email = process.env.E2E_USER_EMAIL
const password = process.env.E2E_USER_PASSWORD

async function signIn(page: Page) {
  await page.goto("/auth/signin?next=/projects")
  await page.getByLabel("Email").fill(email!)
  await page.getByRole("button", { name: "Continue" }).click()
  await page.getByLabel("Password").fill(password!)
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.waitForURL((url) => url.pathname === "/projects")
}

test.describe("authenticated instant navigation", () => {
  test.skip(!email || !password, "Set E2E_USER_EMAIL and E2E_USER_PASSWORD to run authenticated journeys")

  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test("project documents expose a useful instant shell", async ({ page }) => {
    const projectLink = page.locator('a[href^="/projects/"]:not([href="/projects/new"])').first()
    const projectHref = await projectLink.getAttribute("href")
    test.skip(!projectHref, "The E2E organization needs at least one project")

    await page.goto(projectHref!)
    const documentsHref = `${projectHref}/documents`

    await instant(page, async () => {
      await page.locator(`a[href="${documentsHref}"]`).first().click()
      await expect(page.locator('[data-instant-shell="project-documents"]')).toBeVisible()
    })

    await page.waitForURL((url) => url.pathname === documentsHref)
    await expect(page.getByText("Documents", { exact: true }).first()).toBeVisible()
  })

  test("A to B to A and browser history keep the authenticated shell responsive", async ({ page }) => {
    await page.getByRole("link", { name: /projects/i }).first().click()
    await page.waitForURL((url) => url.pathname === "/projects")
    await page.getByRole("link", { name: /my work/i }).first().click()
    await page.waitForURL((url) => url.pathname === "/my-work")
    await page.goBack()
    await expect(page).toHaveURL(/\/projects$/)
    await page.goForward()
    await expect(page).toHaveURL(/\/my-work$/)
  })
})
