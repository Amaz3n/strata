import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { chromium, expect } from "@playwright/test"
import babel from "next/dist/compiled/babel/core.js"
import compiler from "babel-plugin-react-compiler"
let compiled = 0
const built = await Bun.build({ entrypoints: ["tests/fixtures/import-navigation/ui.jsx"], target: "browser", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "import-fixture-navigation", setup(builder) {
  builder.onLoad({ filter: /components\/admin\/import-workspace\.tsx$/ }, async ({ path }) => {
    const result = babel.transformSync(await readFile(path, "utf8"), { filename: path, configFile: false, babelrc: false, parserOpts: { plugins: ["typescript", "jsx"] }, plugins: [[compiler, { target: "19", logger: { logEvent(_file, event) {
      if (event.kind === "CompileSuccess") compiled++
      if (event.kind === "CompileError") assert.equal(event.detail?.options?.reason, "Use of incompatible library", "Only the isolated virtualizer may be skipped")
    } } }]] })
    return { contents: result.code, loader: "tsx" }
  })
  builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "router", namespace: "fixture" }))
  builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }))
  builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ loader: "jsx", contents: path === "router"
    ? "window.importPushes=[];window.importRefreshes=0;const router={push:(href,options)=>{window.importPushes.push({href,options});window.importFixture.showBatch(new URL(href,location.origin).searchParams.get('batch'))},refresh:()=>window.importRefreshes++};export function useRouter(){return router}"
    : "export default function Link({children,...props}){return <a {...props}>{children}</a>}" }))
} }] })
assert.ok(built.success, built.logs.join("\n"))
assert.ok(compiled >= 2, "The workspace and its session must both compile")
const bundle = await built.outputs[0].text()
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/bundle.js"
  ? new Response(bundle, { headers: { "content-type": "text/javascript" } })
  : new Response('<html><head><style>[aria-label="Staged import rows"]{height:480px;overflow:auto}[aria-label="Staged import rows"]>div>div{position:absolute;top:0;left:0;width:100%;display:grid}</style></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>', { headers: { "content-type": "text/html" } }) })
let browser
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const origin = `http://127.0.0.1:${server.port}`, errors = [], blocked = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin === origin) return route.continue()
    blocked.push(route.request().url()); return route.abort()
  })
  await page.goto(origin)
  await expect(page.getByRole("tab", { name: "Upload", exact: true })).toHaveAttribute("data-state", "active")
  await page.locator('input[type="file"]').setInputFiles({ name: "fixture.csv", mimeType: "text/csv", buffer: Buffer.from("Name\nFixture contact\n") })
  await expect(page.getByRole("tab", { name: "Map", exact: true })).toHaveAttribute("data-state", "active")
  await page.getByRole("button", { name: "Stage & validate", exact: true }).click()
  await expect(page.getByRole("tab", { name: "Review", exact: true })).toHaveAttribute("data-state", "active")
  assert.deepEqual(await page.evaluate(() => window.importPushes), [{ href: "/?batch=batch-one", options: { scroll: false } }])
  assert.equal(await page.evaluate(() => window.importRefreshes), 0, "The navigation must not start a duplicate refresh")
  assert.equal((await page.evaluate(() => window.stagedImportInput)).mapping.name, "Name")
  await page.getByRole("tab", { name: "Upload", exact: true }).click()
  await page.evaluate(() => window.importFixture.showBatch("batch-two"))
  await expect(page.getByRole("tab", { name: "Review", exact: true })).toHaveAttribute("data-state", "active")
  await expect(page.getByRole("button", { name: "500 rows", exact: true })).toBeVisible()
  await expect(page.getByText("Fixture row 500", { exact: true })).toHaveCount(0)
  await page.getByLabel("Staged import rows", { exact: true }).evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect(page.getByText("Fixture row 500", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "1 warnings", exact: true }).click()
  await expect(page.getByText("Fixture row 2", { exact: true })).toBeVisible()
  await expect(page.getByText("Fixture row 500", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("tab", { name: "Map", exact: true })).toBeDisabled()
  await page.getByRole("tab", { name: "Upload", exact: true }).click()
  await page.evaluate(() => window.importFixture.changeOrg())
  await expect(page.getByRole("tab", { name: "Review", exact: true })).toHaveAttribute("data-state", "active")
  await page.evaluate(() => window.importFixture.clear())
  await expect(page.getByRole("tab", { name: "Upload", exact: true })).toHaveAttribute("data-state", "active")
  await expect(page.getByRole("tab", { name: "Review", exact: true })).toBeDisabled()
  assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  console.info("Import staging navigation, mapping payload, batch/org state resets, and return-to-upload passed; zero backend requests.")
} finally { await browser?.close(); server.stop(true) }
