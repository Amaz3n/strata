import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { chromium, expect } from "@playwright/test"
import babel from "next/dist/compiled/babel/core.js"
import compiler from "babel-plugin-react-compiler"

const built = await Bun.build({ entrypoints:["tests/fixtures/banking-sync/ui.jsx"],target:"browser",define:{"process.env.NODE_ENV":'"production"',"process.env":"{}"},plugins:[{name:"banking-sync",setup(builder){
  builder.onLoad({filter:/banking-sync-control\.tsx$/},async({path})=>({loader:"tsx",contents:babel.transformSync(await readFile(path,"utf8"),{filename:path,configFile:false,babelrc:false,parserOpts:{plugins:["typescript","jsx"]},plugins:[[compiler,{target:"19"}]]}).code}))
  builder.onResolve({filter:/^@\/app\/\(app\)\/books\/banking-actions$/},()=>({path:"actions",namespace:"fixture"}))
  builder.onLoad({filter:/^actions$/,namespace:"fixture"},()=>({loader:"js",contents:'export function refreshBankingFeedsAction(){return new Promise((resolve,reject)=>(window.bankWrites??=[]).push({resolve,reject}))}'}))
  builder.onResolve({filter:/^sonner$/},()=>({path:"toast",namespace:"fixture"}))
  builder.onLoad({filter:/^toast$/,namespace:"fixture"},()=>({loader:"js",contents:'export const toast={error(message){(window.bankToasts??=[]).push(message)},success(message){(window.bankToasts??=[]).push(message)}}'}))
}}]})
assert.ok(built.success,built.logs.join("\n"))
const bundle=await built.outputs[0].text()
const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:request=>new URL(request.url).pathname==="/bundle.js"?new Response(bundle,{headers:{"content-type":"text/javascript"}}):new Response('<html><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>',{headers:{"content-type":"text/html"}})})
let browser
try {
  browser=await chromium.launch({headless:true})
  const page=await browser.newPage({reducedMotion:"reduce"}),errors=[],blocked=[],origin=`http://127.0.0.1:${server.port}`
  page.on("pageerror",error=>errors.push(error.message))
  await page.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():(blocked.push(route.request().url()),route.abort()))
  async function open(){await page.goto("about:blank");await page.goto(origin);await expect(page.getByRole("button",{name:/Sync all bank feeds/})).toBeVisible()}
  async function begin(){await page.getByRole("button").click();await expect.poll(()=>page.evaluate(()=>window.bankWrites?.length)).toBe(1);await expect(page.getByRole("button")).toBeDisabled()}
  async function succeed(timestamp){await page.evaluate(timestamp=>window.bankWrites[0].resolve({success:true,data:{connectionCount:1,refreshed:1,errors:[],lastSyncedAt:timestamp}}),timestamp)}
  await open();await begin();await page.evaluate(()=>window.bankFixture.unmount());await expect(page.getByText("Sync control removed")).toBeVisible();await succeed("2026-10-01T00:00:00Z");await page.waitForTimeout(100)
  assert.equal(await page.evaluate(()=>window.bankRefreshes??0),0,"unmounted syncs must not refresh another view")
  assert.equal(await page.evaluate(()=>window.bankToasts?.length??0),0,"unmounted syncs must not notify")
  await open();await begin();await page.evaluate(()=>window.bankFixture.unmount());await expect(page.getByText("Sync control removed")).toBeVisible();await page.evaluate(()=>window.bankWrites[0].reject(new Error("Obsolete sync failure")));await page.waitForTimeout(100)
  assert.equal(await page.evaluate(()=>window.bankToasts?.length??0),0)
  await open();await begin();await succeed("2026-10-01T00:00:00Z");await expect(page.getByRole("button")).toContainText("Sync complete")
  assert.equal(await page.evaluate(()=>window.bankRefreshes),1)
  await expect(page.getByRole("button")).not.toContainText("Sync complete",{timeout:4000})
  await page.getByRole("button").click();await expect.poll(()=>page.evaluate(()=>window.bankWrites.length)).toBe(2)
  await page.evaluate(()=>window.bankWrites[1].resolve({success:false,error:"Feed unavailable"}));await expect(page.getByRole("button")).toContainText("Sync failed")
  await open();await begin();await page.evaluate(()=>window.bankFixture.refresh("2026-10-03T00:00:00Z"));await succeed("2026-10-02T00:00:00Z")
  const expectedTime=await page.evaluate(()=>new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"long"}).format(new Date("2026-10-03T00:00:00Z")))
  await expect(page.getByRole("button")).toHaveAttribute("title",`Last successful feed refresh across all connected accounts: ${expectedTime}`)
  await page.evaluate(()=>window.bankFixture.refresh("not-a-date"))
  await expect(page.getByRole("button")).toHaveAttribute("title",`Last successful feed refresh across all connected accounts: ${expectedTime}`)
  await page.evaluate(()=>window.bankFixture.refresh("2026-10-02T23:00:00-05:00"))
  const offsetTime=await page.evaluate(()=>new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"long"}).format(new Date("2026-10-03T04:00:00Z")))
  await expect(page.getByRole("button")).toHaveAttribute("title",`Last successful feed refresh across all connected accounts: ${offsetTime}`)
  for (const [connectionCount,refreshed,feedErrors,label] of [[2,1,["One feed failed"],"Partially synced"],[0,0,[],"Sync failed"],[1,0,["Feed failed"],"Sync failed"]]) {
    await open();await begin()
    await page.evaluate(data=>window.bankWrites[0].resolve({success:true,data}),{connectionCount,refreshed,errors:feedErrors,lastSyncedAt:null})
    await expect(page.getByRole("button")).toContainText(label)
    assert.equal(await page.evaluate(()=>window.bankRefreshes),1)
  }
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
  console.log("Banking sync ignores unmounted replies, recovers from failure, and preserves the newest valid timestamp")
} finally {await browser?.close();server.stop(true)}
