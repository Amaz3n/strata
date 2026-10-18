import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { chromium, expect } from "@playwright/test"
import babel from "next/dist/compiled/babel/core.js"
import compiler from "babel-plugin-react-compiler"
const built = await Bun.build({ entrypoints: ["tests/fixtures/schedule-refresh/ui.jsx"], target: "browser", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "schedule-refresh", setup(builder) {
  builder.onLoad({ filter: /schedule-context\.tsx$/ }, async ({ path }) => ({ loader: "tsx", contents: babel.transformSync(await readFile(path, "utf8"), { filename: path, configFile: false, babelrc: false, parserOpts: { plugins: ["typescript", "jsx"] }, plugins: [[compiler, { target: "19" }]] }).code }))
} }] })
assert.ok(built.success, built.logs.join("\n"))
const bundle = await built.outputs[0].text()
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/bundle.js" ? new Response(bundle, { headers: { "content-type": "text/javascript" } }) : new Response('<html><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>', { headers: { "content-type": "text/html" } }) })
let browser
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage(), errors = [], blocked = [], origin = `http://127.0.0.1:${server.port}`
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : (blocked.push(route.request().url()), route.abort()))
  await page.goto(origin)
  await expect(page.getByText("Original task", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Pan timeline" }).click()
  await page.evaluate(() => window.scheduleFixture.refresh())
  for (const text of ["Fresh task", "Fresh assignment", "Fresh baseline", "Dependency lag: 5", "View: list", "Range: 2027-01-01T00:00:00.000Z"]) await expect(page.getByText(text, { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Edit task" }).click()
  await expect(page.getByText("Edited task", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Edit dependency" }).click()
  await page.evaluate(() => window.scheduleFixture.refresh())
  await expect(page.getByText("Fresh task", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Edit task" }).click()
  await expect(page.getByText("Loading: true", { exact: true })).toBeVisible()
  await page.evaluate(() => { window.scheduleWrites[0].resolve("Stale task result"); window.scheduleWrites[1].resolve() })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await expect(page.getByText("Edited task", { exact: true })).toBeVisible()
  await expect(page.getByText("Stale task result", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Dependency lag: 5", { exact: true })).toBeVisible()
  await expect(page.getByText("Loading: true", { exact: true })).toBeVisible()
  await page.evaluate(() => window.scheduleWrites.at(-1).resolve())
  await expect(page.getByText("Edited task", { exact: true })).toBeVisible()
  await expect(page.getByText("Loading: false", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Edit task" }).click()
  await page.evaluate(() => window.scheduleFixture.refresh())
  await page.evaluate(() => window.scheduleWrites.at(-1).fail())
  await expect(page.getByText("Fresh task", { exact: true })).toBeVisible()
  await expect(page.getByText("Error: none", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Edit task" }).click()
  await page.getByRole("button", { name: "Edit dependency" }).click()
  await page.evaluate(() => window.scheduleWrites.at(-1).resolve())
  await expect(page.getByText("Dependency lag: 9", { exact: true })).toBeVisible()
  await expect(page.getByText("Loading: true", { exact: true })).toBeVisible()
  await page.evaluate(() => window.scheduleWrites.at(-2).resolve())
  await expect(page.getByText("Loading: false", { exact: true })).toBeVisible()
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  console.log("Schedule refresh adopts all server rows, preserves view and range, and ignores stale write results")
} finally { await browser?.close(); server.stop(true) }
