import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { chromium, expect } from "@playwright/test"
import babel from "next/dist/compiled/babel/core.js"
import compiler from "babel-plugin-react-compiler"
const built=await Bun.build({entrypoints:["tests/fixtures/checklist-template-lifecycle/ui.jsx"],target:"browser",define:{"process.env.NODE_ENV":'"production"',"process.env":"{}"},plugins:[{name:"checklist-fixture",setup(builder){
  builder.onLoad({filter:/checklists-client\.tsx$/},async({path})=>({loader:"tsx",contents:babel.transformSync(await readFile(process.env.CHECKLIST_CLIENT_SOURCE??path,"utf8"),{filename:path,configFile:false,babelrc:false,parserOpts:{plugins:["typescript","jsx"]},plugins:[[compiler,{target:"19"}]]}).code}))
  builder.onResolve({filter:/checklists-actions$/},()=>({path:"actions",namespace:"fixture"}))
  builder.onLoad({filter:/^actions$/,namespace:"fixture"},()=>({loader:"js",contents:'function action(kind,args){return new Promise((resolve,reject)=>(window.checklistActions??=[]).push({kind,args,resolve,reject}))}export const listChecklistTemplateItemsAction=(...args)=>action("read",args);export const createChecklistTemplateAction=(...args)=>action("create",args);export const updateChecklistTemplateAction=(...args)=>action("update",args);export const seedChecklistTemplatesAction=(...args)=>action("seed",args);export const setChecklistTemplateActiveAction=(...args)=>action("archive",args);'}))
  builder.onResolve({filter:/^next\/navigation$/},()=>({path:"router",namespace:"fixture"}))
  builder.onLoad({filter:/^router$/,namespace:"fixture"},()=>({loader:"js",contents:'const router={refresh(){window.checklistRefreshes=(window.checklistRefreshes??0)+1}};export const useRouter=()=>router;'}))
  builder.onResolve({filter:/^@\/components\/settings\/preset-template-workspace$/},()=>({path:"workspace",namespace:"fixture"}))
  builder.onLoad({filter:/^workspace$/,namespace:"fixture"},()=>({loader:"jsx",contents:'import React from "react";export function PresetTemplateWorkspace({children,busy,saveForm,onClose,readOnly=false}){return <section aria-label="Editor"><button disabled={busy} onClick={onClose}>Close editor</button>{!readOnly&&<button disabled={busy} type="submit" form={saveForm}>Save template</button>}<fieldset disabled={busy||readOnly}>{children}</fieldset></section>}'}))
  builder.onResolve({filter:/^sonner$/},()=>({path:"toast",namespace:"fixture"}))
  builder.onLoad({filter:/^toast$/,namespace:"fixture"},()=>({loader:"js",contents:'export const toast={error(message){(window.checklistToasts??=[]).push(message)},success(message){(window.checklistToasts??=[]).push(message)}}'}))
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
  async function open(){await page.goto("about:blank");await page.goto(origin);await expect(page.getByText("Checklist A",{exact:true})).toBeVisible()}
  async function select(name){await page.getByText(name,{exact:true}).click()}
  async function count(n){await expect.poll(()=>page.evaluate(()=>window.checklistActions?.length)).toBe(n)}
  async function reply(index,prompt){await page.evaluate(({index,prompt})=>window.checklistActions[index].resolve({success:true,data:[{section:"Review",prompt}]}),{index,prompt})}
  async function edit(){await select("Checklist A");await count(1);await reply(0,"Check foundation");await expect(page.getByRole("textbox",{name:"Checklist items"})).toHaveValue("Review:\nCheck foundation")}
  async function archive(){await page.getByRole("row").filter({hasText:"Checklist A"}).getByRole("button",{name:"Archive",exact:true}).click();await count(1)}
  await open();await select("Checklist A");await count(1)
  await expect(page.getByRole("region",{name:"Editor"})).toHaveCount(0)
  await select("Checklist B");await count(2);await reply(1,"B items")
  await expect(page.getByRole("textbox",{name:"Template name"})).toHaveValue("Checklist B")
  await expect(page.getByRole("textbox",{name:"Checklist items"})).toHaveValue("Review:\nB items")
  await reply(0,"Obsolete A items");await page.waitForTimeout(100)
  await expect(page.getByRole("textbox",{name:"Checklist items"})).toHaveValue("Review:\nB items")
  await open();await select("Checklist A");await count(1);await page.evaluate(()=>window.checklistActions[0].resolve({success:false,error:"Items unavailable"}))
  await expect(page.getByRole("alert")).toHaveText("Items unavailable");await expect(page.getByRole("region",{name:"Editor"})).toHaveCount(0)
  await page.getByRole("button",{name:"Retry loading items"}).click();await count(2);await reply(1,"Recovered items")
  await expect(page.getByRole("textbox",{name:"Checklist items"})).toHaveValue("Review:\nRecovered items")
  await open();await select("Checklist A");await count(1);await page.getByRole("button",{name:"New template",exact:true}).click();await page.getByRole("textbox",{name:"Template name"}).fill("New draft")
  await reply(0,"Old items");await page.waitForTimeout(100);await expect(page.getByRole("textbox",{name:"Template name"})).toHaveValue("New draft");await expect(page.getByRole("textbox",{name:"Checklist items"})).toHaveValue("")
  await open();await edit();await page.getByRole("textbox",{name:"Template name"}).fill("Unsaved draft");await page.evaluate(()=>window.checklistFixture.refresh())
  await expect(page.getByText("Fresh A",{exact:true})).toBeVisible();await expect(page.getByRole("textbox",{name:"Template name"})).toHaveValue("Unsaved draft")
  await page.getByRole("textbox",{name:"Checklist items"}).fill("Foundation:\nCheck formwork\nCheck rebar")
  await page.getByRole("button",{name:"Save template"}).click();await count(2)
  const update=await page.evaluate(()=>({kind:window.checklistActions[1].kind,args:window.checklistActions[1].args}))
  assert.equal(update.kind,"update");assert.equal(update.args[0],"a");assert.deepEqual(update.args[1].items,[{section:"Foundation",prompt:"Check formwork",response_type:"pass_fail"},{section:"Foundation",prompt:"Check rebar",response_type:"pass_fail"}])
  await page.evaluate(()=>window.checklistActions[1].resolve({success:true,data:{}}));await expect(page.getByRole("region",{name:"Editor"})).toHaveCount(0);assert.equal(await page.evaluate(()=>window.checklistRefreshes),1)
  await open();await edit();await page.getByRole("button",{name:"Save template"}).click();await count(2);await page.evaluate(()=>window.checklistActions[1].reject(new Error("Save unavailable")))
  await expect(page.getByRole("button",{name:"Save template"})).toBeEnabled();await expect(page.getByRole("textbox",{name:"Checklist items"})).toHaveValue("Review:\nCheck foundation");assert.deepEqual(await page.evaluate(()=>window.checklistToasts),["Save unavailable"])
  await open();await page.getByRole("button",{name:"New template",exact:true}).click()
  await page.getByRole("textbox",{name:"Template name"}).fill("New checklist");await page.getByRole("textbox",{name:"Checklist items"}).fill("Check framing")
  await page.getByRole("button",{name:"Save template"}).click();await count(1)
  const create=await page.evaluate(()=>({kind:window.checklistActions[0].kind,args:window.checklistActions[0].args}))
  assert.equal(create.kind,"create");assert.equal(create.args[0].name,"New checklist");assert.equal(create.args[0].kind,"quality")
  assert.deepEqual(create.args[0].items,[{section:null,prompt:"Check framing",response_type:"pass_fail"}])
  await page.evaluate(()=>window.checklistActions[0].resolve({success:true,data:{}}));await expect(page.getByRole("region",{name:"Editor"})).toHaveCount(0);assert.equal(await page.evaluate(()=>window.checklistRefreshes),1)
  await open();await archive();assert.deepEqual(await page.evaluate(()=>window.checklistActions[0].args),["a",false])
  await page.evaluate(()=>window.checklistActions[0].resolve({success:true,data:{}}));await expect.poll(()=>page.evaluate(()=>window.checklistRefreshes)).toBe(1)
  await open();await page.evaluate(()=>window.checklistFixture.empty());await page.getByRole("button",{name:"Seed starter templates"}).click();await count(1)
  await page.evaluate(()=>window.checklistActions[0].resolve({success:true,data:2}));await expect.poll(()=>page.evaluate(()=>window.checklistRefreshes)).toBe(1)
  assert.deepEqual(await page.evaluate(()=>window.checklistToasts),["Seeded 2 starter templates"])
  for(const kind of ["read","save","archive","seed"]){for(const reject of [false,true]){
    await open();let index=0
    if(kind==="read"){await select("Checklist A");await count(1)}
    if(kind==="save"){await edit();await page.getByRole("button",{name:"Save template"}).click();await count(2);index=1}
    if(kind==="archive")await archive()
    if(kind==="seed"){await page.evaluate(()=>window.checklistFixture.empty());await page.getByRole("button",{name:"Seed starter templates"}).click();await count(1)}
    await page.evaluate(()=>window.checklistFixture.unmount());await expect(page.getByText("Library removed")).toBeVisible()
    await page.evaluate(({index,reject,kind})=>reject?window.checklistActions[index].reject(new Error("Obsolete failure")):window.checklistActions[index].resolve({success:true,data:kind==="read"?[]:kind==="seed"?2:{}}),{index,reject,kind})
    await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.checklistRefreshes??0),0);assert.equal(await page.evaluate(()=>window.checklistToasts?.length??0),0)
  }}
  await open();await page.evaluate(()=>window.checklistFixture.capabilities(false,false));
  await expect(page.getByRole("button",{name:"New template"})).toBeDisabled();
  await expect(page.getByRole("row").filter({hasText:"Checklist A"}).getByRole("button",{name:"Archive",exact:true})).toBeDisabled();
  await edit();await expect(page.getByRole("button",{name:"Save template"})).toHaveCount(0);
  await expect(page.getByRole("textbox",{name:"Template name"})).toBeDisabled();
  await page.evaluate(()=>document.getElementById("checklist-template-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
  await count(1);
  for(const [manage,seed] of [[true,false],[false,true]]){
    await open();await page.evaluate(({manage,seed})=>{window.checklistFixture.capabilities(manage,seed);window.checklistFixture.empty()},{manage,seed});
    if(manage)await expect(page.getByRole("button",{name:"New template"})).toBeEnabled();else await expect(page.getByRole("button",{name:"New template"})).toBeDisabled();
    if(seed){await expect(page.getByRole("button",{name:"Seed starter templates"})).toBeEnabled();await page.getByRole("button",{name:"Seed starter templates"}).click();await count(1)}else await expect(page.getByRole("button",{name:"Seed starter templates"})).toBeDisabled();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
  console.log("Checklist item reads follow the selected editor, failed reads offer retry, obsolete actions cannot refresh or notify, and read-only/edit/seed capabilities remain independent")
}finally{await browser?.close();server.stop(true)}
