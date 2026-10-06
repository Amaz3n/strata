import { expect, test } from "@playwright/test"
import { instant } from "@next/playwright"

test("confirmation without credentials returns to sign-in", async ({ page }) => {
  await page.goto("/auth/confirm")
  await page.waitForURL("**/auth/signin")
  await expect(page.getByRole("textbox", { name: "Work email", exact: true })).toBeVisible()
})

test("invalid reset token types reach a useful error page without consuming a token", async ({ page }) => {
  await page.goto("/auth/reset?token_hash=fixture-invalid&type=unsupported")
  await page.waitForURL("**/auth/confirm/error")
  await expect(page.getByRole("heading", { name: "Invalid or expired link" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/auth/signin")
})

test("public legal pages navigate instantly from the sign-in screen", async ({ page }) => {
  await page.goto("/auth/signin")
  const terms = page.getByRole("link", { name: "Terms of Service", exact: true })
  await expect(terms).toBeVisible()
  await page.waitForLoadState("networkidle")

  await instant(page, async () => {
    await terms.click()
    await expect(page.getByRole("heading", { name: "Terms of Service", exact: true })).toBeVisible()
  })
  await page.waitForURL("**/terms")

  const privacy = page.getByRole("link", { name: "Privacy", exact: true })
  await privacy.scrollIntoViewIfNeeded()
  await page.waitForLoadState("networkidle")
  await instant(page, async () => {
    await privacy.click()
    await expect(page.getByRole("heading", { name: "Privacy Policy", exact: true })).toBeVisible()
  })
  await page.waitForURL("**/privacy")
})

test.describe("server-rendered invitation validation", () => {
  test("a missing invitation is returned in server HTML without an action request", async ({ page }) => {
    const actionRequests: string[] = []
    page.on("request", request => {
      if (request.method() === "POST" && request.headers()["next-action"]) actionRequests.push(request.url())
    })
    const response = await page.goto("/auth/accept-invite")
    // Streaming Suspense uses inline scripts to reveal the server HTML. Disabling
    // JavaScript tests that transport rather than whether data is fetched on the server.
    expect(await response!.text()).toContain(">Invitation not found</h1>")
    await expect(page.getByRole("heading", { name: "Invitation not found" })).toBeVisible()
    await expect(page.getByText("Invalid invitation link. Please check the link in your email.")).toBeVisible()
    await expect(page.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/auth/signin")
    expect(actionRequests).toEqual([])
  })
})
