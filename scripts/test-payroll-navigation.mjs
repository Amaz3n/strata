import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { chromium, expect } from "@playwright/test"
import babel from "next/dist/compiled/babel/core.js"
import compiler from "babel-plugin-react-compiler"

const actions = `
window.payrollCalls=[];window.payrollPushes=[];window.payrollRefreshes=0;
export async function updateCertifiedPayrollLineAction(...args) {
 window.payrollCalls.push(args);
 return new Promise(resolve=>{window.releasePayrollUpdate=()=>resolve({success:true,data:null})});
}
export async function createCertifiedPayrollAction(){return {success:true,data:{id:'report-three',payroll_number:3}}}
export async function finalizeCertifiedPayrollAction(){return {success:true,data:null}}
export async function certifiedPayrollRegisterCsvAction(){return {success:true,data:''}}
export async function createWageClassificationAction(){return {success:true,data:null}}
export async function createWageDeterminationAction(){return {success:true,data:null}}
export async function savePayrollWorkerProfileAction(){return {success:true,data:null}}
`
let compiled = false
const built = await Bun.build({ entrypoints: ["tests/fixtures/payroll-navigation/ui.jsx"], target: "browser", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "isolated-payroll", setup(builder) {
  builder.onLoad({ filter: /certified-payroll-client\.tsx$/ }, async ({ path }) => {
    const result = babel.transformSync(await readFile(path, "utf8"), { filename: path, configFile: false, babelrc: false, parserOpts: { plugins: ["typescript", "jsx"] }, plugins: [[compiler, { target: "19", logger: { logEvent(file, event) {
      assert.notEqual(event.kind, "CompileError", `Compiler skipped ${file}: ${event.detail?.reason}`)
      if (event.kind === "CompileSuccess") compiled = true
    } } }]] })
    return { contents: result.code, loader: "tsx" }
  })
  builder.onResolve({ filter: /^\.\/actions$/ }, args => args.importer.endsWith("certified-payroll-client.tsx") ? { path: "actions", namespace: "fixture" } : undefined)
  builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "router", namespace: "fixture" }))
  // This fixture checks the actual report UI and its server-prop updates.
  // The native Next Link/history contract has a separate production fixture.
  builder.onResolve({ filter: /navigation\/optimistic-pathname$/ }, () => ({ path: "link", namespace: "fixture" }))
  builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ loader: "jsx", contents: path === "actions" ? actions : path === "router"
    ? "const router={push:(href,options)=>window.payrollPushes.push({href,options}),refresh:()=>window.payrollRefreshes++};export function useRouter(){return router}"
    : "export function OptimisticLink({scroll,children,...props}){return <a {...props}>{children}</a>}" }))
} }] })
assert.ok(built.success, built.logs.join("\n"))
assert.ok(compiled, "The actual payroll client must compile")
const bundle = await built.outputs[0].text()
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/bundle.js"
  ? new Response(bundle, { headers: { "content-type": "text/javascript" } })
  : new Response('<html><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>', { headers: { "content-type": "text/html" } }) })
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
  await expect(page.getByRole("heading", { name: "Payroll #1", exact: true })).toBeVisible()
  const reportLink = page.getByRole("link", { name: /Payroll #2/ })
  await expect(reportLink).toHaveAttribute("href", "/projects/project-one/time/certified-payroll?report=report-two")
  const amount = () => page.getByRole("row").filter({ hasText: "Fixture worker" }).getByRole("textbox").first()
  await expect(amount()).toHaveValue("100.00")
  await amount().focus(); await amount().blur()
  assert.deepEqual(await page.evaluate(() => window.payrollCalls), [], "An unchanged field must not write")
  await amount().fill("120.00"); await amount().blur()
  await expect(page.getByRole("button", { name: "Draft report", exact: true })).toBeDisabled()
  assert.deepEqual(await page.evaluate(() => window.payrollCalls[0]), ["project-one", "line-one", { gross_all_projects_cents: 12000 }])
  await page.evaluate(() => window.releasePayrollUpdate())
  await expect(page.getByRole("button", { name: "Draft report", exact: true })).toBeEnabled()
  await page.evaluate(() => window.payrollFixture.refreshMoney())
  await expect(amount()).toHaveValue("150.00")
  await page.evaluate(() => window.payrollFixture.second())
  await expect(page.getByRole("heading", { name: "Payroll #2", exact: true })).toBeVisible()
  await expect(reportLink).toHaveAttribute("aria-current", "page")
  await page.evaluate(() => window.payrollFixture.finalize())
  await expect(page.getByRole("button", { name: "Finalize & create PDF", exact: true })).toHaveCount(0)
  await expect(amount()).toBeDisabled()
  await page.locator('input[name="week_ending"]').fill("2026-10-16")
  await page.getByRole("button", { name: "Draft report", exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.payrollPushes)).toEqual([{ href: "/projects/project-one/time/certified-payroll?report=report-three", options: { scroll: false } }])
  assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  console.info("Payroll server refresh, report identity, pending saves, unchanged-field guards, finalized state, and new-report navigation passed; zero backend requests.")
} finally { await browser?.close(); server.stop(true) }
