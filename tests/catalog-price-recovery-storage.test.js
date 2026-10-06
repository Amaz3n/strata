const test=require('node:test'),assert=require('node:assert/strict')
require('../scripts/register-ts-node-test')
const {readPricePublication,persistPricePublication,clearPricePublication,pricePublicationLockName}=require('../lib/selections/price-publication-recovery')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const scope={orgId:id(1),actorId:id(2),communityId:null}
const request={publicationKey:id(3),expectedOrgId:id(1),expectedActorId:id(2),communityId:null,items:[{optionId:id(4),housePlanVersionId:id(5),priceCents:12345,isAvailable:false,expectedPrice:{id:id(6),price_cents:11111,is_available:true}}]}
function storage(){const rows=new Map();return {rows,getItem:key=>rows.get(key)??null,setItem:(key,value)=>rows.set(key,value),removeItem:key=>rows.delete(key)}}
test('saved batch round-trips complete reviewed baselines and is isolated across organization, actor and community',()=>{
 const s=storage();persistPricePublication(s,scope,request)
 assert.deepEqual(readPricePublication(s,scope),request)
 for(const other of [{...scope,orgId:id(7)},{...scope,actorId:id(8)},{...scope,communityId:id(9)}])assert.equal(readPricePublication(s,other),null)
 assert.throws(()=>persistPricePublication(s,{...scope,actorId:id(8)},request),/different/)
 assert.equal(s.rows.size,1)
})
test('pending request cannot be replaced, cleared by another request or expired by local time',()=>{
 const s=storage();persistPricePublication(s,scope,request)
 const changed={...request,publicationKey:id(10)}
 assert.throws(()=>persistPricePublication(s,scope,changed),/previous/)
 assert.throws(()=>clearPricePublication(s,scope,changed),/Another/)
 persistPricePublication(s,scope,request);assert.deepEqual(readPricePublication(s,scope),request)
 clearPricePublication(s,scope,request);assert.equal(readPricePublication(s,scope),null)
})
test('corrupted, oversized, invalid or scope-forged stored requests fail without erasing recovery',()=>{
 const s=storage(),key=pricePublicationLockName(scope)
 for(const value of ['{bad','x'.repeat(512001),JSON.stringify({...request,items:[]}),JSON.stringify({...request,expectedOrgId:id(12)})]){
  s.rows.set(key,value);assert.throws(()=>readPricePublication(s,scope));assert.equal(s.rows.get(key),value)
 }
})
test('silent storage write and remove failures are detected without submitting or discarding identity',()=>{
 const s=storage(),set=s.setItem,remove=s.removeItem
 s.setItem=()=>{};assert.throws(()=>persistPricePublication(s,scope,request),/could not be saved/)
 s.setItem=set;persistPricePublication(s,scope,request);s.removeItem=()=>{}
 assert.throws(()=>clearPricePublication(s,scope,request),/could not be cleared/);assert.deepEqual(readPricePublication(s,scope),request)
 s.removeItem=remove;clearPricePublication(s,scope,request)
})

test('UUID spelling uses one recovery and lock address for the same community',()=>{
 const s=storage(),community='aaaaaaaa-bbbb-4000-8000-cccccccccccc',original={...scope,communityId:community},upper={...scope,communityId:community.toUpperCase()},attempt={...request,communityId:community}
 persistPricePublication(s,original,attempt)
 assert.equal(pricePublicationLockName(original),pricePublicationLockName(upper))
 assert.deepEqual(readPricePublication(s,upper),attempt)
 clearPricePublication(s,upper,attempt);assert.equal(s.rows.size,0)
})
