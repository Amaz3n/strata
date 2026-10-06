import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { chromium, expect } from "@playwright/test"
import babel from "next/dist/compiled/babel/core.js"
import compiler from "babel-plugin-react-compiler"
const built = await Bun.build({ entrypoints: ["tests/fixtures/estimates-refresh/ui.jsx"], target: "browser", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "estimate-refresh", setup(builder) {
  builder.onLoad({ filter: /estimates-client\.tsx$/ }, async ({ path }) => ({ loader: "tsx", contents: babel.transformSync(await readFile(path, "utf8"), { filename: path, configFile: false, babelrc: false, parserOpts: { plugins: ["typescript", "jsx"] }, plugins: [[compiler, { target: "19" }]] }).code }))
  builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture" }))
  builder.onLoad({ filter: /^navigation$/, namespace: "fixture" }, () => ({ loader: "js", contents: 'export function useSearchParams(){return new URLSearchParams(window.location.search)}' }))
  builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }))
  builder.onLoad({ filter: /^link$/, namespace: "fixture" }, () => ({ loader: "jsx", contents: 'export default function Link(props){return <a {...props}/>}' }))
  builder.onResolve({ filter: /^@\/app\/\(app\)\/estimates\/actions$/ }, () => ({ path: "actions", namespace: "fixture" }))
  builder.onLoad({ filter: /^actions$/, namespace: "fixture" }, () => ({ loader: "js", contents: ["createEstimateAction", "duplicateEstimateAction", "updateEstimateStatusAction", "sendEstimateAction", "getEstimateBuilderSigningLinkAction", "getEstimateShareLinkAction", "reviseEstimateAction"].map(name => `export async function ${name}(){throw Error("No business writes allowed")}`).join("\n") }))
  builder.onResolve({ filter: /^@\/components\/estimates\/estimate-(?:create-sheet|activity-sheet|withdraw-dialog)$/ }, args => ({ path: args.path.split("/").at(-1), namespace: "fixture" }))
  builder.onLoad({ filter: /^estimate-/, namespace: "fixture" }, ({ path }) => ({ loader: "jsx", contents: path === "estimate-activity-sheet" ? 'export function EstimateActivitySheet({open,estimate}){return open?<div aria-label="Estimate activity">{estimate.title}</div>:null}' : path === "estimate-create-sheet" ? 'import {useState} from "react"; export function EstimateCreateSheet({open}){const [value,setValue]=useState("");return open?<input aria-label="Estimate draft" value={value} onChange={e=>setValue(e.target.value)}/>:null}' : 'export function EstimateWithdrawDialog(){return null}' }))
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
  await page.getByRole("button", { name: "Fixture estimate", exact: true }).click()
  await expect(page.getByLabel("Estimate activity")).toContainText("Fixture estimate")
  await page.getByPlaceholder("Search estimates...").fill("Fixture")
  await page.getByRole("button", { name: /New estimate/i }).click()
  await page.getByLabel("Estimate draft").fill("Unsubmitted draft")
  await page.evaluate(() => window.estimateFixture.refresh())
  const row = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Fixture refreshed", exact: true }) })
  await expect(row).toBeVisible()
  await expect(row).toContainText("Executed")
  await expect(row).toContainText("200")
  await expect(page.getByLabel("Estimate activity")).toContainText("Fixture refreshed")
  await expect(page.getByPlaceholder("Search estimates...")).toHaveValue("Fixture")
  await expect(page.getByLabel("Estimate draft")).toHaveValue("Unsubmitted draft")
  await page.evaluate(() => window.estimateFixture.empty())
  await expect(page.getByRole("button", { name: "Fixture refreshed", exact: true })).toHaveCount(0)
  await expect(page.getByLabel("Estimate activity")).toHaveCount(0)
  await expect(page.getByLabel("Estimate draft")).toHaveValue("Unsubmitted draft")
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  console.log("Estimate refresh updates rows and active activity, removes deleted rows, and preserves search and creation drafts")
} finally { await browser?.close(); server.stop(true) }
