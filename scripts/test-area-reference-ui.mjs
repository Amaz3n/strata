/** Isolated tracing interaction regression. Synthetic source, no application/server access. */
import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'
const build=await Bun.build({entrypoints:['scripts/area-review/editor.js'],target:'browser'})
if(!build.success)throw Error(build.logs.join('\n'))
const browser=await chromium.launch({headless:true,channel:process.env.ARC_TEST_BROWSER_CHANNEL,executablePath:process.env.ARC_TEST_BROWSER_PATH})
try{
 const page=await browser.newPage(),errors=[]
 page.on('pageerror',error=>errors.push(error.message))
 await page.setContent(`<input id="label"><input id="author"><input id="scope"><select id="category"></select><select id="completeness"></select><input id="zoom"><input id="resume" type="file"><select id="areas"></select><div id="count"></div><div id="status"></div>${['finish','undo','cancel','hole','remove','save'].map(id=>`<button id="${id}">${id}</button>`).join('')}<div id="canvas" style="position:absolute;top:180px;left:20px"><svg id="drawing" width="600" height="600" viewBox="0 0 1000 1000"></svg></div><script id="fixture" type="application/json">{"input":{"imageWidth":1000,"imageHeight":1000,"feetPerImagePx":0.02}}</script>`)
 await page.addScriptTag({content:await build.outputs[0].text(),type:'module'})
 await page.waitForFunction(()=>document.getElementById('count').textContent==='0 reference areas')
 const box=await page.locator('#drawing').boundingBox()
 const click=async(x,y)=>page.mouse.click(box.x+x,box.y+y)
 await page.locator('#label').fill('Room')
 for(const [x,y] of [[60,60],[240,60],[240,240],[60,240],[60,60]])await click(x,y)
 assert.equal(await page.locator('#areas option').count(),1,'clicking the first corner closes the area: '+await page.locator('#status').innerText()+' errors: '+JSON.stringify(errors))
 await page.locator('#hole').click()
 for(const [x,y] of [[90,90],[120,90],[120,120],[90,120],[90,90]])await click(x,y)
 assert.match(await page.locator('#areas option').innerText(),/1 deductions/)
 await page.locator('#label').fill('Second room')
 await click(300,60);await click(480,60);await click(480,60);await click(480,240);await click(300,240)
 await page.keyboard.press('Enter')
 assert.equal(await page.locator('#areas option').count(),2,'duplicate corner is ignored and Enter closes')
 for(const [x,y] of [[60,300],[240,480],[60,480],[240,300]])await click(x,y)
 await page.locator('#finish').click()
 assert.match(await page.locator('#status').innerText(),/crosses or retraces/)
 assert.equal(await page.locator('#areas option').count(),2,'self-crossing boundary remains rejected')
 assert.deepEqual(errors,[])
 console.log('Passed: click-to-close area and deduction, duplicate-click suppression, Enter closure, crossing rejection.')
}finally{await browser.close()}
