import { defineConfig, devices } from "@playwright/test"

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100)
const localBaseURL = `http://127.0.0.1:${port}`

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
        command: `pnpm build && pnpm start --port ${port}`,
        url: localBaseURL,
        reuseExistingServer: false,
        // CI deliberately performs exhaustive validation across hundreds of
        // routes before starting the production server.
        timeout: 900_000,
      },
})
