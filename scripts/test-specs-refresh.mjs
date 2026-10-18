import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { chromium, expect } from "@playwright/test"
import babel from "next/dist/compiled/babel/core.js"
import compiler from "babel-plugin-react-compiler"

const actions = `window.specsCalls=[];window.specsRefreshes=0;
export function listSpecUploadsAction(project){window.specsCalls.push(project);return new Promise(resolve=>window.finishSpecPoll=data=>resolve({success:true,data}))}
export async function getSpecSectionAction(){throw Error('Unexpected section read')}
export async function createManualSpecSectionAction(){throw Error('No writes allowed')}
export async function createSpecUploadAction(){throw Error('No writes allowed')}
export async function uploadProjectFileAction(){throw Error('No writes allowed')}`
const built = await Bun.build({ entrypoints: ["tests/fixtures/specs-refresh/ui.jsx"], target: "browser", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "isolated-specs", setup(builder) {
  builder.onLoad({ filter: /specs-register-client\.tsx$/ }, async ({ path }) => ({ loader: "tsx", contents: babel.transformSync(await readFile(path, "utf8"), { filename: path, configFile: false, babelrc: false, parserOpts: { plugins: ["typescript", "jsx"] }, plugins: [[compiler, { target: "19" }]] }).code }))
  builder.onResolve({ filter: /projects\/\[id\]\/(specs\/)?actions$/ }, () => ({ path: "actions", namespace: "fixture" }))
  builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "router", namespace: "fixture" }))
  builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }))
  builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ loader: "jsx", contents: path === "actions" ? actions : path === "router" ? "const router={refresh:()=>window.specsRefreshes++};export function useRouter(){return router}" : "export default function Link({children,...props}){return <a {...props}>{children}</a>}" }))
} }] })
assert.ok(built.success, built.logs.join("\n"))
const bundle = await built.outputs[0].text()
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/bundle.js" ? new Response(bundle, { headers: { "content-type": "text/javascript" } }) : new Response('<html><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>', { headers: { "content-type": "text/html" } }) })
let browser
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage(), errors = [], blocked = []
  const origin = `http://127.0.0.1:${server.port}`
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : (blocked.push(route.request().url()), route.abort()))
  await page.clock.install()
  await page.goto(origin)
  await expect(page.getByText("Original section", { exact: true })).toBeVisible()
  await page.clock.fastForward(5000)
  assert.deepEqual(await page.evaluate(() => window.specsCalls), ["project"])
  await page.clock.fastForward(10000)
  assert.equal(await page.evaluate(() => window.specsCalls.length), 1, "Polls must not overlap")
  await page.evaluate(() => window.finishSpecPoll(window.specsFixture.processing))
  await expect(page.getByText("Splitting sections", { exact: true })).toBeVisible()
  assert.equal(await page.evaluate(() => window.specsRefreshes), 0, "An old completed upload must not refresh")
  await page.clock.fastForward(5000)
  await page.evaluate(() => window.finishSpecPoll(window.specsFixture.completed))
  await expect.poll(() => page.evaluate(() => window.specsRefreshes)).toBe(1)
  await page.getByRole("textbox").first().fill("Updated")
  await page.evaluate(() => window.specsFixture.fresh())
  await expect(page.getByText("Updated section", { exact: true })).toBeVisible()
  await expect(page.getByRole("textbox").first()).toHaveValue("Updated")
  const calls = await page.evaluate(() => window.specsCalls.length)
  await page.clock.fastForward(15000)
  assert.equal(await page.evaluate(() => window.specsCalls.length), calls, "Completed uploads stop polling")
  await page.reload()
  await expect(page.getByText("Original section", { exact: true })).toBeVisible()
  await page.clock.fastForward(5000)
  await page.evaluate(() => window.specsFixture.switchProject())
  await expect(page.getByText("Original section", { exact: true })).toHaveCount(0)
  await page.evaluate(() => window.finishSpecPoll(window.specsFixture.completed))
  assert.equal(await page.evaluate(() => window.specsRefreshes), 0, "An unmounted project ignores late polls")
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  console.info("Compiled specification polling, completion refresh, fresh section props, search retention, and unmounted-project cancellation passed; no backend requests.")
} finally { await browser?.close(); server.stop(true) }
