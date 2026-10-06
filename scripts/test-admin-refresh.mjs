import assert from "node:assert/strict"
import { chromium, expect } from "@playwright/test"
import { readFile } from "node:fs/promises"
import babel from "next/dist/compiled/babel/core.js"
import compiler from "babel-plugin-react-compiler"

const actions = `window.refreshes=0;window.actionCalls=[];
async function call(name,args){window.actionCalls.push([name,args]);return new Promise(resolve=>{window.finishAction=(ok=true)=>resolve(ok?{success:true,data:{message:'Saved',queued:1,failed:0}}:{success:false,error:'Fixture rejected'})})}
export const decidePaymentRunAction=(...args)=>call('decide',args);
export const cancelPaymentRunAction=(...args)=>call('cancel',args);
export const retryPaymentRunReleaseAction=(...args)=>call('retry',args);
export const syncPaymentRunItemsAction=(...args)=>call('sync',args);
export const createPlanAction=(...args)=>call('create',args);
export const deletePlanAction=(...args)=>call('delete',args);
export const deleteOrganizationAction=(...args)=>call('delete-org',args);`
const built = await Bun.build({ entrypoints: ["tests/fixtures/admin-refresh/ui.jsx"], target: "browser", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "isolated-admin", setup(builder) {
  builder.onLoad({ filter: /(subscription-plans-client|customers-table|customer-sheet|payment-run-actions-panel)\.tsx$/ }, async ({ path }) => ({ loader: "tsx", contents: babel.transformSync(await readFile(path, "utf8"), { filename: path, configFile: false, babelrc: false, parserOpts: { plugins: ["typescript", "jsx"] }, plugins: [[compiler, { target: "19" }]] }).code }))
  builder.onResolve({ filter: /admin\/(customers|subscription-plans)\/actions|payables\/payment-runs\/actions/ }, () => ({ path: "actions", namespace: "fixture" }))
  builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "router", namespace: "fixture" }))
  builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }))
  builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ loader: "jsx", contents: path === "actions" ? actions : path === "router"
    ? "const router={refresh:()=>window.refreshes++,push:()=>{}};export function useRouter(){return router}export function useSearchParams(){return new URLSearchParams()}"
    : "export default function Link({children,prefetch,scroll,...props}){return <a {...props}>{children}</a>}" }))
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
  await page.goto(origin)
  await page.evaluate(() => window.documentMarker = "same-document")
  await page.getByRole("button", { name: "Approve", exact: true }).click()
  await expect(page.getByRole("button", { name: "Sync all", exact: true })).toBeDisabled()
  assert.equal(await page.evaluate(() => window.refreshes), 0)
  await page.evaluate(() => window.finishAction())
  await expect.poll(() => page.evaluate(() => window.refreshes)).toBe(1)
  assert.equal(await page.evaluate(() => window.documentMarker), "same-document")
  await page.getByRole("button", { name: "Retry release", exact: true }).click()
  await page.evaluate(() => window.finishAction(false))
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled()
  assert.equal(await page.evaluate(() => window.refreshes), 1)
  await page.getByRole("button", { name: "Sync all", exact: true }).click()
  await page.evaluate(() => window.finishAction())
  await expect.poll(() => page.evaluate(() => window.refreshes)).toBe(2)

  await page.goto(`${origin}?kind=plans`)
  await expect(page.getByText("Fixture plan", { exact: true })).toBeVisible()
  await page.getByPlaceholder("Search plans...").fill("Updated")
  await page.evaluate(() => window.adminFixture.refreshPlans())
  await expect(page.getByText("Updated plan", { exact: true })).toBeVisible()
  await expect(page.getByPlaceholder("Search plans...")).toHaveValue("Updated")

  await page.goto(`${origin}?kind=customers`)
  await page.getByPlaceholder("Search customers...").fill("Unsaved search")
  await page.evaluate(() => window.adminFixture.refreshCustomer())
  await expect(page.getByPlaceholder("Search customers...")).toHaveValue("Unsaved search")
  await page.evaluate(() => window.adminFixture.restoreSearch())
  await expect(page.getByPlaceholder("Search customers...")).toHaveValue("Restored")
  await page.getByRole("button", { name: "Actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "View Details", exact: true }).click()
  const sheet = page.getByRole("dialog")
  await expect(sheet.getByText("Updated customer", { exact: true }).first()).toBeVisible()
  await page.evaluate(() => window.adminFixture.refreshCustomer())
  await expect(sheet.getByText("Updated customer", { exact: true }).first()).toBeVisible()
  await sheet.getByRole("button", { name: "Edit", exact: true }).click()
  await sheet.getByRole("textbox").first().fill("Edited customer")
  await sheet.getByRole("button", { name: "Save Changes", exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.refreshes)).toBe(1)
  assert.equal(await page.evaluate(() => window.savedCustomer.name), "Edited customer")
  await expect(sheet).toBeVisible()
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  console.info("Payment success/failure/pending, plan prop refresh with filter retention, and customer sheet refresh/save passed; no backend requests.")
} finally { await browser?.close(); server.stop(true) }
