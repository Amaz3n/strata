import { defineConfig, devices } from "@playwright/test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// The production sweep (EP14-07) at desktop width only: mobile web is out of scope, field use
// goes through the iOS app. Same acceptance app and workspace as playwright.config.ts.
const workspace = process.env.BOOKS_ACCEPTANCE_WORKSPACE
if (!workspace) throw new Error("Set BOOKS_ACCEPTANCE_WORKSPACE to an acceptance workspace with a running browser app")
const { url } = JSON.parse(readFileSync(join(workspace, "browser.json"), "utf8")) as { url: string }
if (!/^http:\/\/localhost:\d+$/.test(url)) throw new Error("The production sweep runs only against a local acceptance app")

export default defineConfig({
  testDir: "./journeys",
  testMatch: "production-sweep.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 60_000 },
  reporter: [["list"], ["json", { outputFile: join(workspace, "production-sweep-run.json") }]],
  use: { baseURL: url, trace: "retain-on-failure", screenshot: "only-on-failure" },
  outputDir: join(workspace, "browser-artifacts"),
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], colorScheme: "light" } }],
})
