require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),{groupRequest}=require('./fixtures/catalog-group-request')
const {persistGroupPublication,readGroupPublication,clearGroupPublication,groupPublicationLockName}=require('../lib/selections/group-publication-recovery')
const request=groupRequest(),scope={orgId:request.expectedOrgId,actorId:request.expectedActorId,communityId:null}
function storage(){const rows=new Map();return {rows,getItem:key=>rows.get(key)??null,setItem:(key,value)=>rows.set(key,value),removeItem:key=>rows.delete(key)}}
test('group recovery preserves exact versions, source, scope and request key without expiry or replacement',()=>{
 const s=storage();persistGroupPublication(s,scope,request);assert.deepEqual(readGroupPublication(s,scope),request)
 for(const other of [{...scope,orgId:request.publicationKey},{...scope,actorId:request.publicationKey},{...scope,communityId:request.publicationKey}])assert.equal(readGroupPublication(s,other),null)
 const changed={...request,expectedCategoryVersions:request.expectedCategoryVersions.map(v=>({...v,definitionHash:'0'.repeat(64)}))}
 assert.throws(()=>persistGroupPublication(s,scope,changed),/previous/);assert.throws(()=>clearGroupPublication(s,scope,changed),/Another/);assert.deepEqual(readGroupPublication(s,scope),request)
 clearGroupPublication(s,scope,request);assert.equal(readGroupPublication(s,scope),null)
})
test('malformed, oversize, foreign-context and storage failures retain evidence and prevent new dispatch',()=>{
 const s=storage(),key=groupPublicationLockName(scope)
 for(const encoded of ['{bad','x'.repeat(512001),JSON.stringify({...request,expectedCategoryVersions:[]}),JSON.stringify({...request,expectedActorId:request.publicationKey})]){s.rows.set(key,encoded);assert.throws(()=>readGroupPublication(s,scope));assert.equal(s.rows.get(key),encoded)}
 s.rows.clear();const save=s.setItem;s.setItem=()=>{};assert.throws(()=>persistGroupPublication(s,scope,request),/could not be saved/);s.setItem=save;persistGroupPublication(s,scope,request);s.removeItem=()=>{};assert.throws(()=>clearGroupPublication(s,scope,request),/could not be cleared/);assert.deepEqual(readGroupPublication(s,scope),request)
})


test('browser recovery and server history use the same canonical assignment order for one reviewed request',()=>{
 const s=storage(),reordered={...request,categoryIds:[...request.categoryIds].reverse()}
 const persisted=persistGroupPublication(s,scope,reordered);assert.deepEqual(persisted.categoryIds,request.categoryIds)
 assert.deepEqual(persistGroupPublication(s,scope,request),request);clearGroupPublication(s,scope,request);assert.equal(readGroupPublication(s,scope),null)
})
