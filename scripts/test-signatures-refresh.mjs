import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { chromium, expect } from "@playwright/test"
import babel from "next/dist/compiled/babel/core.js"
import compiler from "babel-plugin-react-compiler"
const built = await Bun.build({ entrypoints: ["tests/fixtures/signatures-refresh/ui.jsx"], target: "browser", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "signature-refresh", setup(builder) {
  builder.onLoad({ filter: /signatures-hub-client\.tsx$/ }, async ({ path }) => ({ loader: "tsx", contents: babel.transformSync(await readFile(path, "utf8"), { filename: path, configFile: false, babelrc: false, parserOpts: { plugins: ["typescript", "jsx"] }, plugins: [[compiler, { target: "19" }]] }).code }))
  builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture" }))
  builder.onLoad({ filter: /^navigation$/, namespace: "fixture" }, () => ({ loader: "js", contents: 'export function useRouter(){return {refresh(){},push(){}}}' }))
  builder.onResolve({ filter: /^@\/app\/\(app\)\/signatures\/actions$/ }, () => ({ path: "actions", namespace: "fixture" }))
  builder.onLoad({ filter: /^actions$/, namespace: "fixture" }, () => ({ loader: "js", contents: ["bulkSendTemplateEnvelopesAction", "updateESignTemplateAction", "archiveESignTemplateAction", "correctEnvelopeRecipientAction", "retryEnvelopeExecutionAction", "createMySigningLinkAction", "deleteDraftDocumentAction", "getEnvelopeExecutedDownloadUrlAction", "listESignTemplatesAction", "listSignatureStartTargetsAction", "markEnvelopeSignedOfflineAction", "resendEnvelopeAction", "sendDocumentSigningReminderAction", "voidEnvelopeAction"].map(name => `export async function ${name}(){throw Error("No business writes allowed")}`).join("\n") + '\nexport function listSignaturesHubAction(input){return new Promise(resolve=>(window.signatureReads??=[]).push({input,resolve}))}' }))
  builder.onResolve({ filter: /^@\/components\/esign\/envelope-wizard$/ }, () => ({ path: "wizard", namespace: "fixture" }))
  builder.onLoad({ filter: /^wizard$/, namespace: "fixture" }, () => ({ loader: "js", contents: 'export function EnvelopeWizard(){return null}' }))
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
  const search = page.getByPlaceholder("Search document titles...")
  await expect(search).toBeVisible()
  await page.waitForTimeout(500)
  assert.equal(await page.evaluate(() => (window.signatureReads ?? []).length), 0, "server-provided history should not be fetched again on mount")
  await page.evaluate(() => window.signatureFixture.refresh())
  await expect(page.getByText("Refreshed signature", { exact: true }).first()).toBeVisible()
  await page.waitForTimeout(500)
  assert.equal(await page.evaluate(() => (window.signatureReads ?? []).length), 0, "refreshed server history should be adopted without a duplicate request")
  await search.fill("First")
  await expect.poll(() => page.evaluate(() => (window.signatureReads ?? []).length)).toBe(1)
  await search.fill("Second")
  await expect.poll(() => page.evaluate(() => (window.signatureReads ?? []).length)).toBe(2)
  await page.evaluate(() => window.signatureReads[1].resolve({rows:[],summary:{total:0,waiting_on_client:0,executed_this_week:0,expiring_soon:0},generated_at:"2026-10-01T12:00:00Z"}))
  await expect(page.getByText("Refreshed signature", { exact: true })).toHaveCount(0)
  await page.evaluate(() => window.signatureFixture.resolveRead(0, "Stale search result"))
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await expect(page.getByText("Stale search result", { exact: true })).toHaveCount(0)
  await expect(search).toHaveValue("Second")
  await search.fill("")
  await expect(page.getByText("Refreshed signature", { exact: true }).first()).toBeVisible()
  assert.equal(await page.evaluate(() => window.signatureReads.length), 2, "clearing a search can restore the current server history")
  await page.evaluate(() => window.signatureFixture.empty())
  await expect(page.getByText("Refreshed signature", { exact: true })).toHaveCount(0)
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  console.log("Signature history adopts refreshed server data, skips duplicate reads, and retains cancellable search")
} finally { await browser?.close(); server.stop(true) }
