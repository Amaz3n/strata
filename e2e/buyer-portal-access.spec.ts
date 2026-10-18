import { randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"

test("unavailable buyer links retain the not-found boundary across portal pages", async ({ page }) => {
  const token = randomUUID()
  for (const destination of ["", "/warranty", "/model", "/decisions", `/invoices/${randomUUID()}`]) {
    await page.goto(`/p/${token}${destination}`)
    await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible()
    await expect(page.getByText("This page could not be found.", { exact: true })).toBeVisible()
  }
})
