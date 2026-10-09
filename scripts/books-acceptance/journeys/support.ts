import { expect, type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

export const workspace = process.env.BOOKS_ACCEPTANCE_WORKSPACE as string

export type JourneyUsers = { orgId: string; password: string; owner: string; reviewer: string; periods: Record<string, string> }

export function journey(name: string): JourneyUsers {
  const users = JSON.parse(readFileSync(join(workspace, "browser-users.json"), "utf8")) as Record<string, JourneyUsers>
  if (!users[name]) throw new Error(`Seed the ${name} journey with browser-seed.cjs first`)
  return users[name]
}

/** Harness setup SQL against the acceptance database (journeys that must recreate their starting state). */
export function setupSql(sql: string, user = "postgres") {
  const { container } = JSON.parse(readFileSync(join(workspace, "api.json"), "utf8")) as { container: string }
  if (!/^supabase_db_arc-books-acceptance-[a-z0-9]+$/.test(container)) throw new Error("Not an acceptance container")
  const result = spawnSync("docker", ["exec", "-i", container, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", "postgres"], { input: sql, encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr)
}

/** Read-only SQL against the acceptance database, for ledger assertions. */
export function rows<T>(sql: string): T[] {
  const { container } = JSON.parse(readFileSync(join(workspace, "api.json"), "utf8")) as { container: string }
  if (!/^supabase_db_arc-books-acceptance-[a-z0-9]+$/.test(container)) throw new Error("Not an acceptance container")
  const result = spawnSync("docker", ["exec", "-i", container, "psql", "-X", "-A", "-t", "-q", "-U", "postgres", "-d", "postgres"], {
    input: `select coalesce(json_agg(t),'[]') from (${sql}) t;`, encoding: "utf8",
  })
  if (result.status !== 0) throw new Error(result.stderr)
  return JSON.parse(result.stdout.trim() || "[]") as T[]
}

export async function signIn(page: Page, email: string, password: string) {
  await page.goto("/auth/signin")
  // Two steps: the email is looked up first, then the password field unfolds.
  const emailField = page.getByRole("textbox", { name: "Work email" })
  await emailField.fill(email)
  await emailField.press("Enter")
  const passwordField = page.locator('input[name="password"]')
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible()
  // The password section unfolds with an animation; type once it has settled.
  await expect(async () => {
    await passwordField.fill(password)
    await expect(passwordField).toHaveValue(password, { timeout: 1_000 })
  }).toPass()
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).not.toHaveURL(/\/auth\//)
}

/** The dark runs choose dark the way a person does: the stored theme preference. */
export async function applyTheme(page: Page, projectName: string) {
  if (projectName.includes("dark")) await page.addInitScript(() => window.localStorage.setItem("theme", "dark"))
}

/** No page-level sideways scroll at the current viewport (390px mobile included). */
export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(0)
  // Content clipped by an overflow-hidden ancestor is hidden truncation: every
  // main-content element must end inside the viewport, scroll strips aside.
  const clipped = await page.evaluate(() => {
    const width = document.documentElement.clientWidth
    return [...document.querySelectorAll("main *")].filter((element) => {
      const box = element.getBoundingClientRect()
      if (box.width === 0 || box.right <= width + 1) return false
      // A closed panel kept in the page (aria-hidden and inert) shows nothing.
      if (element.closest('[aria-hidden="true"], [inert]')) return false
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        if (/(auto|scroll)/.test(style.overflowX) && parent.scrollWidth > parent.clientWidth) return false
      }
      return true
    }).map((element) => `${element.tagName.toLowerCase()} ${(element.textContent ?? "").trim().slice(0, 40)}`).slice(0, 5)
  })
  expect(clipped, "content cut off at the viewport edge").toEqual([])
}

/** Fails the journey on any uncaught browser exception. */
// React's development-only performance tracks sometimes time a server component's
// prerender before the navigation start and throw this from performance.measure.
// It cannot happen in a production build, so it is not an application error.
const DEVELOPMENT_ONLY = /^Failed to execute 'measure' on 'Performance': .* cannot have a negative time stamp\.$/

export function watchErrors(page: Page) {
  const errors: string[] = []
  page.on("pageerror", (error) => { if (!DEVELOPMENT_ONLY.test(error.message)) errors.push(error.message) })
  return () => expect(errors, "browser exceptions").toEqual([])
}
