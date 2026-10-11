import { defineConfig, devices } from "@playwright/test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Arc support access (EP02-08, SEC-01): its own config so the production sweep's
// testMatch stays the sweep. Same acceptance app and workspace, desktop only.
const workspace = process.env.BOOKS_ACCEPTANCE_WORKSPACE
if (!workspace) throw new Error("Set BOOKS_ACCEPTANCE_WORKSPACE to an acceptance workspace with a running browser app")
const { url } = JSON.parse(readFileSync(join(workspace, "browser.json"), "utf8")) as { url: string }
if (!/^http:\/\/localhost:\d+$/.test(url)) throw new Error("The support-access journey runs only against a local acceptance app")

export default defineConfig({
  testDir: "./journeys",
  testMatch: "support-access.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 300_000,
  expect: { timeout: 60_000 },
  reporter: [["list"], ["json", { outputFile: join(workspace, "support-access-run.json") }]],
  use: { baseURL: url, trace: "retain-on-failure", screenshot: "only-on-failure" },
  outputDir: join(workspace, "browser-artifacts"),
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], colorScheme: "light" } }],
})
