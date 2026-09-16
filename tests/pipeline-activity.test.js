require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { logProspectContactInputSchema } = require('../lib/validation/prospects')
const { describeActivity } = require('../lib/sales/activity')
let state
const supabase = { from(table) {
  assert.equal(table, 'prospects')
  const filters = []
  let update
  const query = {
    select() { return query },
    eq(key,value) { filters.push([key,value]); return query },
    update(value) { update=value; return query },
    maybeSingle: async () => {
      assert.deepEqual(filters, [['org_id','org'],['id','lead']])
      return {data: state.missing ? null : {id:'lead',status:state.status},error:null}
    },
    then(resolve,reject) {
      assert.deepEqual(filters, [['org_id','org'],['id','lead']])
      state.updates.push(update)
      return Promise.resolve({error: state.updateError ? {message:'write failed'} : null}).then(resolve,reject)
    },
  }
  return query
} }
const original = Module._load
Module._load = function(request,...args) {
  const mocks = {
    '@/lib/services/context': {requireOrgContext: async()=>({supabase,orgId:'org',userId:'actor'})},
    '@/lib/services/permissions': { requirePermission: async(permission)=>{ assert.equal(permission,'org.member'); if(state.denied) throw new Error('Forbidden') } },
    '@/lib/services/events': {recordEvent:async(event)=>{state.events.push(event)}},
    '@/lib/services/audit': {recordAudit:async()=>{}},
    '@/lib/services/community-traffic': {recordLeadTraffic:async()=>{}},
    '@/lib/services/party-promotion': {},
  }
  return mocks[request] ?? original.call(this,request,...args)
}
const {logProspectContact} = require('../lib/services/prospects')
Module._load = original
function reset(extra={}) { state={status:'new',events:[],updates:[],...extra} }

test('a contact logs the kind, note and actor and advances a new lead',async()=>{
  reset()
  await logProspectContact({prospectId:'lead',input:{kind:'call',note:'  Discussed scope  '}})
  assert.equal(state.updates[0].status,'contacted')
  assert.equal(state.events[0].eventType,'prospect_contact_logged')
  assert.deepEqual(state.events[0].payload,{kind:'call',note:'Discussed scope',occurred_at:null})
  assert.equal(state.events[0].actorId,'actor')
  assert.equal(state.events[0].orgId,'org')
  assert.equal(state.events[0].entityId,'lead')
  assert.equal(state.events[1].eventType,'prospect_status_changed')
})
test('an internal note preserves a new lead stage and renders its text',async()=>{
  reset()
  await logProspectContact({prospectId:'lead',input:{kind:'note',note:'Review plans\nAsk about budget'}})
  assert.equal(state.updates[0].status,undefined)
  assert.equal(state.events.length,1)
  assert.deepEqual(describeActivity({event_type:'prospect_contact_logged',payload:state.events[0].payload}),{
    title:'Note',note:'Review plans\nAsk about budget',logged:true,kind:'note',
  })
})
test('logging contact preserves advanced and terminal stages',async()=>{
  for(const status of ['qualified','pricing','won','lost']) {
    reset({status})
    await logProspectContact({prospectId:'lead',input:{kind:'email'}})
    assert.equal(state.updates[0].status,undefined)
    assert.equal(state.events.length,1)
  }
})
test('permission, missing-lead and write failures do not report a saved activity',async()=>{
  for(const failure of [{denied:true},{missing:true},{updateError:true}]) {
    reset(failure)
    await assert.rejects(logProspectContact({prospectId:'lead',input:{kind:'visit'}}))
    assert.equal(state.events.length,0)
  }
})
test('activity validation rejects empty notes, unsupported kinds and oversized content',()=>{
  for(const input of [{kind:'note',note:' '},{kind:'unsupported'},{kind:'call',note:'a'.repeat(2001)}]) {
    assert.equal(logProspectContactInputSchema.safeParse(input).success,false)
  }
  assert.equal(logProspectContactInputSchema.safeParse({kind:'call'}).success,true)
})
