import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { chromium, expect } from "@playwright/test"
import babel from "next/dist/compiled/babel/core.js"
import compiler from "babel-plugin-react-compiler"
const built = await Bun.build({ entrypoints: ["tests/fixtures/reviewer-rfi-refresh/ui.jsx"], target: "browser", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "reviewer-rfi-refresh", setup(builder) {
  builder.onLoad({ filter: /reviewer-rfis-tab\.tsx$/ }, async ({ path }) => ({ loader: "tsx", contents: babel.transformSync(await readFile(path, "utf8"), { filename: path, configFile: false, babelrc: false, parserOpts: { plugins: ["typescript", "jsx"] }, plugins: [[compiler, { target: "19" }]] }).code }))
  builder.onResolve({ filter: /^\.\/actions$/ }, args => args.importer.includes("/app/r/") ? { path: "actions", namespace: "fixture" } : undefined)
  builder.onLoad({ filter: /^actions$/, namespace: "fixture" }, () => ({ loader: "js", contents: 'export async function addReviewerRfiResponseAction(){throw Error("No business writes allowed")} export function listReviewerRfiResponsesAction(token,id){return new Promise(resolve=>(window.reviewerReads??=[]).push({token,id,resolve}))}' }))
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
  const draft = page.getByPlaceholder("Type your response...")
  await page.goto(origin)
  await page.getByRole("button", { name: "View & Respond" }).first().click()
  await expect.poll(() => page.evaluate(() => window.reviewerReads?.length)).toBe(1)
  await page.evaluate(() => window.reviewerFixture.resolve(0, "Initial response"))
  await expect(draft).toBeEnabled()
  await draft.fill("Unsubmitted reviewer draft")
  await page.evaluate(() => window.reviewerFixture.refresh())
  await expect(page.getByRole("dialog").getByRole("heading", { name: "RFI #1: Updated First RFI" })).toBeVisible()
  await expect(draft).toHaveValue("Unsubmitted reviewer draft")
  assert.equal(await page.evaluate(() => window.reviewerReads.length), 1, "same-RFI row refresh must not reread the response thread")
  await page.evaluate(() => window.reviewerFixture.empty())
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByText("No RFIs routed to you")).toBeVisible()
  for (const order of ["old-first", "current-first", "same-rfi"]) {
    await page.goto(origin)
    await page.getByRole("button", { name: "View & Respond" }).first().click()
    await expect.poll(() => page.evaluate(() => window.reviewerReads?.length)).toBe(1)
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "View & Respond" }).nth(order === "same-rfi" ? 0 : 1).click()
    await expect.poll(() => page.evaluate(() => window.reviewerReads.length)).toBe(2)
    await expect(draft).toBeDisabled()
    if (order === "old-first") {
      await page.evaluate(() => window.reviewerFixture.resolve(0, "Old response"))
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await expect(draft).toBeDisabled()
      await expect(page.getByText("Old response", { exact: true })).toHaveCount(0)
    }
    await page.evaluate(() => window.reviewerFixture.resolve(1, "Current response"))
    await expect(page.getByText("Current response", { exact: true })).toBeVisible()
    await expect(draft).toBeEnabled()
    if (order !== "old-first") {
      await page.evaluate(() => window.reviewerFixture.resolve(0, "Old response"))
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await expect(page.getByText("Current response", { exact: true })).toBeVisible()
      await expect(page.getByText("Old response", { exact: true })).toHaveCount(0)
    }
  }
  await draft.fill("Private reviewer draft")
  await page.evaluate(() => window.reviewerFixture.switchPortal())
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await page.getByRole("button", { name: "View & Respond" }).first().click()
  await expect.poll(() => page.evaluate(() => window.reviewerReads.length)).toBe(3)
  await page.evaluate(() => window.reviewerFixture.resolve(2, "New portal response"))
  await expect(draft).toBeEnabled()
  await expect(draft).toHaveValue("")
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  console.log("Reviewer RFIs adopt refreshed rows, preserve drafts, discard stale threads, and reset portal identity")
} finally { await browser?.close(); server.stop(true) }
