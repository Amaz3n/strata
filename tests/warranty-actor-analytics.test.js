require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {createFakeSupabase}=require('./support/fake-supabase')
const {ORG,ACTOR,COMMUNITY,PROJECT}=require('./support/starts-harness')
const {warrantyActorAnalyticsEnabled,readActorWarrantyAnalytics}=require('../lib/services/warranty-actor-analytics')
test('analytics rollout is default-off and rejects missing/malformed/expiring configuration',async()=>{
 const db=createFakeSupabase({feature_flags:[]})
 assert.equal(await warrantyActorAnalyticsEnabled(db,ORG),false)
 db.store.feature_flags=[{org_id:ORG,flag_key:'warranty_actor_analytics',enabled:true,expires_at:null}]
 assert.equal(await warrantyActorAnalyticsEnabled(db,ORG),true)
 db.store.feature_flags[0].expires_at='2026-11-01';await assert.rejects(warrantyActorAnalyticsEnabled(db,ORG),/expiring rollout/)
 db.store.feature_flags[0].enabled='yes';await assert.rejects(warrantyActorAnalyticsEnabled(db,ORG))
})
test('cost analytics validates trusted actor and monetary result rather than coercing missing values',async()=>{
 const db=createFakeSupabase(),calls=[]
 let result=[{community_id:COMMUNITY,community_name:'Community',warranty_cost_cents:100,recovered_cents:20,net_cost_cents:80,closed_revenue_cents:10000,cost_percent:0.8}]
 db.rpc=async(name,args)=>{calls.push({name,args});return{data:result,error:null}}
 const input={supabase:db,orgId:ORG,actorId:ACTOR,kind:'cost',divisionId:PROJECT,communityId:COMMUNITY}
 assert.equal((await readActorWarrantyAnalytics(input))[0].warranty_cost_cents,100)
 assert.equal(calls[0].name,'warranty_cost_summary_for_actor');assert.equal(calls[0].args.p_actor_id,ACTOR);assert.equal(calls[0].args.p_community_id,COMMUNITY)
 result=[{...result[0],warranty_cost_cents:Number.MAX_SAFE_INTEGER+1}];await assert.rejects(readActorWarrantyAnalytics(input))
 result=null;await assert.rejects(readActorWarrantyAnalytics(input))
 db.rpc=async()=>({data:null,error:{message:'Missing approved RPC'}});await assert.rejects(readActorWarrantyAnalytics(input),/Missing approved RPC/)
})
