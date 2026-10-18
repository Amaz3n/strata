import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { chromium, expect } from "@playwright/test"
import babel from "next/dist/compiled/babel/core.js"
import compiler from "babel-plugin-react-compiler"

const built=await Bun.build({entrypoints:["tests/fixtures/schedule-templates-refresh/ui.jsx"],target:"browser",define:{"process.env.NODE_ENV":'"production"',"process.env":"{}"},plugins:[{name:"template-fixture",setup(builder){
  builder.onLoad({filter:/schedule-templates-client\.tsx$/},async({path})=>({loader:"tsx",contents:babel.transformSync(await readFile(process.env.SCHEDULE_TEMPLATE_SOURCE ?? path,"utf8"),{filename:path,configFile:false,babelrc:false,parserOpts:{plugins:["typescript","jsx"]},plugins:[[compiler,{target:"19"}]]}).code}))
  builder.onResolve({filter:/^@\/app\/\(app\)\/settings\/templates\/actions$/},()=>({path:"actions",namespace:"fixture"}))
  builder.onLoad({filter:/^actions$/,namespace:"fixture"},()=>({loader:"js",contents:'function write(kind,args){return new Promise((resolve,reject)=>(window.templateWrites??=[]).push({kind,args,resolve,reject}))} export const createScheduleTemplateAction=(...args)=>write("create",args); export const updateScheduleTemplateAction=(...args)=>write("update",args); export const deleteScheduleTemplateAction=(...args)=>write("delete",args);'}))
  builder.onResolve({filter:/^@\/components\/settings\/preset-template-workspace$/},()=>({path:"workspace",namespace:"fixture"}))
  builder.onLoad({filter:/^workspace$/,namespace:"fixture"},()=>({loader:"jsx",contents:'import React from "react"; export function PresetTemplateWorkspace({children,onClose,onSave,busy}){return <section aria-label="Editor"><button disabled={busy} onClick={onClose}>Close editor</button><button disabled={busy} onClick={onSave}>Save template</button><fieldset disabled={busy}>{children}</fieldset></section>}'}))
  builder.onResolve({filter:/^sonner$/},()=>({path:"toast",namespace:"fixture"}))
  builder.onLoad({filter:/^toast$/,namespace:"fixture"},()=>({loader:"js",contents:'export const toast={error(message){(window.templateToasts??=[]).push(message)},success(message){(window.templateToasts??=[]).push(message)}}'}))
}}]})
assert.ok(built.success,built.logs.join("\n"))
const bundle=await built.outputs[0].text()
const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:request=>new URL(request.url).pathname==="/bundle.js"?new Response(bundle,{headers:{"content-type":"text/javascript"}}):new Response('<html><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>',{headers:{"content-type":"text/html"}})})
let browser
try {
  browser=await chromium.launch({headless:true})
  const page=await browser.newPage(),errors=[],blocked=[],origin=`http://127.0.0.1:${server.port}`
  page.on("pageerror",error=>errors.push(error.message))
  page.on("dialog",dialog=>dialog.accept())
  await page.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():(blocked.push(route.request().url()),route.abort()))
  async function open(){await page.goto("about:blank");await page.goto(origin);await expect(page.getByRole("cell",{name:"Original schedule No description"})).toBeVisible()}
  async function edit(){await page.getByRole("button",{name:"Edit",exact:true}).click();await page.getByRole("textbox",{name:"Template name",exact:true}).fill("Unsaved draft")}
  async function save(){await page.getByRole("button",{name:"Save template",exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.templateWrites?.length)).toBe(1)}
  async function resolve(id="one"){await page.evaluate(id=>window.templateWrites[0].resolve({success:true,data:{id,name:"Saved schedule",description:null,items:[{name:"Foundation",duration_days:1}]}}),id)}
  await open();await edit();await page.evaluate(()=>window.templateFixture.refresh("Fresh schedule"))
  await expect(page.getByRole("cell",{name:"Fresh schedule No description"})).toBeVisible()
  await expect(page.getByRole("textbox",{name:"Template name",exact:true})).toHaveValue("Unsaved draft")
  await page.getByRole("button",{name:"Close editor"}).click();await page.getByRole("button",{name:"Edit",exact:true}).click()
  await expect(page.getByRole("textbox",{name:"Template name",exact:true})).toHaveValue("Fresh schedule")
  await open();await edit();await save();await resolve()
  await expect(page.getByRole("cell",{name:"Saved schedule No description"})).toBeVisible()
  await expect(page.getByRole("region",{name:"Editor"})).toHaveCount(0)
  assert.deepEqual(await page.evaluate(()=>window.templateToasts),["Schedule template saved"])
  await open();await page.getByRole("button",{name:"New schedule template"}).click()
  await page.getByRole("textbox",{name:"Template name",exact:true}).fill("New draft")
  await page.getByRole("textbox",{name:"Activity 1",exact:true}).fill("Framing")
  await save()
  assert.equal(await page.evaluate(()=>window.templateWrites[0].kind),"create")
  assert.equal(await page.evaluate(()=>window.templateWrites[0].args[0].items[0].name),"Framing")
  await resolve("two");await expect(page.getByRole("cell",{name:"Saved schedule No description"})).toBeVisible()
  await expect(page.getByRole("cell",{name:"Original schedule No description"})).toBeVisible()
  await open();await edit();await save();await page.evaluate(()=>window.templateFixture.refresh("Newer server schedule"))
  await expect(page.getByRole("cell",{name:"Newer server schedule No description"})).toBeVisible()
  await resolve()
  await expect(page.getByRole("cell",{name:"Newer server schedule No description"})).toBeVisible()
  await expect(page.getByRole("region",{name:"Editor"})).toHaveCount(0)
  assert.deepEqual(await page.evaluate(()=>window.templateToasts),["Schedule template saved"])
  await open();await edit();await save();await page.evaluate(()=>window.templateWrites[0].reject(new Error("Save unavailable")))
  await expect(page.getByRole("button",{name:"Save template",exact:true})).toBeEnabled()
  await expect(page.getByRole("textbox",{name:"Template name",exact:true})).toHaveValue("Unsaved draft")
  assert.deepEqual(await page.evaluate(()=>window.templateToasts),["Save unavailable"])
  await page.getByRole("button",{name:"Save template",exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.templateWrites.length)).toBe(2)
  for(const reject of [false,true]){
    await open();await edit();await save();await page.evaluate(()=>window.templateFixture.unmount());await expect(page.getByText("Library removed")).toBeVisible()
    if(reject)await page.evaluate(()=>window.templateWrites[0].reject(new Error("Obsolete failure")));else await resolve()
    await page.waitForTimeout(100)
    assert.equal(await page.evaluate(()=>window.templateToasts?.length??0),0)
  }
  await open();await page.getByRole("row").filter({hasText:"Original schedule"}).getByRole("button").last().click()
  await expect.poll(()=>page.evaluate(()=>window.templateWrites?.length)).toBe(1)
  assert.equal(await page.evaluate(()=>window.templateWrites[0].kind),"delete")
  await page.evaluate(()=>window.templateWrites[0].resolve({success:true,data:null}));await expect(page.getByText("No schedule templates yet.")).toBeVisible()
  await open();await page.getByRole("button",{name:"Delete Original schedule",exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>window.templateWrites?.length)).toBe(1)
  await page.evaluate(()=>window.templateFixture.refresh("Refreshed after deletion request"))
  await expect(page.getByRole("cell",{name:"Refreshed after deletion request No description"})).toBeVisible()
  await page.evaluate(()=>window.templateWrites[0].resolve({success:true,data:null}))
  await expect(page.getByRole("cell",{name:"Refreshed after deletion request No description"})).toBeVisible()
  assert.deepEqual(await page.evaluate(()=>window.templateToasts),["Schedule template deleted"])
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
  console.log("Schedule templates adopt fresh lists, preserve drafts, ignore obsolete replies, and recover after failure")
} finally {await browser?.close();server.stop(true)}
