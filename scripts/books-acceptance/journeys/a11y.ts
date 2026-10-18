import type { Locator, Page } from "@playwright/test"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

// Accessibility checks for the browser journeys (EP14-07): axe-core against WCAG 2.1 A/AA,
// and a keyboard walk. axe-core is not a direct dependency of the repository; the copy
// installed with eslint-plugin-jsx-a11y is injected into the page, newest version first.

const STORE = join(__dirname, "../../../node_modules/.pnpm")

function axeSource(): string {
  const versions = readdirSync(STORE).filter((name) => /^axe-core@\d+\.\d+\.\d+$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  for (const version of versions) {
    const file = join(STORE, version, "node_modules/axe-core/axe.min.js")
    if (existsSync(file)) return file
  }
  throw new Error("axe-core is not installed (it comes with eslint-plugin-jsx-a11y); run pnpm install")
}

export type AxeFinding = { rule: string; impact: string; help: string; targets: string[]; summary: string }

/** WCAG 2.1 A and AA violations of serious or critical impact on the page as it stands. */
export async function axeAudit(page: Page): Promise<AxeFinding[]> {
  // Entrances (.desk-rise, sheets sliding in) fade from transparent; contrast is read once they settle.
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity))
    .map((animation) => animation.finished.catch(() => undefined))))
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: axeSource() })
  const violations = await page.evaluate(async () => {
    type Result = { id: string; impact: string | null; help: string; nodes: Array<{ target: unknown[]; failureSummary?: string; html: string }> }
    const axe = (window as unknown as { axe: { run: (context: Document, options: object) => Promise<{ violations: Result[] }> } }).axe
    const result = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] })
    // One finding per offending element, with its own class list: axe truncates the markup
    // it reports, and a known pattern on one element must not excuse another.
    return result.violations.flatMap((violation) => violation.nodes.map((node) => {
      const selector = node.target.map(String).join(" ")
      const element = node.target.length === 1 ? document.querySelector(String(node.target[0])) : null
      return {
        rule: violation.id, impact: violation.impact ?? "unknown", help: violation.help, targets: [selector],
        summary: `${node.html.slice(0, 200)} class="${element?.getAttribute("class") ?? ""}" — ${node.failureSummary?.replace(/\s+/g, " ").slice(0, 240) ?? ""}`,
      }
    }))
  })
  return violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")
}

export type FocusStop = { tag: string; role: string | null; name: string; visible: boolean; indicator: boolean }

/**
 * Presses Tab up to `steps` times from the top of the page and records every stop. A
 * problem is a stop that is invisible, has no accessible name or shows no focus
 * indicator, focus falling back to the page body, or focus stuck on one element.
 */
export async function keyboardWalk(page: Page, steps = 25): Promise<{ stops: FocusStop[]; problems: string[] }> {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0) })
  const stops: FocusStop[] = []
  const problems: string[] = []
  const keys: string[] = []
  for (let step = 0; step < steps; step++) {
    await page.keyboard.press("Tab")
    // Focus rings animate in (transition on box-shadow); read the settled style.
    await page.waitForTimeout(250)
    const stop = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null
      // nextjs-portal is the development server's overlay; a production build has none.
      if (!element || element === document.body || element.tagName === "NEXTJS-PORTAL") return null
      const box = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const labelledBy = element.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ")
      const label = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent : null
      const name = (element.getAttribute("aria-label") || labelledBy || label || element.closest("label")?.textContent || element.innerText || element.getAttribute("title") || element.getAttribute("placeholder") || (element as HTMLInputElement).value || "").trim().replace(/\s+/g, " ").slice(0, 60)
      // A shadow list draws something when one layer is not transparent and has a non-zero size.
      const ring = (value: string) => value.split(/,(?![^(]*\))/).some((layer) => !/rgba\(0, 0, 0, 0\)|transparent/.test(layer) && /(^|\s)[1-9][\d.]*px/.test(layer))
      // Tailwind focus rings are a box-shadow; some controls ring their wrapper (focus-within).
      const parent = element.parentElement ? getComputedStyle(element.parentElement) : null
      const indicator = (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) || ring(style.boxShadow) || (parent !== null && ring(parent.boxShadow))
      return { tag: element.tagName.toLowerCase(), role: element.getAttribute("role"), name, visible: box.width > 0 && box.height > 0 && style.visibility !== "hidden", indicator, key: `${element.tagName}:${name}:${Math.round(box.x)}:${Math.round(box.y)}` }
    })
    // Past the last control focus leaves the document: the end of the tab order, not a problem.
    if (!stop) break
    const { key, ...recorded } = stop
    if (keys.slice(-2).length === 2 && keys.slice(-2).every((previous) => previous === key)) {
      problems.push(`focus stuck on ${recorded.tag} "${recorded.name}"`)
      break
    }
    stops.push(recorded)
    keys.push(key)
    const where = `${recorded.tag}${recorded.role ? `[role=${recorded.role}]` : ""} "${recorded.name}"`
    if (!recorded.visible) problems.push(`invisible element takes focus: ${where}`)
    if (!recorded.name) problems.push(`focusable element has no accessible name: ${where}`)
    if (!recorded.indicator) problems.push(`no visible focus indicator: ${where}`)
  }
  return { stops, problems: [...new Set(problems)] }
}

/** Tabs from the page top until `target` has focus; the number of presses, or null if it never does. */
export async function tabsTo(page: Page, target: Locator, limit = 60): Promise<number | null> {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0) })
  const handle = await target.elementHandle()
  if (!handle) return null
  for (let presses = 1; presses <= limit; presses++) {
    await page.keyboard.press("Tab")
    if (await handle.evaluate((element) => element === document.activeElement)) return presses
  }
  return null
}
