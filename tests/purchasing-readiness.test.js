require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict')
const { createFakeSupabase } = require('./support/fake-supabase')
const { loadPurchasingEnabledByCommunity } = require('../lib/services/purchasing-readiness')
const ORG='org', A='community-a', B='community-b', C='community-c'
function fixture(agreements=[]) {
 return createFakeSupabase({communities:[{id:A,org_id:ORG,division_id:'east'},{id:B,org_id:ORG,division_id:'west'},{id:C,org_id:ORG,division_id:null}],vendor_price_agreements:agreements})
}
function agreement(id,community_id=null,division_id=null,extra={}) {return {id,org_id:ORG,status:'active',community_id,division_id,...extra}}
test('community, division-wide and global agreements enable only matching communities', async()=>{
 const scoped=await loadPurchasingEnabledByCommunity(fixture([agreement('east',null,'east')]),ORG,[A,B,C])
 assert.deepEqual([...scoped],[[A,true],[B,false],[C,false]])
 const community=await loadPurchasingEnabledByCommunity(fixture([agreement('a',A),agreement('bad',B,'east')]),ORG,[A,B,C])
 assert.deepEqual([...community],[[A,true],[B,false],[C,false]])
 const global=await loadPurchasingEnabledByCommunity(fixture([agreement('global')]),ORG,[A,B,C])
 assert.deepEqual([...global],[[A,true],[B,true],[C,true]])
})
test('foreign, inactive and unrelated community agreements do not enable purchasing', async()=>{
 const result=await loadPurchasingEnabledByCommunity(fixture([agreement('foreign',null,null,{org_id:'other'}),agreement('inactive',null,null,{status:'superseded'}),agreement('other','another')]),ORG,[A,B])
 assert.deepEqual([...result],[[A,false],[B,false]])
})
test('a late agreement after 10,000 rows remains visible with at most one returned agreement per probe', async()=>{
 const db=fixture([...Array.from({length:11000},(_,i)=>agreement(`early-${i}`,A)),agreement('late',B)])
 const from=db.from.bind(db),returned=[]
 db.from=table=>{const query=from(table),run=query.run.bind(query);query.run=()=>{const result=run();if(table==='vendor_price_agreements'){assert.equal(query.limitValue,1);returned.push(result.data.length)}return result};return query}
 const result=await loadPurchasingEnabledByCommunity(db,ORG,[A,B])
 assert.deepEqual([...result],[[A,true],[B,true]]);assert.ok(returned.every(count=>count<=1))
})
test('global price books short circuit repeated community probes and duplicate communities are collapsed',async()=>{
 const db=fixture([agreement('global')]),from=db.from.bind(db);let probes=0
 db.from=table=>{if(table==='vendor_price_agreements')probes++;return from(table)}
 const result=await loadPurchasingEnabledByCommunity(db,ORG,[A,A,B])
 assert.equal(probes,1);assert.equal(result.size,2)
})
test('missing or foreign communities fail closed before reading a price book',async()=>{
 const db=fixture([agreement('global')])
 await assert.rejects(loadPurchasingEnabledByCommunity(db,ORG,['missing']),/community unavailable/)
 await assert.rejects(loadPurchasingEnabledByCommunity(db,'other',[A]),/community unavailable/)
 assert.equal((await loadPurchasingEnabledByCommunity(db,ORG,[])).size,0)
 await assert.rejects(loadPurchasingEnabledByCommunity(db,ORG,Array.from({length:201},(_,i)=>`community-${i}`)),/at most 200/)
})
test('read errors and missing evidence never become a disabled-purchasing verdict',async()=>{
 for(const table of ['communities','vendor_price_agreements']){
  const db=fixture(),from=db.from.bind(db)
  db.from=name=>{const query=from(name),run=query.run.bind(query);query.run=()=>name===table?{data:null,error:{message:'Read unavailable'}}:run();return query}
  await assert.rejects(loadPurchasingEnabledByCommunity(db,ORG,[A]),/Read unavailable/)
 }
 const db=fixture(),from=db.from.bind(db)
 db.from=name=>{const query=from(name),run=query.run.bind(query);query.run=()=>name==='vendor_price_agreements'?{data:null,error:null}:run();return query}
 await assert.rejects(loadPurchasingEnabledByCommunity(db,ORG,[A]),/Evidence unavailable/)
})
test('community probes have bounded concurrency and results retain request order',async()=>{
 const ids=Array.from({length:25},(_,i)=>`c-${i}`),db=createFakeSupabase({communities:ids.map(id=>({id,org_id:ORG,division_id:null})),vendor_price_agreements:[]})
 const from=db.from.bind(db);let active=0,max=0
 db.from=table=>{const query=from(table),run=query.run.bind(query);query.run=async()=>{if(table!=='vendor_price_agreements')return run();active++;max=Math.max(max,active);await new Promise(resolve=>setImmediate(resolve));try{return run()}finally{active--}};return query}
 const result=await loadPurchasingEnabledByCommunity(db,ORG,ids)
 assert.ok(max>1 && max<=8);assert.deepEqual([...result.keys()],ids);assert.ok([...result.values()].every(value=>value===false))
})
