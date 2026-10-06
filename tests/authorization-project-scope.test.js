require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {createFakeSupabase}=require('./support/fake-supabase')
const {stubModule,ORG,PROJECT,PACKAGE}=require('./support/starts-harness')
function harness(){
 let admin=false
 const role={permissions:[{permission_key:'project.read'},{permission_key:'warranty.manage'}]}
 const db=createFakeSupabase({permissions:[{key:'warranty.manage'}],projects:[{id:PROJECT,org_id:ORG,division_id:PACKAGE}],memberships:[{id:PACKAGE,org_id:ORG,user_id:PACKAGE,status:'active',project_scope:'all',division_scope:'assigned',role}],membership_divisions:[{membership_id:PACKAGE,division_id:PACKAGE}]})
 stubModule('@/lib/supabase/server',{createServiceSupabaseClient:()=>db})
 stubModule('@/lib/auth/platform',{isPlatformAdminId:()=>admin})
 delete require.cache[require.resolve('../lib/services/authorization')]
 const service=require('../lib/services/authorization')
 const input={permission:'warranty.manage',orgId:ORG,userId:PACKAGE,projectId:PROJECT}
 return {db,service,input,admin:()=>{admin=true}}
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
 h.db.store.platform_memberships=[{user_id:PACKAGE,status:'active',role:{permissions:[{permission_key:'platform.org.access'}]}}]
 assert.deepEqual(await scope(),{divisionIds:null,projectMembershipRequired:false})
 const from=h.db.from.bind(h.db)
 h.db.from=t=>{const q=from(t);if(t==='memberships')q.run=()=>({data:null,error:{message:'Scope unavailable'}});return q}
 await assert.rejects(scope(),/Scope unavailable/)
 h.admin();assert.deepEqual(await scope(),{divisionIds:null,projectMembershipRequired:false})
})
