import type { Page, TestInfo } from "@playwright/test"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

// The whole-app sweep engine (B15.3, EP14-07): open pages as one person and record,
// per page, what the browser saw: uncaught exceptions, console errors (hydration
// mismatches included), server responses of 500 or more, a crash screen. A page is
//   clean    nothing wrong;
//   refused  turned away by design: an authorization refusal is the only thing it said;
//   errors   anything else, and a person's own desk being refused;
//   skipped  it needs a record the seed does not create (never silently passed).

const DEVELOPMENT_ONLY = /Failed to execute 'measure' on 'Performance'|Download the React DevTools|\[Fast Refresh\]|\[HMR\]/
const CRASH_SCREEN = /Application error|Something went wrong|This page couldn.t load|Unhandled Runtime Error/i
/** What a missing permission looks like once a page throws it, or turns the person away. */
export const AUTHORIZATION_REFUSAL = /Missing permission|AuthorizationError|not authorized|unauthorized|do not have (access|permission)|don.t have (access|permission)|forbidden|permission to|Only .* can |Only Arc platform owners|Enable Arc Trade in Company setup first/i

export type SweepStatus = "clean" | "errors" | "skipped" | "refused"
export type SweepResult = { route: string; url?: string; status: SweepStatus; findings: string[]; flaky?: string[] }

export const appRoot = join(__dirname, "../../../app/(app)")

/** Every page under app/(app) as a route with its dynamic segments left in. */
export function pages(directory = appRoot, prefix = ""): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (!statSync(path).isDirectory()) return name === "page.tsx" ? [prefix || "/"] : []
    return pages(path, /^\(.*\)$/.test(name) ? prefix : `${prefix}/${name}`)
  })
}

export type SweepOptions = {
  /** URLs to open for a route; a route with none, or one still holding a "[", is skipped. */
  resolve: (route: string) => string[]
  routes: string[]
  /** Routes this person is turned away from by design: [route pattern, what the refusal says]. */
  refusedByDesign?: Array<[RegExp, RegExp]>
  /** Routes that are this person's own desk: a refusal there is an error. */
  ownDesk?: RegExp[]
  /** Whether any authorization refusal is acceptable on a page that is not their own desk. */
  anyRefusalAllowed?: boolean
}

export async function sweepPages(page: Page, info: TestInfo, options: SweepOptions): Promise<SweepResult[]> {
  const base = String(info.project.use.baseURL ?? "")
  const results: SweepResult[] = []
  for (const route of options.routes) {
    const urls = options.resolve(route)
    if (!urls.length || urls.some((url) => url.includes("["))) { results.push({ route, status: "skipped", findings: ["needs a record the sweep does not seed"] }); continue }
    for (const url of urls) {
      const visit = async (): Promise<{ findings: string[]; retry?: boolean }> => {
        const findings: string[] = []
        let refusedOnce = false
        const onError = (error: Error) => { if (!DEVELOPMENT_ONLY.test(error.message)) findings.push(`exception: ${error.message.slice(0, 1200)}`) }
        const onConsole = (message: { type(): string; text(): string }) => {
          if (message.type() === "error" && !DEVELOPMENT_ONLY.test(message.text())) findings.push(`console: ${message.text().slice(0, 2500)}`)
        }
        const onResponse = (response: { status(): number; url(): string }) => {
          if (response.status() >= 500 && response.url().startsWith(base)) findings.push(`server ${response.status()}: ${response.url().replace(base, "").slice(0, 200)}`)
        }
        page.on("pageerror", onError); page.on("console", onConsole); page.on("response", onResponse)
        try {
          await page.goto(url, { waitUntil: "load", timeout: 180_000 })
          await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined)
          if (new URL(page.url()).pathname === "/unauthorized" && route !== "/unauthorized") findings.push("unauthorized: redirected to /unauthorized")
          else if (await page.getByText(CRASH_SCREEN).first().isVisible().catch(() => false)) findings.push("crash screen")
        } catch (error) {
          findings.push(`navigation: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`)
          // A refused connection is the dev server restarting under the sweep, not a finding about the page.
          if (/ERR_CONNECTION_REFUSED/.test(findings.at(-1) ?? "") && await serverBack(base)) { findings.length = 0; refusedOnce = true }
        } finally {
          page.off("pageerror", onError); page.off("console", onConsole); page.off("response", onResponse)
        }
        return { findings: [...new Set(findings)], retry: refusedOnce }
      }
      const isRefusal = (findings: string[]) => findings.length > 0 && findings.every((finding) => AUTHORIZATION_REFUSAL.test(finding) || /^crash screen$/.test(finding)) && findings.some((finding) => AUTHORIZATION_REFUSAL.test(finding))
      let first = await visit()
      // The server came back after refusing the connection: open the page again.
      if (first.retry) first = await visit()
      let { findings: unique } = first
      // A development server compiles a page on its first visit, and a first load can trip a
      // warning a second never does. A finding that does not come back is reported as flaky,
      // not as an error and not as clean.
      let flaky: string[] | undefined
      if (unique.length && !isRefusal(unique)) {
        const second = await visit()
        if (!second.findings.length) { flaky = unique; unique = [] }
        else unique = second.findings
      }
      const byDesign = options.refusedByDesign?.find(([pattern]) => pattern.test(route))
      const refusal = isRefusal(unique)
      const own = options.ownDesk?.some((pattern) => pattern.test(route))
      let status: SweepStatus
      if (!unique.length) status = "clean"
      else if (byDesign && unique.every((finding) => byDesign[1].test(finding) || /^crash screen$/.test(finding))) status = "refused"
      else if (refusal && !own && options.anyRefusalAllowed) status = "refused"
      else status = "errors"
      results.push({ route, url, status, findings: unique, ...(flaky ? { flaky } : {}) })
    }
  }
  return results
}

/** Waits for the app to answer again; false if it does not within three minutes. */
async function serverBack(base: string): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const answered = await fetch(base, { redirect: "manual", signal: AbortSignal.timeout(5_000) }).then(() => true, () => false)
    if (answered) return true
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }
  return false
}

/** Counts per status, for the summary a sweep writes and a run prints. */
export function accounting(results: SweepResult[]) {
  const count = (status: SweepStatus) => results.filter((result) => result.status === status).length
  return { pages: results.length, clean: count("clean"), refused: count("refused"), errors: count("errors"), skipped: count("skipped"), flakyFirstLoads: results.filter((result) => result.flaky?.length).length }
}
