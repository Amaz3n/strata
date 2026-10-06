import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { chromium, expect } from "@playwright/test"
import babel from "next/dist/compiled/babel/core.js"
import compiler from "babel-plugin-react-compiler"
const built=await Bun.build({entrypoints:["tests/fixtures/waiver-library-refresh/ui.jsx"],target:"browser",define:{"process.env.NODE_ENV":'"production"',"process.env":"{}"},plugins:[{name:"waiver-fixture",setup(builder){
  builder.onLoad({filter:/waiver-template-library\.tsx$/},async({path})=>({loader:"tsx",contents:babel.transformSync(await readFile(process.env.WAIVER_LIBRARY_SOURCE??path,"utf8"),{filename:path,configFile:false,babelrc:false,parserOpts:{plugins:["typescript","jsx"]},plugins:[[compiler,{target:"19"}]]}).code}))
  builder.onResolve({filter:/^@\/app\/\(app\)\/settings\/templates\/waiver-actions$/},()=>({path:"actions",namespace:"fixture"}))
  builder.onLoad({filter:/^actions$/,namespace:"fixture"},()=>({loader:"js",contents:'function write(kind,args){return new Promise((resolve,reject)=>(window.waiverWrites??=[]).push({kind,args,resolve,reject}))}export const saveCompanyWaiverTemplate=(...args)=>write("save",args);export const archiveCompanyWaiverTemplate=(...args)=>write("archive",args);export const beginCompanyWaiverImport=(...args)=>write("import",args);export const getCompanyWaiverImport=(...args)=>write("poll",args);'}))
  builder.onResolve({filter:/waiver-setup-workspace$/},()=>({path:"workspace",namespace:"fixture"}))
  builder.onLoad({filter:/^workspace$/,namespace:"fixture"},()=>({loader:"jsx",contents:'import React from "react";export function WaiverSetupWorkspace({draft,onChange,disabled}){return <fieldset disabled={disabled}><input aria-label="Waiver name" value={draft.name} onChange={event=>onChange({...draft,name:event.target.value})}/></fieldset>}'}))
  builder.onResolve({filter:/^next\/dynamic$/},()=>({path:"dynamic",namespace:"fixture"}))
  builder.onLoad({filter:/^dynamic$/,namespace:"fixture"},()=>({loader:"js",contents:'export default function dynamic(){return ()=>null}'}))
  builder.onResolve({filter:/^sonner$/},()=>({path:"toast",namespace:"fixture"}))
  builder.onLoad({filter:/^toast$/,namespace:"fixture"},()=>({loader:"js",contents:'export const toast={error(message){(window.waiverToasts??=[]).push(message)},success(message){(window.waiverToasts??=[]).push(message)}}'}))
}}]})
assert.ok(built.success,built.logs.join("\n"))
const bundle=await built.outputs[0].text()
const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:request=>new URL(request.url).pathname==="/bundle.js"?new Response(bundle,{headers:{"content-type":"text/javascript"}}):new Response('<html><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>',{headers:{"content-type":"text/html"}})})
let browser
try{
  browser=await chromium.launch({headless:true})
  const page=await browser.newPage(),errors=[],blocked=[],origin=`http://127.0.0.1:${server.port}`
  page.on("pageerror",error=>errors.push(error.message))
  await page.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():(blocked.push(route.request().url()),route.abort()))
  async function open(){await page.goto("about:blank");await page.goto(origin);await expect(page.getByRole("button",{name:/Original waiver/})).toBeVisible()}
  async function edit(){await page.getByRole("button",{name:/Original waiver/}).click();await page.getByRole("textbox",{name:"Waiver name"}).fill("Unsaved waiver")}
  async function save(){await page.getByRole("button",{name:"Save draft",exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.waiverWrites?.length)).toBe(1)}
  async function resolveSave(){await page.evaluate(()=>window.waiverWrites[0].resolve({...window.waiverFixture.result("Unsaved waiver"),...window.waiverWrites[0].args[0],editToken:"new-token"}))}
  async function archive(){await page.getByRole("button",{name:/Original waiver/}).click();await page.getByRole("button",{name:"Archive",exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.waiverWrites?.length)).toBe(1)}
  async function upload(){await page.getByRole("button",{name:"Add waiver",exact:true}).click();await page.locator('input[type="file"]').setInputFiles({name:"waiver.pdf",mimeType:"application/pdf",buffer:Buffer.from("%PDF-fixture")});await expect.poll(()=>page.evaluate(()=>window.waiverWrites?.length)).toBe(1)}
  await open();await page.getByRole("textbox",{name:"Search waivers"}).fill("Fresh");await page.evaluate(()=>window.waiverFixture.refresh("Fresh waiver"))
  await expect(page.getByRole("button",{name:/Fresh waiver/})).toBeVisible();await expect(page.getByRole("textbox",{name:"Search waivers"})).toHaveValue("Fresh")
  await open();await edit();await page.evaluate(()=>window.waiverFixture.refresh("Fresh waiver"));await expect(page.getByRole("textbox",{name:"Waiver name"})).toHaveValue("Unsaved waiver")
  await page.getByRole("button",{name:"Back to waivers"}).click();await page.getByRole("dialog").getByRole("button",{name:"Leave",exact:true}).click()
  await expect(page.getByRole("button",{name:/Fresh waiver/})).toBeVisible()
  await open();await edit();await save();assert.equal(await page.evaluate(()=>window.waiverWrites[0].args[3]),"token");await resolveSave()
  await expect(page.getByRole("status")).toHaveText("Saved");await page.getByRole("button",{name:"Back to waivers"}).click();await expect(page.getByRole("button",{name:/Unsaved waiver/})).toBeVisible()
  await open();await edit();await save();await page.evaluate(()=>window.waiverWrites[0].reject(new Error("Save unavailable")))
  await expect(page.getByRole("alert")).toHaveText("Save unavailable");await page.getByRole("button",{name:"Save draft",exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>window.waiverWrites.length)).toBe(2)
  await page.evaluate(()=>window.waiverWrites[1].resolve({...window.waiverFixture.result("Unsaved waiver"),...window.waiverWrites[1].args[0]}))
  await expect(page.getByRole("status")).toHaveText("Saved");await expect(page.getByRole("alert")).toHaveCount(0)
  await open();await edit();await expect.poll(()=>page.evaluate(()=>window.waiverWrites?.length),{timeout:4000}).toBe(1)
  assert.equal(await page.evaluate(()=>window.waiverWrites[0].kind),"save");await resolveSave();await expect(page.getByRole("status")).toHaveText("Saved")
  for(const kind of ["save","archive","import"]){for(const reject of [false,true]){
    await open()
    if(kind==="save"){await edit();await save()}else if(kind==="archive")await archive();else await upload()
    assert.equal(await page.evaluate(()=>window.waiverWrites[0].kind),kind)
    await page.evaluate(()=>window.waiverFixture.unmount());await expect(page.getByText("Library removed")).toBeVisible()
    if(reject)await page.evaluate(()=>window.waiverWrites[0].reject(new Error("Obsolete reply")))
    else if(kind==="save")await resolveSave()
    else await page.evaluate(kind=>window.waiverWrites[0].resolve(kind==="import"?{sourceFileId:"obsolete-source"}:undefined),kind)
    await page.waitForTimeout(100)
    assert.equal(await page.evaluate(()=>window.waiverToasts?.length??0),0)
    assert.equal(await page.evaluate(()=>sessionStorage.getItem("arc-waiver-import:fixture-org")),null)
    assert.equal(await page.evaluate(()=>sessionStorage.getItem("arc-waiver-replacement:fixture-org")),null)
  }}
  await open();await archive();await page.evaluate(()=>window.waiverWrites[0].resolve());await expect(page.getByRole("button",{name:/Original waiver/})).toHaveCount(0)
  await open();await upload();await page.evaluate(()=>window.waiverWrites[0].resolve({sourceFileId:"current-source"}))
  await expect.poll(()=>page.evaluate(()=>window.waiverWrites?.length)).toBe(2)
  assert.equal(await page.evaluate(()=>window.waiverWrites[1].kind),"poll")
  await page.evaluate(()=>window.waiverWrites[1].resolve({status:"ready",sourceFileId:"current-source",draft:window.waiverFixture.result("Imported waiver")}))
  await expect(page.getByRole("textbox",{name:"Waiver name"})).toHaveValue("Imported waiver")
  assert.equal(await page.evaluate(()=>sessionStorage.getItem("arc-waiver-import:fixture-org")),null)
  await page.evaluate(()=>window.waiverFixture.unmount())
  await open();await edit();await page.getByRole("button",{name:/Bring your form/}).click()
  await page.locator('input[type="file"]').setInputFiles({name:"replacement.pdf",mimeType:"application/pdf",buffer:Buffer.from("%PDF-fixture")})
  await expect.poll(()=>page.evaluate(()=>window.waiverWrites?.length)).toBe(1)
  await page.evaluate(()=>window.waiverWrites[0].resolve({sourceFileId:"replacement-source"}))
  await expect.poll(()=>page.evaluate(()=>window.waiverWrites?.length)).toBe(2)
  assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem("arc-waiver-replacement:fixture-org")).draft.name),"Unsaved waiver")
  await page.evaluate(()=>window.waiverWrites[1].resolve({status:"ready",sourceFileId:"replacement-source",draft:window.waiverFixture.result("Replacement document")}))
  await expect(page.getByRole("textbox",{name:"Waiver name"})).toHaveValue("Unsaved waiver")
  assert.equal(await page.evaluate(()=>sessionStorage.getItem("arc-waiver-replacement:fixture-org")),null)
  await page.evaluate(()=>window.waiverFixture.unmount())
  await open();await edit();await page.evaluate(()=>window.waiverFixture.deny());await expect(page.getByRole("button",{name:"Save draft",exact:true})).toBeDisabled();await page.waitForTimeout(2100)
  assert.equal(await page.evaluate(()=>window.waiverWrites?.length??0),0,"read-only drafts must not autosave")
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
  console.log("Waiver library refresh, draft recovery, save/archive/import lifecycle, and read-only autosave checks passed")
}finally{await browser?.close();server.stop(true)}
