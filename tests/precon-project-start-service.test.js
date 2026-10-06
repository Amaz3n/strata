require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict'), Module = require('node:module')
const prospectId='30000000-0000-0000-0000-000000000001', projectId='50000000-0000-0000-0000-000000000001'
let allowed, missing, lookupError, linked, calls, permission
function reset(){ allowed=true; missing=false; lookupError=null; linked=null; calls=[]; permission=null }
const db={from(table){const q={select(){return q},eq(){return q},async maybeSingle(){return table==='prospects'?{data:missing?null:{id:prospectId}}:{data:linked,error:lookupError}}};return q},async rpc(name,args){calls.push({name,args});return {data:{projectId,alreadyStarted:false}}}}
const original=Module._load
Module._load=function(name,...args){return ({'server-only':{},'@/lib/services/context':{requireOrgContext:async()=>({supabase:db,orgId:'org',userId:'actor',productTier:'residential'})},'@/lib/services/authorization':{requireAuthorization:async value=>{permission=value;if(!allowed)throw Error('Forbidden')}},'@/lib/supabase/server':{createServiceSupabaseClient:()=>db}})[name]??original.call(this,name,...args)}
const {startProspectProject}=require('../lib/services/precon-project-start');Module._load=original
test('project start authorizes the linked project before scoped transaction',async()=>{reset();linked={id:projectId};await startProspectProject(prospectId);assert.equal(permission.permission,'project.manage');assert.equal(permission.projectId,projectId);assert.deepEqual(calls[0],{name:'start_prospect_project',args:{p_org_id:'org',p_prospect_id:prospectId,p_actor_id:'actor',p_expected_project_id:projectId,p_property_type:'residential'}})})
test('missing prospects, inaccessible projects, and failed lookups never reach writes',async()=>{for(const setup of [()=>{missing=true},()=>{allowed=false;linked={id:projectId}},()=>{lookupError={message:'lookup failed'}}]){reset();setup();await assert.rejects(startProspectProject(prospectId));assert.equal(calls.length,0)}})
