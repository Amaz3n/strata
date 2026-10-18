import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { chromium, expect } from "@playwright/test"
import babel from "next/dist/compiled/babel/core.js"
import compiler from "babel-plugin-react-compiler"

const mocks = {
  router: "window.notificationPushes=[];const router={push:href=>window.notificationPushes.push(href)};export function useRouter(){return router}",
  auth: "const user={id:'user'};export function useUser(){return {user}}",
  supabase: `window.notificationSubscriptions=0;window.notificationUnsubscribes=0;const client={channel:()=>({on(type,filter,callback){window.emitNotification=callback;return this},subscribe(){window.notificationSubscriptions++;return this}}),removeChannel(){window.notificationUnsubscribes++}};export function createClient(){return client}`,
  actions: `window.notificationLoads=0;window.notificationMarks=[];const records=[{id:'one',notification_type:'invoice',created_at:'2026-10-01',payload:{title:'Invoice update',message:'Fixture',project_id:'project',entity_type:'invoice',entity_id:'invoice'}},{id:'two',notification_type:'task_completed',created_at:'2026-10-01',payload:{title:'Task update',message:'Fixture',project_id:'project',entity_type:'task',entity_id:'task'}}];export async function getUserNotificationsAction(){window.notificationLoads++;return records}export async function getUnreadCountAction(){return 2}export async function markNotificationAsReadAction(id){window.notificationMarks.push(id);return {success:true,data:null}}`,
  toast: "window.notificationToasts=[];const show=(title,options)=>window.notificationToasts.push({title,...options});export const toast=Object.assign(show,{success:show,info:show,warning:show,error:show})",
}
const built = await Bun.build({ entrypoints: ["tests/fixtures/notification-navigation/ui.jsx"], target: "browser", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "isolated-notifications", setup(builder) {
  builder.onLoad({ filter: /(use-notifications\.ts|notification-(bell|list|item)\.tsx)$/ }, async ({ path }) => ({ loader: "tsx", contents: babel.transformSync(await readFile(path, "utf8"), { filename: path, configFile: false, babelrc: false, parserOpts: { plugins: ["typescript", "jsx"] }, plugins: [[compiler, { target: "19" }]] }).code }))
  for (const [filter, path] of [[/^next\/navigation$/, "router"], [/lib\/auth\/client$/, "auth"], [/lib\/supabase\/client$/, "supabase"], [/settings\/actions$/, "actions"], [/^sonner$/, "toast"]]) builder.onResolve({ filter }, () => ({ path, namespace: "fixture" }))
  builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ loader: "js", contents: mocks[path] }))
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
  const bell = page.getByRole("button", { name: "Notifications", exact: true })
  await expect(bell).toHaveText("2")
  await bell.click()
  await expect(page.getByText("Invoice update", { exact: true })).toBeVisible()
  assert.equal(await page.evaluate(() => window.notificationSubscriptions), 1)
  assert.equal(await page.evaluate(() => window.notificationLoads), 1)
  await page.getByRole("button", { name: "Mark notification as read" }).first().click()
  await expect(bell).toHaveText("1")
  assert.deepEqual(await page.evaluate(() => window.notificationMarks), ["one"])
  await page.getByText("Invoice update", { exact: true }).click()
  assert.deepEqual(await page.evaluate(() => window.notificationPushes), ["/projects/project/financials/billing?invoice=invoice"])
  await page.evaluate(() => window.emitNotification({new:{id:'three',notification_type:'schedule_risk',created_at:'2026-10-01',payload:{title:'Org alert',href:'/payables/reconciliation'}}}))
  await expect(bell).toHaveText("2")
  await page.evaluate(() => window.notificationToasts.at(-1).action.onClick())
  assert.deepEqual(await page.evaluate(() => window.notificationPushes), ["/projects/project/financials/billing?invoice=invoice", "/payables/reconciliation"])
  await bell.click()
  assert.equal(await page.evaluate(() => window.notificationSubscriptions), 1)
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  console.info("Compiled notification UI uses one subscription, updates the shared unread count, and routes row/toast actions without document reloads; no backend requests.")
} finally { await browser?.close(); server.stop(true) }
