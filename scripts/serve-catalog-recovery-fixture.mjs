import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve, sep } from 'node:path'
import ts from 'typescript'

// Isolated synthetic browser evidence: never load app configuration or credentials.
const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
const zodRoot = dirname(require.resolve('zod'))
const modules = {
  '/modules/selections.js': 'lib/validation/selections.ts',
  '/modules/price.js': 'lib/selections/price-publication-recovery.ts',
  '/modules/package.js': 'lib/selections/package-publication-recovery.ts',
}
const source = String.raw`
import * as price from '/modules/price.js';
import * as pack from '/modules/package.js';
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const scope={orgId:id(1),actorId:id(2),communityId:null};
const priceRequest={publicationKey:id(3),expectedOrgId:id(1),expectedActorId:id(2),communityId:null,items:[{optionId:id(4),housePlanVersionId:id(5),priceCents:12345,isAvailable:false,expectedPrice:{id:id(6),price_cents:11111,is_available:true}}]};
const packageRequest={publicationKey:id(10),requireAtomicPublication:true,expectedOrgId:id(1),expectedActorId:id(2),communityId:null,name:'Synthetic kitchen',description:'Reviewed fixture',imageUrl:null,priceCents:23456,costCents:12345,isAvailable:true,sortOrder:7,optionIds:[id(4)]};
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const check=(condition,message)=>{if(!condition)throw Error(message)};
const rejected=fn=>{try{fn();return false}catch{return true}};
const output=value=>document.querySelector('output').textContent=value;
let sequence=0;
if(location.pathname==='/peer'){
 addEventListener('message',event=>{
  if(event.origin!==location.origin || event.source!==parent)return;
  const {token,operation,key}=event.data;
  if(operation==='lock'){
   const held=navigator.locks.request(key,()=>parent.postMessage({token,state:'entered'},location.origin));
   parent.postMessage({token,state:'queued'},location.origin);
   held.catch(error=>parent.postMessage({token,error:error.message},location.origin));
  }else if(operation==='read'){
   try{parent.postMessage({token,value:price.readPricePublication(localStorage,scope)},location.origin)}catch(error){parent.postMessage({token,error:error.message},location.origin)}
  }
 });
}else{
 const peer=document.querySelector('iframe');
 const ask=(operation,key)=>{
  const token=++sequence;let queuedResolve,enteredResolve;
  const queued=new Promise(resolve=>queuedResolve=resolve),entered=new Promise(resolve=>enteredResolve=resolve);
  const listener=event=>{
   if(event.origin!==location.origin || event.source!==peer.contentWindow || event.data.token!==token)return;
   if(event.data.state==='queued')queuedResolve();
   else {removeEventListener('message',listener);enteredResolve(event.data)}
  };
  addEventListener('message',listener);peer.contentWindow.postMessage({token,operation,key},location.origin);
  return {queued,entered};
 };
 const action=(id,fn)=>document.getElementById(id).onclick=async()=>{try{await fn()}catch(error){output('FAIL: '+error.message)}};
 action('checks',async()=>{
  check(!!navigator.locks,'Web Locks unavailable');let passed=0;
  const verified=price.persistPricePublication(localStorage,scope,priceRequest);
  check(equal(verified,price.readPricePublication(localStorage,scope)),'Price source changed');passed++;
  check(price.readPricePublication(localStorage,{...scope,actorId:id(99)})===null,'Actor isolation failed');passed++;
  check(rejected(()=>price.persistPricePublication(localStorage,scope,{...priceRequest,publicationKey:id(98)})),'Pending price overwritten');passed++;
  const read=await ask('read').entered;check(equal(read.value,verified),'Peer storage differs');passed++;
  let entered=false,reply;
  await navigator.locks.request(price.pricePublicationLockName(scope),async()=>{
   reply=ask('lock',price.pricePublicationLockName(scope));reply.entered.then(()=>entered=true);
   await reply.queued;check(!entered,'Peer entered an exclusive held lock');passed++;
  });
  const released=await reply.entered;check(released.state==='entered','Peer failed to acquire released lock');passed++;
  price.clearPricePublication(localStorage,scope,priceRequest);check(price.readPricePublication(localStorage,scope)===null,'Price receipt not cleared');passed++;
  const bundle=pack.persistPackagePublication(localStorage,scope,packageRequest);
  check(equal(bundle,pack.readPackagePublication(localStorage,scope)),'Package source changed');passed++;
  check(rejected(()=>pack.clearPackagePublication(localStorage,scope,{...packageRequest,publicationKey:id(97)})),'Another package cleared recovery');passed++;
  pack.clearPackagePublication(localStorage,scope,packageRequest);check(pack.readPackagePublication(localStorage,scope)===null,'Package recovery not cleared');passed++;
  const community='aaaaaaaa-bbbb-4000-8000-cccccccccccc';check(price.pricePublicationLockName({...scope,communityId:community})===price.pricePublicationLockName({...scope,communityId:community.toUpperCase()}),'UUID lock address differs');passed++;
  output('PASS: '+passed+' real browser checks. Exact storage, peer storage, exclusive Web Locks and release verified.');
 });
 action('store',()=>{
  price.persistPricePublication(localStorage,scope,priceRequest);pack.persistPackagePublication(localStorage,scope,packageRequest);
  output('Pending price and package stored. Reload this page, then review recovery.');
 });
 action('review',()=>{
  const p=price.readPricePublication(localStorage,scope),b=pack.readPackagePublication(localStorage,scope);
  check(p&&b,'Both saved requests must survive reload');
  check(equal(p,priceRequest),'Price baseline changed during reload');
  check(b.publicationKey===packageRequest.publicationKey&&b.priceCents===23456&&b.costCents===12345&&equal(b.optionIds,packageRequest.optionIds),'Package changed during reload');
  output('PASS: Reload recovered exact price and package keys, costs, cents, source baselines and memberships.');
 });
 action('clear',()=>{
  price.clearPricePublication(localStorage,scope,priceRequest);pack.clearPackagePublication(localStorage,scope,packageRequest);
  check(price.readPricePublication(localStorage,scope)===null&&pack.readPackagePublication(localStorage,scope)===null,'Recovery not cleared');
  output('PASS: Exact synthetic requests cleared.');
 });
 peer.onload=()=>{document.querySelectorAll('button').forEach(button=>button.disabled=false);output('Ready. Synthetic fixture only; no Arc backend or credentials.');};
 peer.src='/peer';
}
`
const html = peer => `<!doctype html><html><head><meta charset="utf-8"><title>Isolated catalog recovery verification</title></head><body><h1>Catalog recovery browser fixture</h1><p>Synthetic data only. Actual Arc recovery helpers and validation; browser storage and Web Locks.</p>${peer ? '' : '<button id="checks" disabled>Run browser checks</button> <button id="store" disabled>Store pending requests</button> <button id="review" disabled>Review recovery after reload</button> <button id="clear" disabled>Clear exact fixture requests</button><p><output>Loading fixture</output></p><iframe title="Independent same-origin lock context" hidden></iframe>'}<script type="module" src="/fixture.js"></script></body></html>`
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://fixture.invalid').pathname
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return }
    let data, type='text/javascript'
    if (modules[path]) {
      data=ts.transpileModule(await readFile(resolve(root,modules[path]),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
        .replaceAll('"@/lib/validation/selections"','"/modules/selections.js"').replaceAll('"zod"','"/zod/index.js"')
    } else if (path==='/fixture.js') data=source
    else if (path==='/' || path==='/peer') {data=html(path==='/peer');type='text/html'}
    else if (path.startsWith('/zod/') && path.endsWith('.js')) {
      const file=resolve(zodRoot,path.slice(5))
      if(!file.startsWith(zodRoot+sep))throw new Error('Invalid dependency path')
      data=await readFile(file,'utf8')
    } else {response.writeHead(404);response.end();return}
    response.writeHead(200,{'content-type':type,'cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self'; frame-src 'self'; connect-src 'none'"});response.end(data)
  } catch {response.writeHead(500);response.end('Fixture module unavailable')}
})
server.listen(Number(process.env.ARC_CATALOG_RECOVERY_FIXTURE_PORT ?? 0),'127.0.0.1',()=>console.log(`Isolated fixture: http://127.0.0.1:${server.address().port}`))
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)))
