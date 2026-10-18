import { defineConfig, devices } from "@playwright/test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

// Next loads this file for the app server, but the Playwright test process is
// separate. Load local test credentials there too; existing CI variables win.
const localEnv = join(__dirname, ".env.local")
if (existsSync(localEnv)) process.loadEnvFile(localEnv)

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100)
const localBaseURL = `http://127.0.0.1:${port}`
const webServerCommand = process.env.PLAYWRIGHT_SKIP_BUILD
  ? `pnpm start --port ${port}`
  : `pnpm build && pnpm start --port ${port}`

if (process.env.PLAYWRIGHT_SKIP_BUILD && !process.env.PLAYWRIGHT_BASE_URL) {
  const manifestPath = join(__dirname, ".next/required-server-files.json")
  const builtWithTestingApi = existsSync(manifestPath)
    && JSON.parse(readFileSync(manifestPath, "utf8")).config?.experimental?.exposeTestingApiInProductionBuild === true
  if (!builtWithTestingApi) {
    throw new Error("Instant-navigation tests require a test build. Omit PLAYWRIGHT_SKIP_BUILD or rebuild with NEXT_INSTANT_NAVIGATION_TESTING=true pnpm build.")
  }
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? localBaseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        // Automatic Link prefetching is production-only. Running instant()
        // against next dev would validate a mode users never receive.
        command: webServerCommand,
        env: { NEXT_INSTANT_NAVIGATION_TESTING: "true" },
        url: localBaseURL,
        reuseExistingServer: false,
        // CI deliberately performs exhaustive validation across hundreds of
        // routes before starting the production server.
        timeout: 900_000,
      },
})
