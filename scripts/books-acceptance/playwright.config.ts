import { defineConfig, devices } from "@playwright/test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Authenticated Books journeys against the isolated acceptance app started by
// browser.cjs. Never points at a developer server or `.env.local`.
const workspace = process.env.BOOKS_ACCEPTANCE_WORKSPACE
if (!workspace) throw new Error("Set BOOKS_ACCEPTANCE_WORKSPACE to an acceptance workspace with a running browser app")
const { url } = JSON.parse(readFileSync(join(workspace, "browser.json"), "utf8")) as { url: string }
if (!/^http:\/\/localhost:\d+$/.test(url)) throw new Error("Books journeys run only against a local acceptance app")

export default defineConfig({
  testDir: "./journeys",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 60_000 },
  reporter: [["list"], ["json", { outputFile: join(workspace, "browser-journeys.json") }]],
  use: { baseURL: url, trace: "retain-on-failure", screenshot: "only-on-failure" },
  outputDir: join(workspace, "browser-artifacts"),
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], colorScheme: "light" } },
    { name: "mobile-dark", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, colorScheme: "dark" } },
  ],
})
