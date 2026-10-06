import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { chromium, expect } from "@playwright/test"
import babel from "next/dist/compiled/babel/core.js"
import compiler from "babel-plugin-react-compiler"
const built=await Bun.build({entrypoints:["tests/fixtures/dither-lab-lifecycle/ui.jsx"],target:"browser",define:{"process.env.NODE_ENV":'"production"',"process.env":"{}"},plugins:[{name:"dither-fixture",setup(builder){
  builder.onLoad({filter:/(dither-lab-client|slider)\.tsx$/},async({path})=>{
    const source=await readFile(path.endsWith("dither-lab-client.tsx")?(process.env.DITHER_LAB_SOURCE??path):path,"utf8")
    return {loader:"tsx",contents:babel.transformSync(source.replace("export default function DitherLabPage()","export function DitherLabClient()"),{filename:path,configFile:false,babelrc:false,parserOpts:{plugins:["typescript","jsx"]},plugins:[[compiler,{target:"19"}]]}).code}
  })
  builder.onResolve({filter:/^@\/components\/animation\/jaguar-dither$/},()=>({path:"animation",namespace:"fixture"}))
  builder.onLoad({filter:/^animation$/,namespace:"fixture"},()=>({loader:"jsx",contents:`import React from "react";export {DEFAULT_CONFIG} from ${JSON.stringify(`${process.cwd()}/components/animation/jaguar-dither.tsx`)};export function JaguarDither({config,restartSignal}){return <output aria-label="Animation configuration" data-restart={restartSignal}>{JSON.stringify(config)}</output>}`}))
}}]})
assert.ok(built.success,built.logs.join("\n"))
const bundle=await built.outputs[0].text()
const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:request=>new URL(request.url).pathname==="/bundle.js"?new Response(bundle,{headers:{"content-type":"text/javascript"}}):new Response('<html><head><style>[data-slot="slider-thumb"]{display:block;width:16px;height:16px}</style></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>',{headers:{"content-type":"text/html"}})})
let browser
try{
  browser=await chromium.launch({headless:true})
  const page=await browser.newPage(),errors=[],blocked=[],origin=`http://127.0.0.1:${server.port}`
  page.on("pageerror",error=>errors.push(error.message))
  await page.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():(blocked.push(route.request().url()),route.abort()))
  async function open(){await page.goto("about:blank");await page.goto(origin);await expect(page.getByRole("button",{name:"Copy config",exact:true})).toBeVisible()}
  await open();await page.getByRole("button",{name:"Copy config",exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>window.copyCalls?.length)).toBe(1)
  await page.evaluate(()=>window.copyCalls[0].reject(new Error("Clipboard denied")))
  await expect(page.getByRole("alert")).toContainText("Could not copy the configuration")
  await page.getByRole("button",{name:"Copy config",exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.copyCalls.length)).toBe(2)
  await page.evaluate(()=>window.copyCalls[1].resolve());await expect(page.getByRole("button",{name:"Copied!",exact:true})).toBeVisible();await expect(page.getByRole("alert")).toHaveCount(0)
  await expect(page.getByRole("button",{name:"Copy config",exact:true})).toBeVisible({timeout:3000})
  for(const name of ["Loop","Logo intro","Running"])await expect(page.getByRole("switch",{name,exact:true})).toBeVisible()
  for(const name of ["Speed","Jaguar size","Dot gap","Dot radius","Stride period","Hip swing","Knee bend","Body bob","Tail sway","Logo in","Logo hold","Logo out","Dots stagger","Dot fly","Run before loop"])await expect(page.getByRole("slider",{name,exact:true})).toBeVisible()
  const sliders=await page.getByRole("slider").evaluateAll(nodes=>nodes.map(node=>({value:Number(node.getAttribute("aria-valuenow")),min:Number(node.getAttribute("aria-valuemin")),max:Number(node.getAttribute("aria-valuemax"))})))
  assert.ok(sliders.every(({value,min,max})=>value>=min&&value<=max),"default animation values must fit their control ranges")
  await page.getByRole("button",{name:"Pause animation",exact:true}).click();await expect(page.getByRole("button",{name:"Resume animation",exact:true})).toBeVisible()
  await page.getByRole("slider",{name:"Speed",exact:true}).focus();await page.keyboard.press("ArrowRight")
  await page.getByRole("button",{name:"Copy config",exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.copyCalls.length)).toBe(3)
  const copied=await page.evaluate(()=>JSON.parse(window.copyCalls[2].text))
  assert.equal(copied.paused,true);assert.equal(copied.timeScale,1.05)
  await page.evaluate(()=>window.copyCalls[2].resolve());await expect(page.getByRole("button",{name:"Copied!",exact:true})).toBeVisible()
  await page.evaluate(()=>window.ditherFixture.unmount());await expect(page.getByText("Lab removed")).toBeVisible()
  assert.equal(await page.evaluate(()=>window.clearedCopyTimers.includes(window.copyTimers.at(-1))),true)
  for(const reject of [false,true]){
    await open();await page.getByRole("button",{name:"Copy config",exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.copyCalls?.length)).toBe(1)
    await page.evaluate(()=>window.ditherFixture.unmount());await expect(page.getByText("Lab removed")).toBeVisible()
    await page.evaluate(reject=>reject?window.copyCalls[0].reject(new Error("Obsolete copy failure")):window.copyCalls[0].resolve(),reject)
    await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.copyTimers?.length??0),0)
  }
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
  console.log("Dither lab clipboard failures recover, obsolete replies stay silent, timers clean up, and controls have accessible names")
}finally{await browser?.close();server.stop(true)}
