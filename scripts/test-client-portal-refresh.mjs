import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { chromium, expect } from "@playwright/test"
import babel from "next/dist/compiled/babel/core.js"
import compiler from "babel-plugin-react-compiler"

const actions = ["createPunchItemAction", "uploadPunchItemAttachmentAction", "detachPunchItemAttachmentAction", "createWarrantyRequestPortalAction", "signOffWarrantyVisitPortalAction", "decidePortalDecisionAction", "approveGroupAction", "declineApprovalAction", "loadApprovalsAction", "selectOptionAction", "selectPackageAction", "applyConfigurationFixAction", "loadConfigurationIssuesAction"].map(name => `export async function ${name}(){throw Error('No business writes allowed')}`).join("\n") + "\nexport async function listPunchItemAttachmentsAction(input){if(window.deferPortalAttachments)return new Promise((resolve,reject)=>window.pendingPortalAttachmentReads.push({resolve,reject,input}));return []}"
const built = await Bun.build({ entrypoints: ["tests/fixtures/client-portal-refresh/ui.jsx"], target: "browser", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "portal-refresh-fixture", setup(builder) {
  builder.onLoad({ filter: /(?:punch-list|warranty|decisions|selections)-client\.tsx$/ }, async ({ path }) => ({ loader: "tsx", contents: babel.transformSync(await readFile(path, "utf8"), { filename: path, configFile: false, babelrc: false, parserOpts: { plugins: ["typescript", "jsx"] }, plugins: [[compiler, { target: "19" }]] }).code }))
  builder.onResolve({ filter: /^\.\/actions$/ }, args => args.importer.includes("/app/p/") ? { path: "actions", namespace: "fixture" } : undefined)
  builder.onLoad({ filter: /^actions$/, namespace: "fixture" }, () => ({ loader: "js", contents: actions }))
  builder.onResolve({ filter: /^@\/components\/files$/ }, () => ({ path: "attachments", namespace: "fixture" }))
  builder.onLoad({ filter: /^attachments$/, namespace: "fixture" }, () => ({ loader: "jsx", contents: "export function EntityAttachments({attachments=[],readOnly=false,entityId}){return <div aria-label='Punch photos' data-read-only={String(readOnly)} data-item={entityId}>{attachments.map(file=><span key={file.id}>{file.file_name}</span>)}</div>}" }))
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
  for (const mode of ["punch", "warranty", "decisions"]) {
    await page.goto(origin)
    await expect(page.getByPlaceholder("Title")).toBeVisible()
    if (mode !== "punch") await page.evaluate(mode => window.portalFixture.show(mode), mode)
    const draft = mode === "punch" ? page.getByPlaceholder("Title") : mode === "warranty" ? page.getByPlaceholder("Issue title") : page.getByPlaceholder("Add a note for your builder (optional)")
    if (mode === "decisions") await page.getByRole("button", { name: "Review & decide" }).click()
    await draft.fill("Unsubmitted draft")
    await page.evaluate(() => window.portalFixture.refresh())
    await expect(page.getByText(`Refreshed ${mode === "punch" ? "punch" : mode === "warranty" ? "warranty" : "decision"}`, { exact: true }).first()).toBeVisible()
    if (mode === "warranty") await expect(page.getByText("Refreshed trade", { exact: true })).toBeVisible()
    await expect(draft).toHaveValue("Unsubmitted draft")
    if (mode === "decisions") await expect(page.getByRole("dialog").getByRole("heading", { name: "Refreshed decision" })).toBeVisible()
    if (mode === "decisions") {
      await page.evaluate(() => window.portalFixture.replaceOptions())
      const option = page.getByRole("button", { name: /Updated option/ })
      await expect(option).toHaveAttribute("aria-pressed", "false")
      await expect(draft).toHaveValue("Unsubmitted draft")
      await option.click()
      await expect(option).toHaveAttribute("aria-pressed", "true")
      await page.evaluate(() => window.portalFixture.approveElsewhere())
      await expect(page.getByRole("dialog")).toHaveCount(0)
    }
    await page.evaluate(() => window.portalFixture.switchPortal())
    if (mode === "decisions") {
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await page.getByRole("button", { name: "Review & decide" }).click()
    }
    await expect(draft).toHaveValue("")
    await page.evaluate(() => window.portalFixture.empty())
    if (mode === "decisions") await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(`Original ${mode === "punch" ? "punch" : mode === "warranty" ? "warranty" : "decision"}`, { exact: true })).toHaveCount(0)
    if (mode === "warranty") await expect(page.getByText("Original trade", { exact: true })).toHaveCount(0)
  }
  await page.goto(origin)
  await expect(page.getByPlaceholder("Title")).toBeVisible()
  await page.evaluate(() => window.portalFixture.show("selections"))
  const finish = page.getByRole("button", { name: /Fixture finish/ })
  await expect(finish).toBeEnabled()
  await expect(finish).toContainText("Choose")
  await page.evaluate(() => window.portalFixture.refresh())
  await expect(finish).toHaveAttribute("aria-pressed", "true")
  await expect(finish).toContainText("Selected")
  await expect(finish).toBeDisabled()
  await expect(page.getByRole("button", { name: "Confirmed", exact: true })).toBeDisabled()
  await page.evaluate(() => window.portalFixture.switchPortal())
  await expect(finish).toContainText("Choose")
  await expect(finish).toHaveAttribute("aria-pressed", "false")
  await expect(finish).toBeEnabled()
  await page.evaluate(() => window.portalFixture.lockSelections())
  await expect(page.getByText("Locked — contact your builder to make changes.")).toBeVisible()
  await expect(finish).toHaveCount(0)
  await page.evaluate(() => window.portalFixture.empty())
  await expect(page.getByText("No selections have been assigned yet.")).toBeVisible()
  await expect(finish).toHaveCount(0)
  for (const order of ["current-first", "old-first", "same-item"]) {
    await page.goto(origin)
    await expect(page.getByPlaceholder("Title")).toBeVisible()
    await page.evaluate(() => { window.deferPortalAttachments = true; window.pendingPortalAttachmentReads = []; window.portalFixture.showSecondPunch() })
    await page.getByRole("button", { name: "Photos", exact: true }).first().click()
    await expect.poll(() => page.evaluate(() => window.pendingPortalAttachmentReads.length)).toBe(1)
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await page.getByRole("button", { name: "Photos", exact: true }).nth(order === "same-item" ? 0 : 1).click()
    await expect.poll(() => page.evaluate(() => window.pendingPortalAttachmentReads.length)).toBe(2)
    const photos = page.getByLabel("Punch photos")
    await expect(photos).toHaveAttribute("data-item", order === "same-item" ? "punch" : "second-punch")
    await expect(photos).toHaveAttribute("data-read-only", "true")
    if (order === "old-first") {
      await page.evaluate(() => window.pendingPortalAttachmentReads[0].resolve([{ id: "old", file_name: "Old photo" }]))
      await expect(photos).toHaveAttribute("data-read-only", "true")
      await expect(photos.getByText("Old photo", { exact: true })).toHaveCount(0)
    }
    await page.evaluate(() => window.pendingPortalAttachmentReads[1].resolve([{ id: "current", file_name: "Current photo" }]))
    await expect(photos.getByText("Current photo", { exact: true })).toBeVisible()
    await expect(photos).toHaveAttribute("data-read-only", "false")
    if (order !== "old-first") {
      await page.evaluate(() => window.pendingPortalAttachmentReads[0].resolve([]))
      await expect(photos.getByText("Current photo", { exact: true })).toBeVisible()
    }
  }
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  console.log("Client portal refresh adopts new rows, preserves same-portal drafts, resets portal identity, and clears removed decisions")
} finally { await browser?.close(); server.stop(true) }
