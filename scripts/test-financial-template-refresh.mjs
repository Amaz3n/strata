import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { chromium, expect } from "@playwright/test"
import babel from "next/dist/compiled/babel/core.js"
import compiler from "babel-plugin-react-compiler"

const built=await Bun.build({entrypoints:["tests/fixtures/financial-template-refresh/ui.jsx"],target:"browser",define:{"process.env.NODE_ENV":'"production"',"process.env":"{}"},plugins:[{name:"financial-template-fixture",setup(builder){
  builder.onLoad({filter:/(budget|estimate)-templates-client\.tsx$/},async({path})=>{
    const override=path.includes("budget-templates")?process.env.BUDGET_TEMPLATE_SOURCE:process.env.ESTIMATE_TEMPLATE_SOURCE
    return {loader:"tsx",contents:babel.transformSync(await readFile(override??path,"utf8"),{filename:path,configFile:false,babelrc:false,parserOpts:{plugins:["typescript","jsx"]},plugins:[[compiler,{target:"19"}]]}).code}
  })
  builder.onResolve({filter:/^@\/app\/\(app\)\/settings\/templates\/actions$/},()=>({path:"actions",namespace:"fixture"}))
  builder.onLoad({filter:/^actions$/,namespace:"fixture"},()=>({loader:"js",contents:'function write(kind,args){return new Promise((resolve,reject)=>(window.templateWrites??=[]).push({kind,args,resolve,reject}))} export const createBudgetTemplateAction=(...args)=>write("create",args);export const updateBudgetTemplateAction=(...args)=>write("update",args);export const archiveBudgetTemplateAction=(...args)=>write("remove",args);export const createEstimateTemplateAction=(...args)=>write("create",args);export const updateEstimateTemplateAction=(...args)=>write("update",args);export const deleteEstimateTemplateAction=(...args)=>write("remove",args);'}))
  builder.onResolve({filter:/^@\/components\/settings\/preset-template-workspace$/},()=>({path:"workspace",namespace:"fixture"}))
  builder.onLoad({filter:/^workspace$/,namespace:"fixture"},()=>({loader:"jsx",contents:'import React from "react";export function PresetTemplateWorkspace({children,onClose,onSave,busy}){return <section aria-label="Editor"><button disabled={busy} onClick={onClose}>Close editor</button><button disabled={busy} onClick={onSave}>Save template</button><fieldset disabled={busy}>{children}</fieldset></section>}'}))
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
  page.on("pageerror",error=>errors.push(error.message));page.on("dialog",dialog=>dialog.accept())
  await page.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():(blocked.push(route.request().url()),route.abort()))
  for(const kind of (process.env.TEMPLATE_KIND?[process.env.TEMPLATE_KIND]:["budget","estimate"])){
    const nameField=()=>kind==="budget"?page.getByRole("textbox",{name:"Template name",exact:true}):page.getByPlaceholder("e.g. Kitchen remodel")
    async function open(){await page.goto("about:blank");await page.goto(`${origin}/?kind=${kind}`);await expect(page.getByText("Original template",{exact:true})).toBeVisible()}
    async function edit(){await page.getByRole("button",{name:"Edit",exact:true}).click();await nameField().fill("Unsaved draft")}
    async function save(){await page.getByRole("button",{name:"Save template",exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.templateWrites?.length)).toBe(1)}
    async function resolve(id="one"){await page.evaluate(id=>window.templateWrites[0].resolve({success:true,data:window.templateFixture.result("Saved template",id)}),id)}
    async function remove(){
      if(kind==="budget")await page.getByRole("row").filter({hasText:"Original template"}).getByRole("button").last().click()
      else {await page.getByRole("button",{name:"Delete Original template",exact:true}).click();await page.getByRole("alertdialog").getByRole("button",{name:"Delete",exact:true}).click()}
      await expect.poll(()=>page.evaluate(()=>window.templateWrites?.length)).toBe(1)
    }
    await open();await edit();await page.evaluate(()=>window.templateFixture.refresh("Fresh template"))
    await expect(page.getByText("Fresh template",{exact:true})).toBeVisible();await expect(nameField()).toHaveValue("Unsaved draft")
    await page.getByRole("button",{name:"Close editor"}).click();await page.getByRole("button",{name:"Edit",exact:true}).click();await expect(nameField()).toHaveValue("Fresh template")
    await open();await edit();await save()
    const write=await page.evaluate(()=>({kind:window.templateWrites[0].kind,args:window.templateWrites[0].args}))
    assert.equal(write.kind,"update");assert.equal(write.args[0],"one")
    assert.equal(write.args[1].lines[0][kind==="budget"?"amountCents":"unit_cost_cents"],10000)
    await resolve();await expect(page.getByText("Saved template",{exact:true})).toBeVisible();await expect(page.getByRole("region",{name:"Editor"})).toHaveCount(0)
    await open();await edit();await save();await page.evaluate(()=>window.templateFixture.refresh("Newer server template"))
    await expect(page.getByText("Newer server template",{exact:true})).toBeVisible();await resolve()
    await expect(page.getByRole("region",{name:"Editor"})).toHaveCount(0);await expect(page.getByText("Newer server template",{exact:true})).toBeVisible()
    await expect(page.getByText("Saved template",{exact:true})).toHaveCount(0)
    await open();await page.getByRole("button",{name:kind==="budget"?"New budget template":"New template",exact:true}).click()
    await nameField().fill("New draft")
    if(kind==="budget"){await page.getByRole("textbox",{name:"Description 1",exact:true}).fill("Framing");await page.getByLabel("Amount / Quantity 1",{exact:true}).fill("125.50")}
    else {await page.getByPlaceholder("Work item").fill("Framing");await page.getByPlaceholder("0.00").fill("125.50")}
    await save();assert.equal(await page.evaluate(()=>window.templateWrites[0].kind),"create")
    const payload=await page.evaluate(()=>window.templateWrites[0].args[0])
    assert.equal(payload.lines[0].description,"Framing");assert.equal(payload.lines[0][kind==="budget"?"amountCents":"unit_cost_cents"],12550)
    await resolve("two");await expect(page.getByText("Saved template",{exact:true})).toBeVisible();await expect(page.getByText("Original template",{exact:true})).toBeVisible()
    await open();await page.getByRole("button",{name:kind==="budget"?"New budget template":"New template",exact:true}).click()
    await nameField().fill("New draft")
    if(kind==="budget")await page.getByRole("textbox",{name:"Description 1",exact:true}).fill("Framing")
    else await page.getByPlaceholder("Work item").fill("Framing")
    await save();await page.evaluate(()=>window.templateFixture.refresh("Saved template","two"))
    await expect(page.getByText("Saved template",{exact:true})).toBeVisible();await resolve("two")
    await expect(page.getByRole("region",{name:"Editor"})).toHaveCount(0)
    await expect(page.getByText("Saved template",{exact:true})).toHaveCount(1)
    await open();await edit();await save();await page.evaluate(()=>window.templateWrites[0].reject(new Error("Save unavailable")))
    await expect(page.getByRole("button",{name:"Save template",exact:true})).toBeEnabled();await expect(nameField()).toHaveValue("Unsaved draft")
    assert.deepEqual(await page.evaluate(()=>window.templateToasts),["Save unavailable"])
    await page.getByRole("button",{name:"Save template",exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.templateWrites.length)).toBe(2)
    for(const reject of [false,true]){
      await open();await edit();await save();await page.evaluate(()=>window.templateFixture.unmount());await expect(page.getByText("Library removed")).toBeVisible()
      if(reject)await page.evaluate(()=>window.templateWrites[0].reject(new Error("Obsolete save failure")));else await resolve()
      await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.templateToasts?.length??0),0)
    }
    await open();await remove();await page.evaluate(()=>window.templateWrites[0].resolve({success:true,data:null}))
    await expect(page.getByText("Original template",{exact:true})).toHaveCount(0)
    await open();await remove();await page.evaluate(()=>window.templateWrites[0].reject(new Error("Removal unavailable")))
    await expect.poll(()=>page.evaluate(()=>window.templateToasts)).toEqual(["Removal unavailable"])
    await expect(page.getByText("Original template",{exact:true})).toBeVisible()
    await open();await remove();await page.evaluate(()=>window.templateFixture.refresh("Fresh after removal request"))
    await expect(page.getByText("Fresh after removal request",{exact:true})).toBeVisible()
    await page.evaluate(()=>window.templateWrites[0].resolve({success:true,data:null}))
    await expect(page.getByText("Fresh after removal request",{exact:true})).toBeVisible()
    for(const reject of [false,true]){
      await open();await remove();await page.evaluate(()=>window.templateFixture.unmount());await expect(page.getByText("Library removed")).toBeVisible()
      await page.evaluate(reject=>reject?window.templateWrites[0].reject(new Error("Obsolete removal failure")):window.templateWrites[0].resolve({success:true,data:null}),reject)
      await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.templateToasts?.length??0),0)
    }
    console.log(`${kind} templates: fresh lists, draft preservation, save/create payloads, retries, and unmounted replies passed`)
  }
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
} finally {await browser?.close();server.stop(true)}
