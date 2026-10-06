import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'
const mock = `
export async function uploadDocumentFileDirect(file,options) {
 window.calls=(window.calls??[]).concat(options.transferId);
 options.onStage('uploading');options.onProgress({percent:30});
 if(!window.finishNow) await new Promise((resolve,reject)=>{
   window.finish=resolve;
   options.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});
 });
 if(window.failNext){window.failNext=false;throw Error('Fixture upload failed')}
 options.onStage('finalizing');
 return {id:options.transferId,file_name:file.name};
}
export const uploadDocumentVersionDirect=uploadDocumentFileDirect;
export async function cancelDocumentTransfer(id){window.cancelled=id}
`
const built=await Bun.build({entrypoints:['tests/fixtures/document-transfers/ui.tsx'],target:'browser',define:{'process.env.NODE_ENV':'"production"'},plugins:[{
 name:'isolated-documents',setup(builder){
  builder.onResolve({filter:/services\/files-client$/},()=>({path:'transport',namespace:'fixtures'}));
  builder.onResolve({filter:/documents\/actions$/},()=>({path:'actions',namespace:'fixtures'}));
  builder.onLoad({filter:/.*/,namespace:'fixtures'},args=>({loader:'js',contents:args.path==='transport'?mock:'export async function attachFileAction(){return {success:true}}'}));
 }
}]})
if(!built.success)throw Error(built.logs.join('\n'))
const bundle=await built.outputs[0].text()
const cssSource=readFileSync('app/globals.css','utf8').replace(/@source [^;]+;/g,'')+'\n@source "../components/documents"; @source "../components/ui";'
const styles=await postcss([tailwind()]).process(cssSource,{from:process.cwd()+'/app/globals.css'})
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:req=>new URL(req.url).pathname==='/bundle.js'?new Response(bundle,{headers:{'content-type':'text/javascript'}}):new Response(`<html><head><style>${styles.css}</style></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>`,{headers:{'content-type':'text/html'}})})
let browser
try {
 browser=await chromium.launch({headless:true,executablePath:process.env.ARC_TEST_BROWSER_PATH,channel:process.env.ARC_TEST_BROWSER_CHANNEL})
 const page=await browser.newPage();const errors=[],blocked=[];const origin=`http://127.0.0.1:${server.port}`
 page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();blocked.push(route.request().url());return route.abort()})
 await page.goto(origin)
 await page.getByRole('button',{name:'Queue file',exact:true}).click()
 await page.getByRole('progressbar').waitFor()
 await page.screenshot({path:'/tmp/arc-document-transfers-light.png'})
 await page.evaluate(()=>document.documentElement.classList.add('dark'))
 await page.setViewportSize({width:390,height:844})
 const bounds=await page.getByRole('region',{name:'File transfers'}).boundingBox()
 assert.ok(bounds.x>=0 && bounds.x+bounds.width<=390,'transfer panel fits narrow screens')
 await page.screenshot({path:'/tmp/arc-document-transfers-dark-mobile.png'})
 await page.setViewportSize({width:1280,height:720})
 const firstId=await page.evaluate(()=>window.calls[0])
 await page.getByRole('button',{name:'Navigate',exact:true}).click()
 await page.getByText('Other page',{exact:true}).waitFor()
 assert.equal(await page.getByRole('progressbar').count(),1,'navigation preserves active transfer')
 await page.getByRole('button',{name:'Pause fixture.pdf',exact:true}).click()
 await page.getByRole('button',{name:'Resume fixture.pdf',exact:true}).waitFor()
 await page.reload()
 await page.getByRole('button',{name:'Resume fixture.pdf',exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>window.calls?.length??0),0,'reload never auto resumes')
 await page.evaluate(()=>{window.finishNow=true})
 await page.getByRole('button',{name:'Resume fixture.pdf',exact:true}).click()
 await page.getByText('completed',{exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>window.calls[0]),firstId,'reload preserves operation identity')
 await page.getByRole('button',{name:'Clear finished',exact:true}).click()
 await page.evaluate(()=>{window.failNext=true})
 await page.getByRole('button',{name:'Queue file',exact:true}).click()
 await page.getByText('Fixture upload failed',{exact:true}).waitFor()
 await page.getByRole('button',{name:'Retry fixture.pdf',exact:true}).click()
 await page.getByText('completed',{exact:true}).waitFor()
 await page.getByRole('button',{name:'Clear finished',exact:true}).click()
 await page.evaluate(()=>{window.finishNow=false})
 await page.getByRole('button',{name:'Queue file',exact:true}).click()
 await page.getByRole('button',{name:'Cancel fixture.pdf',exact:true}).click()
 await page.getByText('cancelled',{exact:true}).waitFor()
 assert.ok(await page.evaluate(()=>window.cancelled),'cancellation reaches server control')
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
 console.info('Transfer navigation, durable reload, pause/resume, retry and cancel passed; zero backend requests.')
} finally {await browser?.close();server.stop(true)}
