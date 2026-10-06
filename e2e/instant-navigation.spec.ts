import { expect, test, type Page } from "@playwright/test"
import { instant } from "@next/playwright"
import { readFileSync } from "node:fs"

const email = process.env.E2E_USER_EMAIL
const password = process.env.E2E_USER_PASSWORD

async function signIn(page: Page) {
  await page.goto("/auth/signin?next=/projects")
  await page.getByLabel("Email").fill(email!)
  await page.getByRole("button", { name: "Continue" }).click()
  await page.getByLabel("Password").fill(password!)
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.waitForURL((url) => url.pathname === "/projects")
  await page.waitForLoadState("networkidle")
}

test("external account entry streams through to sign in without an external session", async ({ page }) => {
  await page.goto("/access")
  await expect.poll(() => new URL(page.url()).pathname).toBe("/auth/signin")
  await expect(page.getByRole("heading", { name: "Welcome to Arc", exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: "No active workspaces", exact: true })).toHaveCount(0)
})

test("incomplete sign-in callbacks show recovery without creating a session", async ({ page }) => {
  await page.goto("/auth/callback#access_token=fixture-incomplete")
  await expect(page.getByRole("heading", { name: "Unable to sign in", exact: true })).toBeVisible()
  await expect(page.getByRole("alert").filter({ hasText: "This sign-in link is incomplete" })).toBeVisible()
  await page.getByRole("link", { name: "Back to sign in", exact: true }).click()
  await expect.poll(() => new URL(page.url()).pathname).toBe("/auth/signin")
  await expect(page.getByRole("heading", { name: "Welcome to Arc", exact: true })).toBeVisible()
})

test("invitation URL errors decode once without disrupting the sign-in page", async ({ page }) => {
  const message = "Progress 100% complete %2F"
  await page.goto(`/auth/signin#error_description=${encodeURIComponent(message)}`)
  await expect(page.getByRole("heading", { name: "Welcome to Arc", exact: true })).toBeVisible()
  await expect(page.getByRole("alert").filter({ hasText: message })).toHaveText(message)
})

test("incomplete reset links offer recovery without showing a password form", async ({ page }) => {
  await page.goto("/auth/reset#access_token=fixture-incomplete")
  await expect(page.getByRole("heading", { name: "Invalid or expired link", exact: true })).toBeVisible()
  await expect(page.getByRole("alert").filter({ hasText: "This reset link is incomplete" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Request new link", exact: true })).toHaveAttribute("href", "/auth/forgot-password")
  await expect(page.getByRole("heading", { name: "Choose a new password", exact: true })).toHaveCount(0)
})

test.describe("authenticated instant navigation", () => {
  test.skip(!email || !password, "Set E2E_USER_EMAIL and E2E_USER_PASSWORD to run authenticated journeys")

  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test("Dither Lab exposes named controls and recovers from clipboard denial", async ({ page }) => {
    await page.addInitScript(() => {
      let attempts = 0
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => {
          if (attempts++ === 0) throw new Error("Clipboard denied by fixture")
        } },
      })
    })
    await page.goto("/dither-lab")
    await expect(page.getByRole("switch", { name: "Loop", exact: true })).toBeVisible()
    await expect(page.getByRole("slider", { name: "Speed", exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Pause animation", exact: true }).click()
    await expect(page.getByRole("button", { name: "Resume animation", exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Copy config", exact: true }).click()
    const copyError = page.getByRole("alert").filter({ hasText: "Could not copy the configuration" })
    await expect(copyError).toBeVisible()
    await page.getByRole("button", { name: "Copy config", exact: true }).click()
    await expect(page.getByRole("button", { name: "Copied!", exact: true })).toBeVisible()
    await expect(copyError).toHaveCount(0)
  })

  test("Design Studio surfaces commit their destination breadcrumbs before live reads finish", async ({ page }) => {
    test.setTimeout(60_000)
    for (const [href, heading] of [["/design-studio/catalog", "Catalog"], ["/design-studio/rules", "Cutoff rules"]]) {
      await page.goto("/design-studio")
      const surfaces = page.getByRole("navigation", { name: "Design studio surfaces" })
      await expect(surfaces).toBeVisible()
      const link = surfaces.locator(`a[href="${href}"]`)
      await link.hover()
      await page.waitForLoadState("networkidle")
      await instant(page, async () => {
        await link.click()
        await expect.poll(() => new URL(page.url()).pathname).toBe(href)
        await expect(page.getByRole("navigation", { name: "breadcrumb" }).getByRole("link", { name: heading, exact: true })).toBeVisible()
      })
      await expect(page.getByRole("navigation", { name: "Design studio surfaces" })).toBeVisible()
    }
  })

  test("legacy opportunity URLs redirect directly to the current workspace", async ({ page }) => {
    const id = "00000000-0000-4000-8000-000000000001"
    const base = `/pipeline/prospects/${id}`
    const cases = [
      [`${base}/drawings?path=plans&tab=old&prepare=true`, `/pipeline/${id}/plans?path=plans`],
      [`${base}/documents?path=contracts`, `/pipeline/${id}/files?path=contracts`],
      [`${base}/bids/package-1?tab=old`, `/pipeline/${id}/quotes/package-1`],
      [`${base}?row=deal%20row&next=https://external.example`, `/pipeline/${id}?row=deal%20row`],
      [`${base}/documents?path=one&path=two`, `/pipeline/${id}/files`],
    ]
    for (const [source, destination] of cases) {
      const response = await page.request.get(source, { maxRedirects: 0 })
      expect(response.status()).toBe(307)
      expect(response.headers()["location"]).toBe(destination)
      expect(response.headers()["cache-control"]).toContain("no-store")
    }
  })

  test("legacy account and financial tabs resolve to current destinations", async ({ page }) => {
    test.setTimeout(60_000)
    const projectHref = await page.locator('a[href^="/projects/"]:not([href="/projects/new"]):visible').first().getAttribute("href")
    test.skip(!projectHref, "The E2E organization needs an active project")
    for (const [tab, target] of [["constructor", "financials/billing"], ["trust-center", "reports/reconciliation"]]) {
      await page.goto(`${projectHref}/financials?tab=${tab}`)
      await expect.poll(() => new URL(page.url()).pathname).toBe(`${projectHref}/${target}`)
    }
    await page.goto("/directory?kind=company")
    await expect(page.locator('[data-directory-kind="company"]')).toBeVisible()
    const companyHref = await page.locator('a[href^="/directory/"]:visible').evaluateAll(nodes => nodes.map(node => node.getAttribute("href")).find(href => /^\/directory\/[0-9a-f-]{36}$/.test(href ?? "")))
    test.skip(!companyHref, "The E2E organization needs a company")
    await page.goto(`/companies/${companyHref!.split("/").at(-1)}?tab=__proto__`)
    await expect.poll(() => new URL(page.url()).pathname).toBe(companyHref)
  })

  test("mobile settings prefetches standalone destinations without changing panel navigation", async ({ page }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 390, height: 844 })
    for (const [href, title] of [["/settings/templates", "Templates"], ["/settings/cost-coding", "Cost coding"]]) {
      await page.goto("/settings?tab=profile")
      const sections = page.getByRole("navigation", { name: "Settings sections" })
      const destination = sections.locator(`a[href="${href}"]`)
      await destination.scrollIntoViewIfNeeded()
      await destination.hover()
      await page.waitForLoadState("networkidle")
      await instant(page, async () => {
        await destination.click()
        await expect.poll(() => new URL(page.url()).pathname).toBe(href)
        await expect(page.locator("main > header").getByRole("heading", { name: title, exact: true })).toBeVisible()
        if (href === "/settings/templates") await expect(page.getByLabel("Loading page", { exact: true })).toBeVisible()
      })
      if (href === "/settings/templates") await expect(page.getByLabel("Loading page", { exact: true })).toHaveCount(0)
    }
  })

  test("cost coding sections commit their query and selected tab before live rosters finish", async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto("/settings/cost-coding?section=codes")
    for (const [section, title] of [["markup", "Markup rules"], ["rates", "Billing rates"], ["codes", "Cost codes"]]) {
      const sections = page.getByRole("navigation", { name: "Cost coding sections" })
      const destination = sections.getByRole("link", { name: title, exact: true })
      await destination.hover()
      await page.waitForLoadState("networkidle")
      await instant(page, async () => {
        await destination.click()
        await expect.poll(() => new URL(page.url()).searchParams.get("section")).toBe(section)
        await expect(destination).toHaveAttribute("aria-current", "page")
        if (section !== "codes") await expect(page.getByRole("status", { name: "Loading cost coding" })).toBeVisible()
      })
      await expect(page.getByRole("status", { name: "Loading cost coding" })).toHaveCount(0)
    }
  })

  test("template categories commit their selection before live libraries finish", async ({ page }) => {
    test.setTimeout(90_000)
    await page.goto("/settings/templates?section=estimates")
    for (const [section, title] of [["budgets", "Budgets"], ["schedules", "Schedules"], ["checklists", "Checklists"], ["waivers", "Waivers"]]) {
      const categories = page.getByRole("navigation", { name: "Template categories" })
      const destination = categories.getByRole("link", { name: title, exact: true })
      await destination.hover()
      await page.waitForLoadState("networkidle")
      await instant(page, async () => {
        await destination.click()
        await expect.poll(() => new URL(page.url()).searchParams.get("section")).toBe(section)
        await expect(destination).toHaveAttribute("aria-current", "page")
        await expect(page.getByRole("status", { name: "Loading template library" })).toBeVisible()
      })
      await expect(page.getByRole("status", { name: "Loading template library" })).toHaveCount(0)
    }
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
    const notificationFilter = page.getByRole("searchbox", { name: "Filter activity emails", exact: true })
    await notificationFilter.fill("__readonly_notification_filter__")
    await page.getByRole("link", { name: "Profile", exact: true }).first().click()
    await expect(shell).toHaveAttribute("data-settings-tab", "profile")
    const before = reads.length
    await instant(page, async () => {
      await page.getByRole("link", { name: "Notifications", exact: true }).first().click()
      await expect(shell).toHaveAttribute("data-settings-tab", "notifications")
      await expect(notificationFilter).toHaveValue("__readonly_notification_filter__")
    })
    expect(reads).toHaveLength(before)
    await page.goBack()
    await expect(shell).toHaveAttribute("data-settings-tab", "profile")
  })

  test("team settings retains roster filters across cached panel navigation", async ({ page }) => {
    await page.goto("/settings?tab=team")
    const shell = page.locator('[data-instant-shell="settings"]')
    const search = page.getByRole("textbox", { name: "Search team members", exact: true })
    await expect(search).toBeVisible()
    await search.fill("__readonly_roster_filter__")
    await page.getByRole("link", { name: "Profile", exact: true }).first().click()
    await expect(shell).toHaveAttribute("data-settings-tab", "profile")
    await instant(page, async () => {
      await page.getByRole("link", { name: "Team", exact: true }).first().click()
      await expect(shell).toHaveAttribute("data-settings-tab", "team")
      await expect(search).toHaveValue("__readonly_roster_filter__")
    })
  })

  test("organization contract templates arrive with panel data", async ({ page }) => {
    test.skip(Boolean(process.env.PLAYWRIGHT_BASE_URL), "This assertion needs the local production action manifest")
    const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")) as {
      node: Record<string, { exportedName: string }>
    }
    const templateReads = new Set(Object.entries(manifest.node)
      .filter(([, action]) => action.exportedName === "listContractTemplatesAction")
      .map(([id]) => id))
    expect(templateReads.size).toBeGreaterThan(0)
    let clientReads = 0
    page.on("request", request => {
      const actionId = request.headers()["next-action"]
      if (request.method() === "POST" && templateReads.has(actionId)) clientReads++
    })
    await page.goto("/settings?tab=organization")
    const templates = page.locator("section").filter({ has: page.getByRole("heading", { name: "Contract templates", exact: true }) }).last()
    await expect(templates).toBeVisible()
    await expect(templates.getByText("Loading…", { exact: true })).toHaveCount(0)
    await expect(templates.getByLabel("Upload Estimate template", { exact: true })).toHaveCount(1)
    await page.waitForLoadState("networkidle")
    expect(clientReads).toBe(0)
  })

  test("organization numbering edits stay local until saved", async ({ page }) => {
    await page.goto("/settings?tab=organization")
    const configure = page.getByRole("button", { name: "Configure", exact: true })
    await expect(configure).toBeVisible()
    test.skip(await configure.isDisabled(), "This check needs organization settings edit permission")
    await configure.click()
    const dialog = page.getByRole("dialog", { name: "Document numbering", exact: true })
    const prefix = dialog.getByRole("textbox", { name: "RFI", exact: true })
    const original = await prefix.inputValue()
    await prefix.fill("LOCAL-DRAFT-")
    await expect(prefix).toHaveValue("LOCAL-DRAFT-")
    await dialog.getByRole("button", { name: "Close", exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await configure.click()
    await expect(prefix).toHaveValue(original)
  })

  test("warranty response drafts reset after cancel without saving", async ({ page }) => {
    await page.goto("/settings/warranty")
    const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "Response targets", exact: true }) })
    await section.getByRole("button", { name: "Edit", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Response targets", exact: true })
    const hours = dialog.getByRole("spinbutton", { name: "First response (hours)", exact: true }).first()
    const original = await hours.inputValue()
    const draft = original === "8" ? "9" : "8"
    await hours.fill(draft)
    await expect(hours).toHaveValue(draft)
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await section.getByRole("button", { name: "Edit", exact: true }).click()
    await expect(hours).toHaveValue(original)
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  })

  test("invoice settings drafts survive back/forward without saving", async ({ page }) => {
    await page.goto("/settings?tab=invoicing&returnTo=%2Fprojects")
    const emailField = page.getByLabel("Invoice email", { exact: true })
    await expect(emailField).toBeVisible()
    test.skip(await emailField.isDisabled(), "This check needs settings edit permission")
    const original = await emailField.inputValue()
    await emailField.fill("unsaved-settings-test@example.com")
    await page.getByRole("link", { name: "Profile", exact: true }).first().click()
    await page.goBack()
    await expect(emailField).toHaveValue("unsaved-settings-test@example.com")
    await page.getByRole("button", { name: "Back", exact: true }).click()
    await expect.poll(() => new URL(page.url()).pathname).toBe("/projects")
    await page.goBack()
    await expect(emailField).toHaveValue("unsaved-settings-test@example.com")
    await emailField.fill(original)
    // No save: this journey must never mutate the connected organization's settings.
  })

  test("deal files and plans commit useful shells before their authorized live reads", async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto("/pipeline")
    await page.waitForLoadState("networkidle")
    test.skip(new URL(page.url()).pathname === "/sales", "This organization uses the Sales desk instead of Pipeline")
    const deals = page.getByRole("navigation", { name: "Deals", exact: true })
    await expect(deals).toBeVisible()
    const hrefs = await deals.locator('a[href^="/pipeline/"]').evaluateAll(nodes =>
      Array.from(new Set(nodes.map(node => (node as HTMLAnchorElement).getAttribute("href")!))).slice(0, 5),
    )
    let dealHref: string | undefined
    for (const href of hrefs) {
      await page.goto(href)
      await page.waitForLoadState("networkidle")
      if (await page.locator(`a[href="${href}/files"]:visible`).count()) {
        dealHref = href
        break
      }
    }
    test.skip(!dealHref, "The E2E organization needs an existing deal with a linked pricing project")
    for (const [section, loadingLabel] of [["files", "Loading documents"], ["plans", "Loading plans"]]) {
      await page.goto(dealHref!)
      const destination = page.locator(`a[href="${dealHref}/${section}"]:visible`)
      await destination.hover()
      await page.waitForLoadState("networkidle")
      await instant(page, async () => {
        await destination.click()
        await expect.poll(() => new URL(page.url()).pathname === `${dealHref}/${section}`).toBe(true)
        await expect(
          page.getByRole("status", { name: loadingLabel, exact: true })
            .or(page.getByRole("link", { name: "Back to the deal", exact: true })).first(),
        ).toBeVisible()
      })
      await expect(page.getByRole("link", { name: "Back to the deal", exact: true })).toBeVisible()
    }
  })

  test("project documents expose a useful instant shell", async ({ page }) => {
    const projectLink = page.locator('a[href^="/projects/"]:not([href="/projects/new"]):visible').first()
    const projectHref = await projectLink.getAttribute("href")
    test.skip(!projectHref, "The E2E organization needs at least one project")

    await page.goto(projectHref!)
    // Preconstruction projects expose Files through their opportunity route.
    // Resolve the actual sidebar destination before instant() freezes requests.
    const documentsLink = page.locator('a[href$="/documents"]:visible').first()
    if (!(await documentsLink.isVisible())) {
      await page.getByRole("button", { name: "Plan", exact: true }).click()
    }
    await expect(documentsLink).toBeVisible()
    const documentsHref = await documentsLink.getAttribute("href")
    expect(documentsHref).toBeTruthy()
    await documentsLink.hover()
    await page.waitForLoadState("networkidle")

    await instant(page, async () => {
      await documentsLink.click()
      await expect(page.locator('[data-instant-shell="project-documents"]:visible')).toBeVisible()
    })

    await page.waitForURL((url) => url.pathname === documentsHref)
    await expect(page.locator('[data-instant-shell="project-documents"]:visible')).toBeVisible()
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

  test("home and project directory publish their tier-specific title before live reads", async ({ page }) => {
    test.setTimeout(60_000)
    for (const [href, title] of [["/", "Control Tower"], ["/projects", "Projects"]]) {
      await page.goto("/tasks")
      const link = page.locator(`a[href="${href}"]:visible`).first()
      await expect(link).toBeVisible()
      await link.hover()
      await page.waitForLoadState("networkidle")
      await instant(page, async () => {
        await link.click()
        await expect.poll(() => new URL(page.url()).pathname).toBe(href)
        await expect(page.locator('nav[aria-label="breadcrumb"] [aria-current="page"]:visible')).toHaveText(title)
      })
    }
  })

  test("organization work pages publish destination titles while live reads are paused", async ({ page }) => {
    test.setTimeout(90_000)
    for (const [href, title] of [["/tasks", "Tasks"], ["/schedule", "Schedule"], ["/billing", "Billing"], ["/bids", "Bids"]]) {
      await page.goto("/projects")
      const link = page.locator(`a[href="${href}"]`).first()
      await expect(link).toBeVisible()
      await link.hover()
      await page.waitForLoadState("networkidle")
      await instant(page, async () => {
        await link.click()
        await expect.poll(() => new URL(page.url()).pathname, { message: `Destination ${href} commits while requests are paused` }).toBe(href)
        await expect(page.getByRole("navigation", { name: "breadcrumb" }).getByRole("link", { name: title, exact: true })).toBeVisible()
        await expect(page.getByLabel("Loading page", { exact: true })).toBeVisible()
      })
      await expect(page.getByLabel("Loading page", { exact: true })).toHaveCount(0)
    }
  })

  test("organization payables and reports expose destination titles before live reads finish", async ({ page }) => {
    test.setTimeout(60_000)
    const payables = page.locator('a[href="/payables"]:visible').first()
    await expect(payables).toBeVisible()
    await payables.hover()
    await page.waitForLoadState("networkidle")
    await instant(page, async () => {
      await payables.click()
      await expect.poll(() => new URL(page.url()).pathname).toBe("/payables")
      await expect(page.locator('nav[aria-label="breadcrumb"] [aria-current="page"]:visible')).toHaveText("Payables")
    })
    const library = page.locator('a[href="/reports"]:visible').first()
    await expect(library).toBeVisible()
    await library.hover()
    await page.waitForLoadState("networkidle")
    await instant(page, async () => {
      await library.click()
      await expect.poll(() => new URL(page.url()).pathname).toBe("/reports")
      await expect(page.locator('nav[aria-label="breadcrumb"] [aria-current="page"]:visible')).toHaveText("Reports")
    })
    const report = page.locator('a[href^="/reports/"]:visible').first()
    await expect(report).toBeVisible()
    const destination = new URL((await report.getAttribute("href"))!, page.url()).pathname
    await report.hover()
    await page.waitForLoadState("networkidle")
    await instant(page, async () => {
      await report.click()
      await expect.poll(() => new URL(page.url()).pathname).toBe(destination)
      await expect(page.locator('nav[aria-label="breadcrumb"] [aria-current="page"]:visible')).toHaveText("Report")
    })
  })

  test("project payroll review commits its shell before correction reads finish", async ({ page }) => {
    test.setTimeout(60_000)
    const projectHref = await page.locator('a[href^="/projects/"]:not([href="/projects/new"]):visible').first().getAttribute("href")
    test.skip(!projectHref, "The E2E organization needs an active project")
    await page.goto(`${projectHref}/time`)
    await page.waitForLoadState("networkidle")
    const link = page.getByRole("link", { name: "Payroll corrections", exact: true })
    test.skip(!(await link.count()), "The E2E actor needs enabled Books and payroll adjustment access")
    await expect(link).toBeVisible()
    await link.hover()
    await page.waitForLoadState("networkidle")
    await instant(page, async () => {
      await link.click()
      await expect.poll(() => new URL(page.url()).pathname).toBe(`${projectHref}/time/payroll`)
      await expect(page.locator('nav[aria-label="breadcrumb"] [aria-current="page"]:visible')).toHaveText("Payroll")
    })
    await page.waitForLoadState("networkidle")
    const registers = page.getByRole("complementary", { name: "Corrected provider registers" })
    const missingSnapshot = page.getByRole("alert").filter({ hasText: "Could not find the function public.capture_books_payroll_workspace_snapshot" })
    await expect(registers.or(missingSnapshot)).toBeVisible()
  })

  test("project work pages commit their shells while live data is paused", async ({ page }) => {
    test.setTimeout(90_000)
    const projectHref = await page
      .locator('a[href^="/projects/"]:not([href="/projects/new"]):visible')
      .first().getAttribute("href")
    test.skip(!projectHref, "The E2E organization needs an active project")

    for (const [suffix, title, group] of [["/bids", "Bids", "Plan"], ["/signatures", "Project Signatures", "Plan"], ["/closeout", "Closeout", "Close"], ["/drawings", "Drawings", "Plan"], ["/schedule", "Schedule", "Build"], ["/rfis", "RFIs", "Build"], ["/submittals", "Submittals", "Build"], ["/daily-logs", "Daily Logs", "Build"], ["/photos", "Photos", "Build"], ["/reports", "Reports", "Financials"]]) {
      await page.goto(projectHref!)
      const href = `${projectHref}${suffix}`
      const link = page.locator(`a[href="${href}"]:visible`).first()
      if (!(await link.isVisible())) await page.getByRole("button", { name: group, exact: true }).click()
      await expect(link).toBeVisible()
      await link.hover()
      await page.waitForLoadState("networkidle")

      await instant(page, async () => {
        await link.click()
        await expect.poll(() => new URL(page.url()).pathname).toBe(href)
        await expect(page.locator('nav[aria-label="breadcrumb"] [aria-current="page"]:visible')).toHaveText(title)
      })
    }
  })

  test("project financial pages commit their titles before live ledger reads", async ({ page }) => {
    test.setTimeout(90_000)
    const project = page.locator('a[href^="/projects/"]:not([href="/projects/new"]):visible').first()
    await expect(project).toBeVisible()
    const projectHref = (await project.getAttribute("href"))!
    for (const [suffix, title] of [["budget", "Budget"], ["billing", "Billing"], ["payables", "Payables"]]) {
      await page.goto(projectHref)
      const href = `${projectHref}/financials/${suffix}`
      const link = page.locator(`a[href="${href}"]:visible`).first()
      if (!(await link.isVisible())) await page.getByRole("button", { name: "Financials", exact: true }).click()
      await expect(link).toBeVisible()
      await link.hover()
      await page.waitForLoadState("networkidle")
      await instant(page, async () => {
        await link.click()
        await expect.poll(() => new URL(page.url()).pathname).toBe(href)
        await expect(page.locator('nav[aria-label="breadcrumb"] [aria-current="page"]:visible')).toHaveText(title)
      })
    }
  })

  test("warranty week navigation replaces the old schedule before live reads finish", async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto("/warranty?tab=dispatch&week=2026-10-05")
    const week = page.getByRole("navigation", { name: "Dispatch week", exact: true })
    await expect(week).toBeVisible()
    const next = week.getByRole("link", { name: "Next week", exact: true })
    const destination = await next.getAttribute("href")
    await next.hover()
    await page.waitForLoadState("networkidle")
    await instant(page, async () => {
      await next.click()
      await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe(destination)
      await expect(page.locator('[aria-label="Loading warranty desk"]:visible')).toBeVisible()
      await expect(week).toHaveCount(0)
    })
    await expect(page.getByRole("navigation", { name: "Dispatch week", exact: true })).toContainText(new URL(destination!, page.url()).searchParams.get("week")!)
  })

  test("enabled Books sections commit their shells before financial reads", async ({ page }) => {
    test.setTimeout(90_000)
    const books = page.getByRole("button", { name: "Books", exact: true })
    test.skip(!(await books.isVisible()), "The E2E organization needs an enabled Books workspace")
    await books.click()

    for (const [href, title] of [["/books/banking", "Banking"], ["/books/ledger", "General ledger"], ["/books/overhead", "Company budget"], ["/books/assets", "Assets & loans"]]) {
      const link = page.locator(`a[href="${href}"]:visible`).first()
      await expect(link).toBeVisible()
      await link.hover()
      await page.waitForLoadState("networkidle")
      await instant(page, async () => {
        await link.click()
        await expect.poll(() => new URL(page.url()).pathname).toBe(href)
        await expect(page.locator('nav[aria-label="breadcrumb"] [aria-current="page"]:visible')).toContainText(title)
      })
    }
  })

  test("Accounting layout exposes setup shells before their live reads", async ({ page }) => {
    test.setTimeout(60000)
    await page.goto("/settings?tab=accounting")
    const chart = page.locator('a[href="/settings/accounting/chart-of-accounts"]:visible')
    await expect(page.getByRole("heading", { name: "Arc Books", exact: true })).toBeVisible()
    await expect(chart).toBeVisible()
    for (const [section, title] of [["chart-of-accounts", "Chart of accounts"], ["calendar", "Accounting calendar"], ["opening-balances", "Opening balances"], ["setup", "Setup & migration"]]) {
      if (section !== "chart-of-accounts") await page.goto("/settings?tab=accounting")
      const href = `/settings/accounting/${section}`
      const link = page.locator(`a[href="${href}"]:visible`)
      await expect(link).toBeVisible()
      await link.hover()
      await page.waitForLoadState("networkidle")
      await instant(page, async () => {
        await link.click()
        await expect.poll(() => new URL(page.url()).pathname === href).toBe(true)
        await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible()
      })
    }
  })

  test("community identity and tabs appear before live inventory and runway reads", async ({ page }) => {
    test.setTimeout(60000)
    await page.goto("/communities")
    await expect(page.getByRole("group", { name: "Horizon", exact: true }).or(page.getByText("No communities yet", { exact: true }))).toBeVisible()
    const community = page.locator('a[href^="/communities/"]:visible').first()
    test.skip(!(await community.count()), "The E2E organization needs an existing community")
    const href = await community.getAttribute("href")
    const name = (await community.textContent())!.trim()
    await community.hover()
    await page.waitForLoadState("networkidle")
    await instant(page, async () => {
      await community.click()
      await expect.poll(() => new URL(page.url()).pathname === href).toBe(true)
      await expect(page.locator('[data-instant-shell="community"]:visible')).toBeVisible()
      await expect(page.locator('nav[aria-label="breadcrumb"] [aria-current="page"]:visible')).toHaveText(name)
      await expect(page.getByRole("navigation", { name: "Community", exact: true })).toBeVisible()
    })
    for (const tab of ["Offering", "Land", "Inventory"]) {
      const link = page.getByRole("navigation", { name: "Community", exact: true }).getByRole("link", { name: tab, exact: true })
      await instant(page, async () => {
        await link.click()
        await expect(link).toHaveAttribute("aria-current", "page")
        await expect(page.locator('[data-instant-shell="community"]:visible')).toBeVisible()
      })
    }
  })

  test("company tabs select and render their prefetched panel on the click frame", async ({ page }) => {
    await page.goto("/directory?kind=company")
    await expect(page.locator('[data-directory-kind="company"]')).toBeVisible()
    await page.waitForLoadState("networkidle")
    const companyHref = await page
      .locator('a[href^="/directory/"]:visible')
      .evaluateAll((nodes) =>
        nodes
          .map((node) => (node as HTMLAnchorElement).getAttribute("href"))
          .find((href) => /^\/directory\/[0-9a-f-]{36}$/.test(href ?? "")),
      )
    test.skip(!companyHref, "The E2E organization needs at least one company")

    await page.goto(companyHref!)
    const tabLinks = page.getByRole("navigation", { name: "Account sections" }).locator("a:visible")
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
      await expect(page.locator("[data-company-tab-skeleton]:visible")).toHaveCount(0)
    })
  })

  test("switching from one project to another paints the destination identity", async ({ page }) => {
    await expect(page.locator('[data-instant-shell="projects-directory"]')).toHaveAttribute("data-projects-ready", "true")
    const links = page.locator('a[href^="/projects/"]:not([href="/projects/new"]):visible')
    const hrefs = await links.evaluateAll((nodes) =>
      Array.from(new Set(nodes.map((node) => (node as HTMLAnchorElement).getAttribute("href") ?? ""))).filter(
        (href) => /^\/projects\/[^/]+$/.test(href),
      ),
    )
    test.skip(hrefs.length < 2, "The E2E organization needs at least two projects to switch between")
    const [first, second] = hrefs

    await page.goto(first)
    const identity = page.locator('[data-instant-shell="project-overview"]:visible')
    await expect(identity).toBeVisible()
    const firstName = (await identity.getByRole("heading").first().textContent())?.trim()

    // Exercise the Link inside the sidebar dropdown: its intent prefetch and
    // Link instance must survive selection until the route commits.
    const switcher = page.getByRole("button", { name: new RegExp(firstName!.slice(0, 12), "i") }).first()
    const destinationPrefetch = page.waitForResponse(response =>
      new URL(response.url()).pathname === second &&
      response.request().headers()["next-router-prefetch"] === "2",
    )
    await switcher.click()
    const target = page.locator(`[role="menuitem"][href="${second}"]`)
    await target.hover()
    // Confirm that hovering requested the per-link runtime prefetch, then let
    // the browser settle before pausing live navigation responses.
    const response = await destinationPrefetch
    expect(response.ok()).toBe(true)
    await page.waitForLoadState("networkidle")
    await instant(page, async () => {
      await target.click({ timeout: 5000 })
      await expect.poll(() => new URL(page.url()).pathname === second, { timeout: 5000 }).toBe(true)
      await expect(identity).toBeVisible()
      await expect(identity.getByRole("heading").first()).not.toHaveText(firstName!)
      await expect(target).toBeHidden()
    })
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
    await page.getByRole("link", { name: "Tasks", exact: true }).first().click()
    await page.waitForURL((url) => url.pathname === "/tasks")
    await page.goBack()
    await expect(page).toHaveURL(/\/projects$/)
    await page.goForward()
    await expect(page).toHaveURL(/\/tasks$/)
  })
})
