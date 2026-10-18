const test=require('node:test'),assert=require('node:assert/strict')
require('../scripts/register-ts-node-test')
const {readPackagePublication,persistPackagePublication,clearPackagePublication,packagePublicationLockName}=require('../lib/selections/package-publication-recovery')
const {packageSchema}=require('../lib/validation/selections')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const scope={orgId:id(1),actorId:id(2),communityId:null}
const request=packageSchema.parse({publicationKey:id(3),requireAtomicPublication:true,expectedOrgId:id(1),expectedActorId:id(2),communityId:null,name:'Kitchen',description:'Reviewed',priceCents:12345,costCents:6789,isAvailable:false,sortOrder:7,optionIds:[id(4)]})
function storage(){const rows=new Map();return {rows,getItem:key=>rows.get(key)??null,setItem:(key,value)=>rows.set(key,value),removeItem:key=>rows.delete(key)}}
test('complete atomic package request round-trips exact identity, money and memberships with scope isolation',()=>{
 const s=storage();persistPackagePublication(s,scope,request);assert.deepEqual(readPackagePublication(s,scope),request)
 for(const other of [{...scope,orgId:id(7)},{...scope,actorId:id(8)},{...scope,communityId:id(9)}])assert.equal(readPackagePublication(s,other),null)
 assert.throws(()=>persistPackagePublication(s,{...scope,actorId:id(8)},request),/different/)
 for(const changed of [{...request,publicationKey:null},{...request,requireAtomicPublication:false}])assert.throws(()=>persistPackagePublication(s,scope,changed),/stable key/)
})
test('cannot replace or clear another saved package and never silently removes malformed recovery',()=>{
 const s=storage();persistPackagePublication(s,scope,request);const changed={...request,name:'Revised'}
 assert.throws(()=>persistPackagePublication(s,scope,changed),/previous/);assert.throws(()=>clearPackagePublication(s,scope,changed),/Another/)
 clearPackagePublication(s,scope,request);assert.equal(readPackagePublication(s,scope),null)
 const key=packagePublicationLockName(scope)
 for(const value of ['{bad','x'.repeat(512001),JSON.stringify({...request,optionIds:[]}),JSON.stringify({...request,expectedOrgId:id(12)})]){
  s.rows.set(key,value);assert.throws(()=>readPackagePublication(s,scope));assert.equal(s.rows.get(key),value)
 }
})
test('storage write and removal failures preserve package recovery safety',()=>{
 const s=storage(),set=s.setItem;s.setItem=()=>{};assert.throws(()=>persistPackagePublication(s,scope,request),/could not be saved/)
 s.setItem=set;persistPackagePublication(s,scope,request);s.removeItem=()=>{};assert.throws(()=>clearPackagePublication(s,scope,request),/could not be cleared/);assert.deepEqual(readPackagePublication(s,scope),request)
})

test('UUID spelling uses one recovery and lock address for the same community',()=>{
 const s=storage(),community='aaaaaaaa-bbbb-4000-8000-cccccccccccc',original={...scope,communityId:community},upper={...scope,communityId:community.toUpperCase()},attempt={...request,communityId:community}
 persistPackagePublication(s,original,attempt)
 assert.equal(packagePublicationLockName(original),packagePublicationLockName(upper))
 assert.deepEqual(readPackagePublication(s,upper),attempt)
 clearPackagePublication(s,upper,attempt);assert.equal(s.rows.size,0)
})
