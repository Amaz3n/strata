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

  test("settings switches immediately and reuses visited panels", async ({ page }) => {
    const reads: string[] = []
    page.on("request", (request) => {
      if (request.url().includes("/api/settings/panel")) reads.push(new URL(request.url()).searchParams.get("tab") ?? "")
    })
    await page.goto("/settings?tab=profile")
    const shell = page.locator('[data-instant-shell="settings"]')
    await expect(shell).toHaveAttribute("data-settings-tab", "profile")
    expect(reads).not.toContain("team")
    expect(reads).not.toContain("payments")
    await instant(page, async () => {
      await page.getByRole("link", { name: "Notifications", exact: true }).first().click()
      await expect(shell).toHaveAttribute("data-settings-tab", "notifications")
    })
    await expect(page.getByRole("status", { name: "Loading settings" })).toHaveCount(0)
    await page.getByRole("link", { name: "Profile", exact: true }).first().click()
    await expect(shell).toHaveAttribute("data-settings-tab", "profile")
    const before = reads.length
    await instant(page, async () => {
      await page.getByRole("link", { name: "Notifications", exact: true }).first().click()
      await expect(shell).toHaveAttribute("data-settings-tab", "notifications")
    })
    expect(reads).toHaveLength(before)
    await page.goBack()
    await expect(shell).toHaveAttribute("data-settings-tab", "profile")
  })

  test("invoice settings drafts survive back/forward without saving", async ({ page }) => {
    await page.goto("/settings?tab=invoicing")
    const emailField = page.getByLabel("Invoice email", { exact: true })
    await expect(emailField).toBeVisible()
    test.skip(await emailField.isDisabled(), "This check needs settings edit permission")
    const original = await emailField.inputValue()
    await emailField.fill("unsaved-settings-test@example.com")
    await page.getByRole("link", { name: "Profile", exact: true }).first().click()
    await page.goBack()
    await expect(emailField).toHaveValue("unsaved-settings-test@example.com")
    await emailField.fill(original)
    // No save: this journey must never mutate the connected organization's settings.
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

  test("directory kind swaps the useful rows immediately", async ({ page }) => {
    await page.goto("/directory")

    await instant(page, async () => {
      await page.getByRole("link", { name: "Contacts", exact: true }).first().click()
      await expect(
        page.getByRole("link", { name: "Contacts", exact: true }).first(),
      ).toHaveAttribute("aria-current", "page")
      await expect(page.locator('[data-instant-shell="directory"]').first()).toBeVisible()
      await expect(page.locator('[data-directory-kind="contact"]')).toBeVisible()
    })
    await page.waitForURL((url) =>
      url.pathname === "/directory" && url.searchParams.get("kind") === "contact",
    )

    await instant(page, async () => {
      await page.getByRole("link", { name: "Companies", exact: true }).first().click()
      await expect(
        page.getByRole("link", { name: "Companies", exact: true }).first(),
      ).toHaveAttribute("aria-current", "page")
      await expect(page.locator('[data-directory-kind="company"]')).toBeVisible()
    })
    await page.waitForURL((url) =>
      url.pathname === "/directory" && url.searchParams.get("kind") === "company",
    )
  })

  test("company tabs select and render their prefetched panel on the click frame", async ({ page }) => {
    await page.goto("/directory?kind=company")
    const companyHref = await page
      .locator('a[href^="/directory/"]')
      .evaluateAll((nodes) =>
        nodes
          .map((node) => (node as HTMLAnchorElement).getAttribute("href"))
          .find((href) => /^\/directory\/[0-9a-f-]{36}$/.test(href ?? "")),
      )
    test.skip(!companyHref, "The E2E organization needs at least one company")

    await page.goto(companyHref!)
    const tabLinks = page.getByRole("navigation", { name: "Account sections" }).getByRole("link")
    await expect(tabLinks.first()).toBeVisible()
    const destination = tabLinks.nth(1)
    const destinationHref = await destination.getAttribute("href")
    test.skip(!destinationHref, "The company needs at least two account tabs")

    // Let the bounded tab strip finish its viewport-triggered runtime
    // prefetches. instant() then freezes anything that was not ready before the
    // click, so seeing no skeleton proves the destination panel was prefetched.
    await page.waitForLoadState("networkidle")
    await instant(page, async () => {
      await destination.click()
      await page.waitForURL((url) => url.pathname === destinationHref)
      await expect(destination).toHaveAttribute("aria-current", "page")
      await expect(page.locator("[data-company-tab-skeleton]")).toHaveCount(0)
    })
  })

  test("switching from one project to another paints the destination identity", async ({ page }) => {
    const links = page.locator('a[href^="/projects/"]:not([href="/projects/new"])')
    const hrefs = await links.evaluateAll((nodes) =>
      Array.from(new Set(nodes.map((node) => (node as HTMLAnchorElement).getAttribute("href") ?? ""))).filter(
        (href) => /^\/projects\/[^/]+$/.test(href),
      ),
    )
    test.skip(hrefs.length < 2, "The E2E organization needs at least two projects to switch between")
    const [first, second] = hrefs

    await page.goto(first)
    const identity = page.locator('[data-instant-shell="project-overview"]')
    await expect(identity).toBeVisible()
    const firstName = (await identity.getByRole("heading").first().textContent())?.trim()

    // Switching goes through the sidebar switcher, not a link: that path had no
    // prefetch at all, so the destination started cold on every switch.
    const switcher = page.getByRole("button", { name: new RegExp(firstName!.slice(0, 12), "i") }).first()
    await switcher.click()
    const target = page.locator(`[role="menuitem"]`).filter({ hasNotText: firstName! }).first()
    await target.hover()
    await target.click()

    await page.waitForURL((url) => url.pathname === second)
    // The identity band must not wait on the financial band behind it.
    await expect(identity).toBeVisible({ timeout: 5_000 })
    const secondName = (await identity.getByRole("heading").first().textContent())?.trim()
    expect(secondName).not.toBe(firstName)

    // ...and back again: the return trip is the one users make most.
    await page.goBack()
    await page.waitForURL((url) => url.pathname === first)
    await expect(identity.getByRole("heading").first()).toHaveText(firstName!)
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
