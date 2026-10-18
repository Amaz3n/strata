import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { chromium, expect } from "@playwright/test"
import babel from "next/dist/compiled/babel/core.js"
import compiler from "babel-plugin-react-compiler"

const built = await Bun.build({
  entrypoints: ["tests/fixtures/payroll-intake-lifecycle/ui.jsx"], target: "browser",
  define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
  plugins: [{ name: "intake-lifecycle", setup(builder) {
    builder.onLoad({ filter: /payroll-register-intake\.tsx$/ }, async ({ path }) => ({ loader: "tsx", contents: babel.transformSync(await readFile(process.env.PAYROLL_INTAKE_SOURCE ?? path, "utf8"), { filename: path, configFile: false, babelrc: false, parserOpts: { plugins: ["typescript", "jsx"] }, plugins: [[compiler, { target: "19" }]] }).code }))
    builder.onResolve({ filter: /time\/payroll\/actions$/ }, () => ({ path: "actions", namespace: "fixture" }))
    builder.onLoad({ filter: /^actions$/, namespace: "fixture" }, () => ({ loader: "js", contents: 'function action(kind,args){return new Promise((resolve,reject)=>(window.intakeActions??=[]).push({kind,args,resolve,reject}))}export const prepareProjectPayrollUploadAction=(...args)=>action("prepare",args);export const inspectProjectPayrollUploadAction=(...args)=>action("inspect",args);export const loadProjectPayrollWorkersAction=(...args)=>action("workers",args);export const previewProjectPayrollWorkerLaborAction=(...args)=>action("labor",args);' }))
  } }],
})
assert.ok(built.success, built.logs.join("\n"))
const bundle = await built.outputs[0].text()
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/bundle.js" ? new Response(bundle, { headers: { "content-type": "text/javascript" } }) : new Response('<html><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>', { headers: { "content-type": "text/html" } }) })
let browser
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage(), errors = [], blocked = [], origin = `http://127.0.0.1:${server.port}`
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : (blocked.push(route.request().url()), route.abort()))
  const uploadButton = () => page.getByRole("button", { name: /Upload original privately|Verify original again|Verifying…/ })
  const verify = () => page.getByRole("button", { name: "Verify provider controls", exact: true })
  async function open() { await page.goto("about:blank"); await page.goto(origin); await expect(page.getByRole("heading", { name: "Import a provider register", exact: true })).toBeVisible() }
  async function choose(name = "provider.csv") { await page.getByLabel("Original provider CSV").setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from("original provider fixture") }) }
  async function count(n) { await expect.poll(() => page.evaluate(() => window.intakeActions?.length ?? 0)).toBe(n) }
  async function prepare(index) { await page.evaluate(index => window.intakeActions[index].resolve({ success: true, data: { uploadUrl: "/private-upload", headers: { "x-fixture": "private" } } }), index); await expect.poll(() => page.evaluate(() => window.intakeUploads?.length ?? 0)).toBeGreaterThan(0) }
  async function uploaded() {
    await open(); await choose(); await uploadButton().click(); await count(1); await prepare(0)
    await page.evaluate(() => window.intakeUploads[0].resolve(200)); await count(2)
    await page.evaluate(() => window.intakeActions[1].resolve({ success: true, data: window.intakeFixture.inspection }))
    await expect(verify()).toBeEnabled()
  }
  async function mapped() {
    await uploaded(); await page.getByRole("button", { name: "Map native workers", exact: true }).click(); await count(3)
    await page.evaluate(() => window.intakeActions[2].resolve({ success: true, data: window.intakeFixture.workers }))
    await page.getByLabel("Native worker for employee-one", { exact: true }).selectOption("worker")
  }

  // Invalid files never reach an upload action, and a valid selection can retry.
  await open(); await choose("provider.txt"); await uploadButton().click()
  await expect(page.getByRole("alert")).toContainText("Choose a CSV between 1 byte and 16 MiB")
  assert.equal(await page.evaluate(() => window.intakeActions?.length ?? 0), 0)
  await choose(); await expect(page.getByRole("alert")).toHaveCount(0)
  await expect(uploadButton()).toBeEnabled()

  // Leaving while the file is read must not allocate or prepare a private upload.
  await page.evaluate(() => { File.prototype.arrayBuffer = () => new Promise(resolve => { window.finishFileRead = resolve }) })
  await uploadButton().click(); await expect.poll(() => page.evaluate(() => typeof window.finishFileRead)).toBe("function")
  await page.evaluate(() => window.intakeFixture.unmount()); await expect(page.getByText("Intake removed")).toBeVisible()
  await page.evaluate(() => window.finishFileRead(new TextEncoder().encode("fixture").buffer))
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => window.intakeActions?.length ?? 0), 0)

  // Leaving during upload preparation must not start a private PUT or inspection.
  await open(); await choose(); await uploadButton().click(); await count(1)
  await page.evaluate(() => window.intakeFixture.unmount()); await expect(page.getByText("Intake removed")).toBeVisible()
  await page.evaluate(() => window.intakeActions[0].resolve({ success: true, data: { uploadUrl: "/private-upload", headers: {} } }))
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => window.intakeUploads?.length ?? 0), 0, "an obsolete preparation reply must not upload the original")
  assert.equal(await page.evaluate(() => window.intakeActions.length), 1)

  // Cancel the actual upload when the editor unmounts.
  await open(); await choose(); await uploadButton().click(); await count(1); await prepare(0)
  assert.equal(await page.evaluate(() => window.intakeUploads[0].options.credentials), "omit")
  await page.evaluate(() => window.intakeFixture.unmount()); await expect(page.getByText("Intake removed")).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.intakeUploads[0].aborted)).toBe(true)
  assert.equal(await page.evaluate(() => window.intakeActions.length), 1)

  // Retry uses the same immutable file identity and accepts an already uploaded original.
  await open(); await choose()
  await uploadButton().evaluate(button => { button.click(); button.click() }); await count(1)
  const original = await page.evaluate(() => window.intakeActions[0].args[0])
  await prepare(0); await page.evaluate(() => window.intakeUploads[0].resolve(503))
  await expect(page.getByRole("alert")).toContainText("retry to resume this original")
  await uploadButton().click(); await count(2)
  assert.deepEqual(await page.evaluate(() => window.intakeActions[1].args[0]), original)
  await prepare(1); await expect.poll(() => page.evaluate(() => window.intakeUploads.length)).toBe(2)
  await page.evaluate(() => window.intakeUploads[1].resolve(412)); await count(3)
  await page.evaluate(() => window.intakeActions[2].resolve({ success: true, data: window.intakeFixture.inspection }))
  await expect(verify()).toBeEnabled()

  // Verification failures unlock the form without discarding the selected columns.
  await verify().click(); await count(4)
  await page.evaluate(() => window.intakeActions[3].reject(new Error("Controls unavailable")))
  await expect(page.getByRole("alert")).toContainText("Controls unavailable")
  await expect(page.getByLabel("Gross pay", { exact: true })).toHaveValue("gross")
  await verify().click(); await count(5)
  await page.evaluate(() => window.intakeActions[4].resolve({ success: true, data: window.intakeFixture.inspection }))
  await expect(verify()).toBeEnabled()

  // Worker pagination deduplicates the list and preserves the employee assignment.
  await mapped(); await page.getByRole("button", { name: "Load more workers", exact: true }).click(); await count(4)
  assert.equal(await page.evaluate(() => window.intakeActions[3].args[0].cursor), "older")
  await page.evaluate(() => window.intakeActions[3].resolve({ success: true, data: { workers: [{ ...window.intakeFixture.workers.workers[0], name: "Updated worker" }], nextCursor: null } }))
  await expect(page.getByLabel("Native worker for employee-one", { exact: true })).toHaveValue("worker")
  await expect(page.getByRole("option", { name: /Updated worker/ })).toHaveCount(1)
  await page.getByRole("button", { name: "Find recognized labor", exact: true }).click(); await count(5)
  await page.evaluate(() => window.intakeActions[4].resolve({ success: true, data: window.intakeFixture.labor }))
  await expect(page.getByLabel("Recognized native labor", { exact: true })).toBeVisible()
  await verify().click(); await count(6)
  await page.evaluate(() => window.intakeActions[5].resolve({ success: true, data: window.intakeFixture.inspection }))
  await expect(verify()).toBeEnabled()
  await expect(page.getByLabel("Recognized native labor", { exact: true })).toHaveCount(0)
  await expect(page.getByLabel("Native worker for employee-one", { exact: true })).toHaveValue("worker")
  await page.getByLabel("Amount units", { exact: true }).selectOption("cents")
  await expect(page.getByLabel("Native worker mapping", { exact: true })).toHaveCount(0)

  // A project switch mounts a clean editor; old preparation cannot upload into it.
  await open(); await choose(); await uploadButton().click(); await count(1)
  await page.evaluate(() => window.intakeFixture.changeProject("project-two"))
  await expect(uploadButton()).toBeDisabled()
  await page.evaluate(() => window.intakeActions[0].resolve({ success: true, data: { uploadUrl: "/private-upload", headers: {} } }))
  await page.waitForTimeout(100); assert.equal(await page.evaluate(() => window.intakeUploads?.length ?? 0), 0)
  await choose(); await uploadButton().click(); await count(2)
  assert.equal(await page.evaluate(() => window.intakeActions[1].args[0].projectId), "project-two")

  // Late failures and inspection/worker/labor replies are silent after unmounting.
  for (const kind of ["prepare", "inspect", "workers", "labor"]) {
    for (const reject of [false, true]) {
      if (kind === "prepare") { await open(); await choose(); await uploadButton().click(); await count(1) }
      else if (kind === "inspect") { await uploaded(); await verify().click(); await count(3) }
      else if (kind === "workers") { await uploaded(); await page.getByRole("button", { name: "Map native workers", exact: true }).click(); await count(3) }
      else { await mapped(); await page.getByRole("button", { name: "Find recognized labor", exact: true }).click(); await count(4) }
      const before = await page.evaluate(() => window.intakeActions.length)
      await page.evaluate(() => window.intakeFixture.unmount()); await expect(page.getByText("Intake removed")).toBeVisible()
      await page.evaluate(({ kind, reject }) => {
        const request = window.intakeActions.at(-1)
        if (reject) request.reject(new Error("Obsolete intake reply"))
        else request.resolve({ success: true, data: kind === "prepare" ? { uploadUrl: "/private-upload", headers: {} } : window.intakeFixture[kind === "inspect" ? "inspection" : kind] })
      }, { kind, reject })
      await page.waitForTimeout(100); assert.equal(await page.evaluate(() => window.intakeActions.length), before)
      await expect(page.getByRole("alert")).toHaveCount(0)
    }
  }
  assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  console.log("Payroll intake: canceled uploads, obsolete preparation guards, stable retries, exclusive submits, verification recovery, worker pagination, and preview invalidation passed")
} finally { await browser?.close(); server.stop(true) }
