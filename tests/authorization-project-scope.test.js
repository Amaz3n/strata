require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {createFakeSupabase}=require('./support/fake-supabase')
const {stubModule,ORG,PROJECT,PACKAGE}=require('./support/starts-harness')
// Support grants are read through the real SQL function's contract: open,
// unexpired, for this operator in this organization (expiry is Postgres' clock).
const activeGrants=({p_operator_user_id,p_org_id},store)=>({error:null,data:(store.platform_access_grants??[]).filter(g=>
 g.operator_user_id===p_operator_user_id&&g.org_id===p_org_id&&!g.ended_at&&Date.parse(g.expires_at)>Date.now())})
function harness(){
 const role={permissions:[{permission_key:'project.read'},{permission_key:'warranty.manage'}]}
 const db=createFakeSupabase({permissions:[{key:'warranty.manage'},{key:'members.manage'},{key:'platform.org.access'},{key:'platform.billing.manage'}],projects:[{id:PROJECT,org_id:ORG,division_id:PACKAGE}],memberships:[{id:PACKAGE,org_id:ORG,user_id:PACKAGE,status:'active',project_scope:'all',division_scope:'assigned',role}],membership_divisions:[{membership_id:PACKAGE,division_id:PACKAGE}]},{active_platform_access_grants:activeGrants})
 stubModule('@/lib/supabase/server',{createServiceSupabaseClient:()=>db})
 delete process.env.SUPERADMIN_IDS
 for(const m of ['../lib/auth/platform','../lib/services/authorization'])delete require.cache[require.resolve(m)]
 const service=require('../lib/services/authorization')
 const input={permission:'warranty.manage',orgId:ORG,userId:PACKAGE,projectId:PROJECT}
 return {db,service,input,admin:()=>{process.env.SUPERADMIN_IDS=PACKAGE}}
}
test('single and batch authorization enforce current division and organization identity',async()=>{
 const h=harness();assert.equal((await h.service.authorize(h.input)).allowed,true)
 h.db.store.projects[0].division_id=PROJECT
 const denied=await h.service.authorize(h.input);assert.equal(denied.allowed,false);assert.equal(denied.reasonCode,'deny_division_scope')
 await assert.rejects(h.service.requireAuthorization(h.input),e=>e.reasonCode==='deny_division_scope')
 assert.equal((await h.service.authorizeMany({...h.input,projectIds:[PROJECT]})).get(PROJECT),false)
 h.db.store.projects[0].division_id=null;assert.equal((await h.service.authorize(h.input)).allowed,false)
 h.db.store.projects[0].org_id=PACKAGE
 assert.equal((await h.service.authorize(h.input)).reasonCode,'deny_project_org_mismatch')
 assert.equal((await h.service.authorizeMany({...h.input,projectIds:[PROJECT]})).get(PROJECT),false)
})
test('all-division and base org-admin access remain valid while explicit deny wins',async()=>{
 const h=harness();h.db.store.memberships[0].division_scope='all';h.db.store.projects[0].division_id=null
 assert.equal((await h.service.authorize(h.input)).allowed,true)
 h.db.store.memberships[0].division_scope='assigned';h.db.store.memberships[0].role.permissions.push({permission_key:'org.admin'})
 assert.equal((await h.service.authorize(h.input)).allowed,true)
 h.db.store.membership_permission_overrides=[{membership_id:PACKAGE,permission_key:'warranty.manage',effect:'deny'}]
 assert.equal((await h.service.authorize(h.input)).allowed,false)
})
test('administrator shortcuts still reject foreign or missing project identity',async()=>{
 const h=harness();h.admin();assert.equal((await h.service.authorize(h.input)).allowed,true)
 h.db.store.projects[0].org_id=PACKAGE
 assert.equal((await h.service.authorize(h.input)).allowed,false)
 assert.equal((await h.service.authorizeMany({...h.input,projectIds:[PROJECT]})).get(PROJECT),false)
 h.db.store.projects=[];assert.equal((await h.service.authorize(h.input)).allowed,false)
})
test('project identity can resolve organization but foreign membership rows cannot grant home permissions',async()=>{
 const h=harness();delete h.input.orgId
 assert.equal((await h.service.authorize(h.input)).orgId,ORG)
 h.db.store.memberships[0].role.permissions=[{permission_key:'project.read'}]
 h.db.store.project_members=[{id:PROJECT,project_id:PROJECT,org_id:PACKAGE,user_id:PACKAGE,status:'active',role:{permissions:[{permission_key:'warranty.manage'}]}}]
 assert.equal((await h.service.authorize(h.input)).allowed,false)
 h.db.store.project_members[0].org_id=ORG;assert.equal((await h.service.authorize(h.input)).allowed,true)
})
test('batch authorizes complete project sets with bounded home and membership catalogs',async()=>{
 const h=harness();h.db.store.memberships[0].division_scope='all'
 const id=n=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`
 h.db.store.projects=Array.from({length:1201},(_,i)=>({id:id(i+1),org_id:ORG,division_id:null}))
 const ids=h.db.store.projects.map(r=>r.id),from=h.db.from.bind(h.db);let largest=0
 h.db.from=table=>{const q=from(table),inside=q.in.bind(q);q.in=(column,values)=>{largest=Math.max(largest,values.length);return inside(column,values)};return q}
 const results=await h.service.authorizeMany({...h.input,projectIds:ids})
 assert.equal(results.size,1201);assert.ok([...results.values()].every(Boolean));assert.ok(largest<=100)
})
test('scope read failures fail closed even for privileged callers',async()=>{
 const h=harness();h.admin();const from=h.db.from.bind(h.db)
 h.db.from=t=>{const q=from(t);if(t==='projects')q.run=()=>({data:null,error:{message:'Identity unavailable'}});return q}
 await assert.rejects(h.service.authorize(h.input),/Identity unavailable/)
 await assert.rejects(h.service.authorizeMany({...h.input,projectIds:[PROJECT]}),/Identity unavailable/)
})

test('desk scope derives predicates without enumerating homes and matches org access policy',async()=>{
 const h=harness(),tables=[],from=h.db.from.bind(h.db)
 h.db.from=t=>{tables.push(t);return from(t)}
 const scope=()=>h.service.getProjectReadScopeForUser({orgId:ORG,userId:PACKAGE})
 assert.deepEqual(await scope(),{divisionIds:[PACKAGE],projectMembershipRequired:false})
 h.db.store.memberships[0].project_scope='assigned'
 assert.deepEqual(await scope(),{divisionIds:[PACKAGE],projectMembershipRequired:true})
 h.db.store.membership_permission_overrides=[{membership_id:PACKAGE,permission_key:'org.admin',effect:'grant'}]
 assert.deepEqual(await scope(),{divisionIds:[PACKAGE],projectMembershipRequired:false})
 h.db.store.memberships[0].role.permissions.push({permission_key:'org.admin'})
 assert.deepEqual(await scope(),{divisionIds:null,projectMembershipRequired:false})
 assert.ok(!tables.includes('projects'));assert.ok(!tables.includes('project_members'))
})
test('desk scope includes wildcard, platform and empty division cases and fails on permission read error',async()=>{
 const h=harness(),scope=()=>h.service.getProjectReadScopeForUser({orgId:ORG,userId:PACKAGE})
 h.db.store.membership_divisions=[]
 assert.deepEqual(await scope(),{divisionIds:[],projectMembershipRequired:false})
 h.db.store.memberships[0].project_scope='assigned'
 h.db.store.memberships[0].role.permissions.push({permission_key:'*'})
 assert.deepEqual(await scope(),{divisionIds:[],projectMembershipRequired:false})
 // Platform standing never widens a real membership's division scope.
 h.db.store.platform_memberships=[{user_id:PACKAGE,status:'active',role:{permissions:[{permission_key:'platform.org.access'}]}}]
 assert.deepEqual(await scope(),{divisionIds:[],projectMembershipRequired:false})
 const from=h.db.from.bind(h.db)
 h.db.from=t=>{const q=from(t);if(t==='memberships')q.run=()=>({data:null,error:{message:'Scope unavailable'}});return q}
 await assert.rejects(scope(),/Scope unavailable/)
 h.admin();await assert.rejects(scope(),/Scope unavailable/)
})

// --- Arc staff inside a customer organization ---------------------------------
// Owners have direct access. Other staff need an open support grant when
// they do not belong, and otherwise act as their actual membership.

const OTHER_ORG='00000000-0000-4000-8000-0000000000aa',OTHER_PROJECT='00000000-0000-4000-8000-0000000000ab'
const HOUR=3600_000
function operator({platform=['platform.org.access'],grants=[]}={}){
 const h=harness()
 h.db.store.projects.push({id:OTHER_PROJECT,org_id:OTHER_ORG,division_id:null})
 h.db.store.platform_memberships=platform?[{user_id:PACKAGE,status:'active',expires_at:null,role:{permissions:platform.map(k=>({permission_key:k}))}}]:[]
 h.db.store.platform_access_grants=grants.map(g=>({org_id:OTHER_ORG,operator_user_id:PACKAGE,ended_at:null,expires_at:new Date(Date.now()+HOUR).toISOString(),...g}))
 const inOther={permission:'members.manage',userId:PACKAGE,orgId:OTHER_ORG}
 return {...h,inOther,scope:()=>h.service.getProjectReadScopeForUser({orgId:OTHER_ORG,userId:PACKAGE}),
  many:()=>h.service.authorizeMany({...inOther,projectIds:[OTHER_PROJECT]})}
}

test('staff who are real limited members hold only their role there, grant or not',async()=>{
 for(const platform of [['platform.org.access'],['*']]){
  const h=operator({platform,grants:[{org_id:ORG}]})
  const manage=await h.service.authorize({permission:'members.manage',userId:PACKAGE,orgId:ORG})
  assert.equal(manage.allowed,false,platform[0]);assert.ok(!manage.scopesEvaluated.includes('platform_org_context'))
  assert.equal((await h.service.authorize(h.input)).allowed,true)
  h.db.store.projects[0].division_id=null
  assert.equal((await h.service.authorize(h.input)).reasonCode,'deny_division_scope','their division scope still applies')
  assert.deepEqual(await h.service.getDivisionAccessForUser({orgId:ORG,userId:PACKAGE}),{assignedOnly:true,divisionIds:[PACKAGE]})
 }
 const h=operator();h.admin()
 assert.equal((await h.service.authorize({permission:'members.manage',userId:PACKAGE,orgId:ORG})).allowed,true,'environment superadmin overrides a limited membership')
})

test('non-owner staff with neither membership nor an open grant are a non-member',async()=>{
 {
  const h=operator()
  const decision=await h.service.authorize(h.inOther)
  assert.equal(decision.allowed,false);assert.equal(decision.reasonCode,'deny_no_org_membership')
  assert.equal((await h.service.authorize({...h.inOther,projectId:OTHER_PROJECT})).allowed,false)
  assert.equal((await h.many()).get(OTHER_PROJECT),false)
  assert.deepEqual(await h.scope(),{divisionIds:null,projectMembershipRequired:true})
 }
})

test('an open grant puts staff inside the organization as its owner; an ended or expired one does not',async()=>{
 const h=operator({grants:[{}]})
 const decision=await h.service.authorize(h.inOther)
 assert.equal(decision.allowed,true);assert.ok(decision.permissions.includes('*'))
 assert.ok(decision.scopesEvaluated.includes('platform_org_context'))
 assert.equal((await h.service.authorize({...h.inOther,projectId:OTHER_PROJECT})).allowed,true)
 assert.equal((await h.many()).get(OTHER_PROJECT),true)
 assert.deepEqual(await h.scope(),{divisionIds:null,projectMembershipRequired:false})
 const env=operator({platform:null,grants:[{}]});env.admin()
 assert.equal((await env.service.authorize(env.inOther)).allowed,true,'environment superadmin with a grant')
 for(const grant of [{expires_at:new Date(Date.now()-HOUR).toISOString()},{ended_at:new Date().toISOString()},{org_id:ORG}]){
  const g=operator({grants:[grant]})
  assert.equal((await g.service.authorize(g.inOther)).allowed,false,JSON.stringify(grant))
  assert.equal((await g.many()).get(OTHER_PROJECT),false)
 }
 const stranger=operator({platform:['platform.billing.manage'],grants:[{}]})
 assert.equal((await stranger.service.authorize(stranger.inOther)).allowed,false,'staff without org access')
})

test('platform capabilities are decided without any grant or organization',async()=>{
 const h=operator({platform:['platform.org.access']})
 const calls=[],rpc=h.db.rpc.bind(h.db);h.db.rpc=(name,args)=>{calls.push(name);return rpc(name,args)}
 assert.equal((await h.service.authorize({permission:'platform.org.access',userId:PACKAGE})).allowed,true)
 assert.equal((await h.service.authorize({permission:'platform.org.access',userId:PACKAGE,orgId:OTHER_ORG})).allowed,true)
 assert.equal((await h.service.authorize({permission:'platform.billing.manage',userId:PACKAGE})).allowed,false)
 h.admin()
 const env=await h.service.authorize({permission:'platform.billing.manage',userId:PACKAGE})
 assert.equal(env.allowed,true);assert.equal(env.reasonCode,'allow_superadmin')
 assert.deepEqual(calls,[])
})

test('a grant that cannot be read refuses rather than grants',async()=>{
 const h=operator({grants:[{}]})
 h.db.rpc=async()=>({data:null,error:{message:'timeout'}})
 await assert.rejects(h.service.authorize(h.inOther),/Unable to verify support access/)
})


test('platform owners need no grant, override limited memberships, and keep project identities scoped', async () => {
 for (const mode of ['id', 'email', 'role']) {
  const h=operator({platform:null})
  delete process.env.SUPERADMIN_EMAILS
  if(mode==='id')h.admin()
  if(mode==='email'){
   process.env.SUPERADMIN_EMAILS='owner@arc.test'
   h.db.store.app_users=[{id:PACKAGE,email:'owner@arc.test'}]
  }
  if(mode==='role')h.db.store.platform_memberships=[{user_id:PACKAGE,status:'active',expires_at:null,role:{key:'platform_super_admin',permissions:[]}}]
  h.db.rpc=async()=>{throw new Error('Owner must not need a support grant')}
  try {
   assert.equal((await h.service.authorize(h.inOther)).allowed,true,mode)
   assert.equal((await h.service.authorize({permission:'members.manage',userId:PACKAGE,orgId:ORG})).allowed,true,mode)
   assert.equal((await h.service.authorize({...h.inOther,projectId:OTHER_PROJECT})).allowed,true,mode)
   assert.equal((await h.many()).get(OTHER_PROJECT),true,mode)
   assert.deepEqual(await h.scope(),{divisionIds:null,projectMembershipRequired:false})
   assert.deepEqual(await h.service.getDivisionAccessForUser({orgId:ORG,userId:PACKAGE}),{assignedOnly:false,divisionIds:[]})
   assert.equal((await h.service.authorize({...h.inOther,projectId:PROJECT})).reasonCode,'deny_project_org_mismatch')
   assert.equal((await h.service.authorizeMany({...h.inOther,projectIds:[PROJECT,OTHER_PROJECT]})).get(PROJECT),false)
   assert.equal((await h.service.authorize({...h.inOther,permission:'invented.permission'})).allowed,false)
  } finally {
   delete process.env.SUPERADMIN_IDS
   delete process.env.SUPERADMIN_EMAILS
  }
 }
})

test('revoked, expired and ordinary platform roles never become platform owners', async () => {
 for(const overrides of [{status:'revoked'},{expires_at:'2000-01-01T00:00:00Z'},{role:{key:'platform_admin',permissions:[{permission_key:'*'}]}}]){
  const h=operator({platform:null})
  h.db.store.platform_memberships=[{user_id:PACKAGE,status:'active',expires_at:null,role:{key:'platform_super_admin',permissions:[]},...overrides}]
  assert.equal((await h.service.authorize(h.inOther)).allowed,false)
 }
})
