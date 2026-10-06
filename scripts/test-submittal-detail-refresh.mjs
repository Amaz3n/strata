import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { chromium, expect } from "@playwright/test"
import babel from "next/dist/compiled/babel/core.js"
import compiler from "babel-plugin-react-compiler"
const writes = ["addSubmittalItemAction", "decideSubmittalAction", "resubmitSubmittalAction", "updateSubmittalAction", "decideSubmittalReviewStepAction", "updateSubmittalReviewStepAction", "detachFileLinkAction", "attachFileAction", "uploadDocumentForm"]
const reads = ["listAttachmentsAction", "listSubmittalItemsAction", "listSubmittalReviewStepsAction", "listSubmittalRevisionsAction"]
const actions = "window.pendingSubmittalReads={};export async function listContactsAction(){return []}" + writes.map(name => `export async function ${name}(){throw Error('No backend writes allowed')}`).join("\n") + reads.map(name => `export async function ${name}(){return new Promise(resolve=>(window.pendingSubmittalReads['${name}']??=[]).push(resolve))}`).join("\n")
const built = await Bun.build({ entrypoints: ["tests/fixtures/submittal-detail-refresh/ui.jsx"], target: "browser", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "submittal-detail-fixture", setup(builder) {
  builder.onLoad({ filter: /(submittal-detail-sheet|submittal-review-rail)\.tsx$/ }, async ({ path }) => ({ loader: "tsx", contents: babel.transformSync(await readFile(path, "utf8"), { filename: path, configFile: false, babelrc: false, parserOpts: { plugins: ["typescript", "jsx"] }, plugins: [[compiler, { target: "19" }]] }).code }))
  builder.onResolve({ filter: /submittals\/actions$|contacts\/actions$|documents\/actions$|files\/upload-document-form$/ }, () => ({ path: "actions", namespace: "fixture" }))
  builder.onLoad({ filter: /^actions$/, namespace: "fixture" }, () => ({ loader: "js", contents: actions }))
  builder.onResolve({ filter: /^@\/components\/(files|drawings)$/ }, ({ path }) => ({ path, namespace: "fixture" }))
  builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "jsx", contents: "export function LinkedDrawings(){return null}export function EntityAttachments({attachments=[],readOnly=false}){return <div aria-label='Attachments' data-read-only={String(readOnly)}>{attachments.map(file=><span key={file.id}>{file.file_name}</span>)}</div>}" }))
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
  for (const name of reads) await expect.poll(() => page.evaluate(name => window.pendingSubmittalReads[name]?.length ?? 0, name)).toBe(1)
  await page.evaluate(() => window.submittalFixture.refresh())
  for (const name of reads) await expect.poll(() => page.evaluate(name => window.pendingSubmittalReads[name]?.length ?? 0, name)).toBe(2)
  await page.evaluate(() => {
    window.pendingSubmittalReads.listAttachmentsAction[1]([{id:"current-link",file:{id:"current",file_name:"Current submittal file"}}])
    window.pendingSubmittalReads.listSubmittalItemsAction[1]([{id:"current",item_number:1,description:"Current submitted item"}])
    window.pendingSubmittalReads.listSubmittalReviewStepsAction[1]([{id:"current",step_order:1,status:"returned",reviewer_kind:"internal",notes:"Current review note"}])
    window.pendingSubmittalReads.listSubmittalRevisionsAction[1]([{id:"current",revision:4,status:"approved"}])
  })
  for (const text of ["Current submittal file", "Current submitted item", "Current review note", "Rev 4"]) await expect(page.getByText(text, {exact:true})).toBeVisible()
  await page.evaluate(() => { for (const list of Object.values(window.pendingSubmittalReads)) list[0]([]) })
  for (const text of ["Current submittal file", "Current submitted item", "Current review note", "Rev 4"]) await expect(page.getByText(text, {exact:true})).toBeVisible()
  await page.getByRole("button", {name:"Add item",exact:true}).click()
  const draft = page.getByPlaceholder("Item description (e.g. Trane XR14 condenser data sheet)")
  await draft.fill("Unsubmitted item")
  await page.evaluate(() => window.submittalFixture.refresh())
  for (const name of reads) await expect.poll(() => page.evaluate(name => window.pendingSubmittalReads[name]?.length ?? 0, name)).toBe(3)
  await page.evaluate(() => window.submittalFixture.refresh())
  for (const name of reads) await expect.poll(() => page.evaluate(name => window.pendingSubmittalReads[name]?.length ?? 0, name)).toBe(4)
  await expect(draft).toHaveValue("Unsubmitted item")
  await page.evaluate(() => {
    window.pendingSubmittalReads.listAttachmentsAction[2]([{id:"stale-link",file:{id:"stale",file_name:"Stale submittal file"}}])
    window.pendingSubmittalReads.listSubmittalItemsAction[2]([{id:"stale",item_number:1,description:"Stale submitted item"}])
    window.pendingSubmittalReads.listSubmittalReviewStepsAction[2]([{id:"stale",step_order:1,status:"returned",reviewer_kind:"internal",notes:"Stale review note"}])
    window.pendingSubmittalReads.listSubmittalRevisionsAction[2]([{id:"stale",revision:9,status:"approved"}])
  })
  for (const text of ["Stale submittal file", "Stale submitted item", "Stale review note", "Rev 9"]) await expect(page.getByText(text, {exact:true})).toHaveCount(0)
  await page.evaluate(() => { for (const list of Object.values(window.pendingSubmittalReads)) list[3]([]) })
  for (const text of ["Current submittal file", "Current submitted item", "Current review note", "Rev 4"]) await expect(page.getByText(text, {exact:true})).toHaveCount(0)
  await expect(draft).toHaveValue("Unsubmitted item")
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  console.info("Actual compiled submittal editor ignores superseded attachment, item, review and revision reads in either completion order while preserving the item draft; no backend requests.")
} finally { await browser?.close(); server.stop(true) }
