/** Real revision-review component with deterministic action fixtures; no real backend requests. */
import { chromium } from '@playwright/test'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const revision = {id:'fixture-revision',project_id:'fixture-project',revision_label:'Synthetic revision',issuance_type:'revision',status:'draft',processed_pages:1,total_pages:1}
const overrides = {
  reserveDrawingUploadAction:`async input=>{window.fixtureOperations??={}; const old=window.fixtureOperations[input.operationId]; if(old)return {success:true,data:old}; const data={id:input.operationId,intent:input,status:'reserved',generation:'fixture-generation',storage_path:'fixture/path',transfer_id:null,multipart_upload_id:null};window.fixtureOperations[input.operationId]=data;return {success:true,data}}`,
  getDrawingUploadOperationAction:`async id=>({success:true,data:window.fixtureOperations?.[id]??null})`,
  cancelDrawingUploadAction:`async id=>{const op=window.fixtureOperations[id];op.status='cancelled';return {success:true,data:op}}`,
  createDrawingSetFromUpload:`async input=>{window.fixtureFinalizeCount=(window.fixtureFinalizeCount??0)+1;window.fixtureOperations[input.operationId].status='registered';if(window.fixtureLoseFinalize){window.fixtureLoseFinalize=false;return {success:false,error:'Lost registration response'}}return {success:true,data:{set:{id:'set'},draftRevisionId:'revision'}}}`,

  getDraftRevisionStatusAction:`async()=>location.search.includes('progressive')?({...${JSON.stringify(revision)},status:window.fixtureReady?'draft':'processing',updated_at:window.fixtureReady?'ready':'rendering'}):(${JSON.stringify(revision)})`,
  getRevisionDiffAction:`async()=>{window.fixtureDiffCalls=(window.fixtureDiffCalls??0)+1;return location.search.includes('progressive')?{revision:{...${JSON.stringify(revision)},status:window.fixtureReady?'draft':'processing',updated_at:window.fixtureReady?'ready':'rendering',manifest_complete:!!window.fixtureReady},updated:[],unchanged:[],added:[{sheet_id:'sheet',sheet_number:window.fixtureReady?'AI changed':'A101',sheet_title:'Plan',discipline:'A',change:'added',is_new_sheet:true,rendered:true,verificationStatus:'pending',verification_pending:!window.fixtureReady,needs_number_review:false,draft:{version_id:'version'}}]}:(${JSON.stringify({revision,added:[],updated:[],unchanged:[]})})}`,
  listRecentlyDeletedSheetNumbersAction:'async()=>({success:true,data:[]})',
  publishRevisionAction:'async input=>{window.fixturePublishInput=input;return {success:true,data:null}}',

  discardRevisionAction:'async()=>{window.fixtureDiscardCount=(window.fixtureDiscardCount??0)+1;return {success:true,data:null}}',
}
const build = await Bun.build({entrypoints:['tests/fixtures/drawing-lifecycle/ui.tsx'],target:'browser',define:{'process.env.NODE_ENV':'"production"'},plugins:[{
  name:'drawing-lifecycle-fixtures',setup(builder){
    builder.onResolve({filter:/actions$/},args=>({path:args.path.startsWith('@/')?resolve(args.path.slice(2)+'.ts'):resolve(args.importer,'..',args.path+'.ts'),namespace:'actions'}))
    builder.onLoad({filter:/.*/,namespace:'actions'},args=>({loader:'js',contents:[...readFileSync(args.path,'utf8').matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(([,name])=>`export const ${name}=${overrides[name]??`async()=>{throw Error('Missing fixture action ${name}')}`}`).join('\n')}))
  }
}]})
if(!build.success) throw Error(build.logs.join('\n'))
const bundle = await build.outputs[0].text()
const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>{
  const path=new URL(request.url).pathname
  if(path==='/bundle.js') return new Response(bundle,{headers:{'content-type':'text/javascript'}})
  if(path==='/') return new Response('<html><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>',{headers:{'content-type':'text/html'}})
  return new Response('Fixture route missing',{status:404})
}})
let browser
try {
  browser=await chromium.launch({headless:true,executablePath:process.env.ARC_TEST_BROWSER_PATH,channel:process.env.ARC_TEST_BROWSER_CHANNEL})
  const context=await browser.newContext({reducedMotion:"reduce"})
  const page=await context.newPage()
  const origin=`http://127.0.0.1:${server.port}`
  const blocked=[],errors=[]
  await page.route('**/*',route=>{
    const url=new URL(route.request().url())
    if(url.origin===origin && ['/', '/bundle.js'].includes(url.pathname)) return route.continue()
    blocked.push(url.origin); return route.abort()
  })
  page.on('pageerror',error=>errors.push(error.message))
  await page.goto(origin)
  await page.getByRole('heading',{name:'Review issuance'}).waitFor()
  await page.getByRole('button',{name:'Discard draft',exact:true}).click()
  await page.getByRole('heading',{name:'Discard this draft?'}).waitFor()
  await page.getByRole('button',{name:'Discard',exact:true}).click()
  await page.getByText('Deletion acknowledged',{exact:true}).waitFor()
  assert.equal(await page.evaluate(()=>window.fixtureDiscardCount),1)
  assert.deepEqual(errors,[])
  assert.deepEqual(blocked,[])
  console.info('Real revision review and deletion acknowledgement passed; zero backend requests.')
  await page.goto(origin+'/?progressive')
  // Typing the number of an unverified page is the reviewer's confirmation of its identity.
  const sheetNumber=page.getByLabel('Sheet number',{exact:true})
  await sheetNumber.waitFor()
  const publish=page.getByRole('button',{name:'Publish 1 sheet',exact:true})
  await sheetNumber.focus();await page.keyboard.press('ControlOrMeta+A');await page.keyboard.type('HUMAN101')
  assert.equal(await publish.count(),0,'A package still processing must not offer publication despite confirmation')
  await page.getByRole('button',{name:'Continue in background',exact:true}).waitFor()
  await page.evaluate(()=>{window.fixtureReady=true})
  await page.waitForFunction(()=>window.fixtureDiffCalls>=2)
  assert.equal(await sheetNumber.inputValue(),'HUMAN101','Polling must preserve human edits against late AI')
  assert.equal(await publish.isEnabled(),true,'Human confirmation must allow publication despite pending AI')
  await publish.click()
  await page.getByText('Publication acknowledged',{exact:true}).waitFor()
  const published=await page.evaluate(()=>window.fixturePublishInput)
  assert.equal(published.sheetEdits.sheet.version_id,'version');assert.equal(published.sheetEdits.sheet.identity_reviewed,true)
  assert.equal(published.sheetEdits.sheet.sheet_number,'HUMAN101')
  console.info('Progressive review, typed identity confirmation, processing gate and preservation of edits across late AI refresh passed.')
  await page.unroute('**/*')
  const puts=[],controls=[]
  let holdPut = true, completed = false
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url())
    if(url.origin!==origin){blocked.push(url.origin);return route.abort()}
    if(['/', '/bundle.js'].includes(url.pathname))return route.continue()
    const json=data=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)})
    if(url.pathname==='/fixture-part'){
      puts.push(1)
      if(holdPut)return // The aborted XHR will be discarded when resuming.
      return route.fulfill({status:200,headers:{ETag:'fixture-etag'}})
    }
    const body=route.request().postDataJSON();controls.push(url.pathname)
    if(url.pathname.endsWith('/create'))return json({provider:'r2',storagePath:'fixture/path',uploadId:'fixture-upload',partSize:16*1024*1024})
    if(url.pathname.endsWith('/part-urls'))return json({parts:body.partNumbers.map(partNumber=>({partNumber,uploadUrl:origin+'/fixture-part'}))})
    if(url.pathname.endsWith('/part-url'))return json({uploadUrl:origin+'/fixture-part'})
    if(url.pathname.endsWith('/status'))return json(completed?{state:'completed'}:{state:'uploading',parts:[]})
    if(url.pathname.endsWith('/complete')){completed=true;return json({ok:true})}
    blocked.push(url.pathname);return route.abort()
  })
  await page.context().addCookies([{name:'org_id',value:'fixture-org',url:origin}])
  await page.goto(origin+'/?upload')
  await page.getByLabel('Choose fixture PDF').setInputFiles({name:'plans.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF fixture')})
  await page.getByRole('button',{name:'Upload package',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('[aria-label="Operation state"]').textContent==='transferring')
  await page.getByRole('button',{name:'Pause upload'}).click()
  await page.waitForFunction(()=>document.querySelector('[aria-label="Operation state"]').textContent==='paused')
  holdPut=false
  await page.evaluate(()=>{window.fixtureLoseFinalize=true})
  await page.getByRole('button',{name:'Resume upload'}).click()
  await page.getByLabel('Upload error').filter({hasText:'Lost registration response'}).waitFor()
  const putsBeforeRetry=puts.length
  await page.getByRole('button',{name:'Resume upload'}).click()
  await page.waitForFunction(()=>document.querySelector('[aria-label="Operation state"]').textContent==='completed')
  assert.equal(puts.length,putsBeforeRetry,'Registration retry must not transfer PDF again')
  completed=false
  await page.getByRole('button',{name:'Replace sheet',exact:true}).click()
  await page.waitForFunction(()=>Object.values(window.fixtureOperations).some(op=>op.intent.targetSheetId==='fixture-sheet'&&op.status==='registered'))
  assert.equal(await page.evaluate(()=>window.fixtureFinalizeCount),3)
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('arc-drawing-upload:')).length),0,'Registration must clear the generation-specific transfer receipt')
  holdPut=true;completed=false
  await page.getByRole('button',{name:'Upload package',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('[aria-label="Operation state"]').textContent==='transferring')
  await page.getByRole('button',{name:'Cancel upload'}).click()
  await page.waitForFunction(()=>document.querySelector('[aria-label="Operation state"]').textContent==='cancelled')
  await page.waitForTimeout(100)
  assert.equal(await page.getByLabel('Operation state').textContent(),'cancelled','A late run catch must not overwrite cancellation with paused')
  await page.getByRole('button',{name:'Upload package',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('[aria-label="Operation state"]').textContent==='transferring')
  const second=await page.context().newPage()
  await second.route('**/*',route=>{
    const url=new URL(route.request().url())
    if(url.origin===origin && ['/', '/bundle.js'].includes(url.pathname))return route.continue()
    blocked.push(url.pathname);return route.abort()
  })
  await second.goto(origin+'/?upload')
  await second.getByLabel('Choose fixture PDF').setInputFiles({name:'plans.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF fixture')})
  await second.getByRole('button',{name:'Upload package',exact:true}).click()
  await second.getByLabel('Upload error').filter({hasText:'another tab'}).waitFor()
  await second.close()
  await page.getByRole('button',{name:'Cancel upload'}).click()
  await page.waitForFunction(()=>document.querySelector('[aria-label="Operation state"]').textContent==='cancelled')
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
  console.info('Cross-tab Web Lock prevents a second upload owner.')
  console.info('Real shared upload hook: package pause/resume, lost registration response with zero repeat PUTs, and single-sheet replacement passed.')
} finally {await browser?.close(); server.stop(true)}
