import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { chromium, expect } from "@playwright/test"
import babel from "next/dist/compiled/babel/core.js"
import compiler from "babel-plugin-react-compiler"
const writes = ["addRfiResponseAction", "closeRfiAction", "convertRfiToChangeOrderAction", "decideRfiAction", "reopenRfiAction", "sendRfiAction", "detachFileLinkAction", "attachFileAction", "uploadDocumentForm"]
const reads = ["listAttachmentsAction", "listRfiResponsesAction", "getRfiLinkedChangeOrderAction"]
const actions = writes.map(name => `export async function ${name}(){throw Error('No backend writes allowed')}`).join("\n") + reads.map(name => `export async function ${name}(){if(window.deferRfiReads)return new Promise(resolve=>(window.pendingRfiReads['${name}']??=[]).push(resolve));return ${name === "getRfiLinkedChangeOrderAction" ? "{success:true,data:null}" : "[]"}}`).join("\n")
const built = await Bun.build({ entrypoints: ["tests/fixtures/rfi-detail-refresh/ui.jsx"], target: "browser", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "rfi-detail-fixture", setup(builder) {
  builder.onLoad({ filter: /rfi-detail-sheet\.tsx$/ }, async ({ path }) => ({ loader: "tsx", contents: babel.transformSync(await readFile(path, "utf8"), { filename: path, configFile: false, babelrc: false, parserOpts: { plugins: ["typescript", "jsx"] }, plugins: [[compiler, { target: "19" }]] }).code }))
  builder.onResolve({ filter: /rfis\/actions$|documents\/actions$|files\/upload-document-form$/ }, () => ({ path: "actions", namespace: "fixture" }))
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
  await page.getByRole("button", { name: "Add Response", exact: true }).click()
  const response = page.getByPlaceholder("Provide your response to this RFI...")
  const decision = page.getByPlaceholder("Add any notes about this decision...")
  await response.fill("Unsubmitted response")
  await decision.fill("Unsubmitted decision")
  await page.evaluate(() => window.rfiFixture.refresh())
  await expect(page.getByText("Refreshed RFI", { exact: true })).toBeVisible()
  await expect(response).toHaveValue("Unsubmitted response")
  await expect(decision).toHaveValue("Unsubmitted decision")
  await page.evaluate(() => window.rfiFixture.selectSecond())
  await expect(page.getByText("Second RFI", { exact: true })).toBeVisible()
  await expect(decision).toHaveValue("")
  await page.getByRole("button", { name: "Add Response", exact: true }).click()
  await expect(response).toHaveValue("")
  await page.evaluate(() => { window.deferRfiReads = true; window.pendingRfiReads = {}; window.rfiFixture.refresh() })
  for (const name of reads) await expect.poll(() => page.evaluate(name => window.pendingRfiReads[name]?.length ?? 0, name)).toBe(1)
  await page.evaluate(() => window.rfiFixture.refresh())
  for (const name of reads) await expect.poll(() => page.evaluate(name => window.pendingRfiReads[name]?.length ?? 0, name)).toBe(2)
  const attachments = page.getByLabel("Attachments", { exact: true })
  await page.evaluate(() => {
    window.pendingRfiReads.listAttachmentsAction[0]([{ id: "stale-link", file: { id: "stale", file_name: "Stale RFI photo" } }])
    window.pendingRfiReads.listRfiResponsesAction[0]([{ id: "stale", response_type: "comment", body: "Stale response", created_at: "2026-10-03T12:00:00Z" }])
    window.pendingRfiReads.getRfiLinkedChangeOrderAction[0]({success:true,data:{id:"stale",title:"Stale change order",status:"draft"}})
  })
  await expect(attachments).toHaveAttribute("data-read-only", "true")
  await expect(page.getByText("Loading responses...", { exact: true })).toBeVisible()
  await expect(page.getByText("Stale RFI photo", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Stale change order", { exact: true })).toHaveCount(0)
  await page.evaluate(() => {
    window.pendingRfiReads.listAttachmentsAction[1]([{ id: "current-link", file: { id: "current", file_name: "Current RFI photo" } }])
    window.pendingRfiReads.listRfiResponsesAction[1]([{ id: "current", response_type: "comment", body: "Current response", created_at: "2026-10-03T12:00:00Z" }])
    window.pendingRfiReads.getRfiLinkedChangeOrderAction[1]({success:true,data:{id:"current",title:"Current change order",status:"draft"}})
  })
  await expect(attachments).toHaveAttribute("data-read-only", "false")
  await expect(page.getByText("Current RFI photo", { exact: true })).toBeVisible()
  await expect(page.getByText("Current response", { exact: true })).toBeVisible()
  await expect(page.getByText("Current change order", { exact: true })).toBeVisible()
  await page.evaluate(() => window.rfiFixture.refresh())
  for (const name of reads) await expect.poll(() => page.evaluate(name => window.pendingRfiReads[name]?.length ?? 0, name)).toBe(3)
  await page.evaluate(() => window.rfiFixture.refresh())
  for (const name of reads) await expect.poll(() => page.evaluate(name => window.pendingRfiReads[name]?.length ?? 0, name)).toBe(4)
  await page.evaluate(() => {
    window.pendingRfiReads.listAttachmentsAction[3]([{ id: "latest-link", file: { id: "latest", file_name: "Latest RFI photo" } }])
    window.pendingRfiReads.listRfiResponsesAction[3]([{ id: "latest", response_type: "comment", body: "Latest response", created_at: "2026-10-03T12:00:00Z" }])
    window.pendingRfiReads.getRfiLinkedChangeOrderAction[3]({success:true,data:{id:"latest",title:"Latest change order",status:"draft"}})
  })
  await expect(page.getByText("Latest response", { exact: true })).toBeVisible()
  await page.evaluate(() => {
    window.pendingRfiReads.listAttachmentsAction[2]([])
    window.pendingRfiReads.listRfiResponsesAction[2]([])
    window.pendingRfiReads.getRfiLinkedChangeOrderAction[2]({success:true,data:null})
  })
  await expect(page.getByText("Latest RFI photo", { exact: true })).toBeVisible()
  await expect(page.getByText("Latest response", { exact: true })).toBeVisible()
  await expect(page.getByText("Latest change order", { exact: true })).toBeVisible()
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  console.info("Actual compiled RFI editor preserves same-record drafts, resets on another RFI, and ignores superseded attachment, response and linked-order reads in either completion order; no backend requests.")
} finally { await browser?.close(); server.stop(true) }
