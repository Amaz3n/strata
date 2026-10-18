require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {createFakeSupabase}=require('./support/fake-supabase')
const {ORG,PROJECT,PACKAGE}=require('./support/starts-harness')
const {generateReservedCourtesyInspections,courtesyReservationsEnabled}=require('../lib/services/warranty-courtesy-reservations')
const id=n=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`
test('keyset processing reaches every home beyond legacy caps with bounded transaction concurrency',async()=>{
 let calls=0,active=0,peak=0
 const db=createFakeSupabase({project_warranty_coverage:Array.from({length:2101},(_,i)=>({id:id(i+1),org_id:ORG,project_id:PROJECT,effective_date:'2026-09-03'}))},{reserve_warranty_courtesy_inspection:async args=>{calls++;active++;peak=Math.max(peak,active);await Promise.resolve();active--;assert.equal(args.p_org_id,ORG);return {data:{status:'created',reservation_id:PACKAGE,request_id:PROJECT,due_on:'2026-10-03'},error:null}}})
 assert.equal(await generateReservedCourtesyInspections({supabase:db,orgId:ORG,asOf:new Date('2026-10-03T00:00:00Z')}),2101)
 assert.equal(calls,2101);assert.ok(peak<=4)
})
test('scope decisions skip unauthorized homes and adopted/existing receipts create no new count',async()=>{
 let calls=0
 const db=createFakeSupabase({project_warranty_coverage:[{id:PACKAGE,org_id:ORG,project_id:PROJECT,effective_date:'2026-09-03'}]},{reserve_warranty_courtesy_inspection:async()=>{calls++;return {data:{status:'adopted',reservation_id:PACKAGE,request_id:PROJECT,due_on:'2026-10-03'},error:null}}})
 const input={supabase:db,orgId:ORG,asOf:new Date('2026-10-03T00:00:00Z')}
 assert.equal(await generateReservedCourtesyInspections({...input,canCreate:async()=>false}),0);assert.equal(calls,0)
 assert.equal(await generateReservedCourtesyInspections(input),0);assert.equal(calls,1)
})
test('read failures, stalled cursors and inconsistent RPC evidence surface instead of reporting success',async()=>{
 const db=createFakeSupabase(),from=db.from.bind(db)
 db.from=t=>{const q=from(t);q.run=()=>({data:null,error:{message:'Coverage unavailable'}});return q}
 await assert.rejects(generateReservedCourtesyInspections({supabase:db,orgId:ORG,asOf:new Date()}),/Coverage unavailable/)
 const rows=Array.from({length:100},()=>({id:PACKAGE,project_id:PROJECT,effective_date:'2026-09-03'}))
 db.from=t=>{const q=from(t);q.run=()=>({data:rows,error:null});return q}
 await assert.rejects(generateReservedCourtesyInspections({supabase:db,orgId:ORG,asOf:new Date()}),/cursor did not advance/)
 const bad=createFakeSupabase({project_warranty_coverage:[{id:PACKAGE,org_id:ORG,project_id:PROJECT,effective_date:'2026-09-03'}]},{reserve_warranty_courtesy_inspection:()=>({data:{status:'created',reservation_id:PACKAGE,request_id:PROJECT,due_on:'2026-10-04'},error:null})})
 await assert.rejects(generateReservedCourtesyInspections({supabase:bad,orgId:ORG,asOf:new Date('2026-10-03')}),/due date differs/)
})
test('rollout defaults off and rejects expiring or unavailable enabled controls',async()=>{
 const db=createFakeSupabase();assert.equal(await courtesyReservationsEnabled(db,ORG),false)
 db.store.feature_flags=[{org_id:ORG,flag_key:'warranty_courtesy_reservations',enabled:true,expires_at:'2026-11-01'}]
 await assert.rejects(courtesyReservationsEnabled(db,ORG),/expiring/)
 db.store.feature_flags[0].expires_at=null;assert.equal(await courtesyReservationsEnabled(db,ORG),true)
 db.store.feature_flags[0].enabled=false;db.store.warranty_courtesy_reservations=[{id:PACKAGE,org_id:ORG}]
 await assert.rejects(courtesyReservationsEnabled(db,ORG),/Restore courtesy/)
})
test('coordinator identity requires home authorization and is bound into the RPC',async()=>{
 let actor
 const db=createFakeSupabase({project_warranty_coverage:[{id:PACKAGE,org_id:ORG,project_id:PROJECT,effective_date:'2026-09-03'}]},{reserve_warranty_courtesy_inspection:args=>{actor=args.p_actor_id;return {data:{status:'created',reservation_id:PACKAGE,request_id:PROJECT,due_on:'2026-10-03'},error:null}}})
 const input={supabase:db,orgId:ORG,asOf:new Date('2026-10-03'),actorId:PACKAGE}
 await assert.rejects(generateReservedCourtesyInspections(input),/requires home authorization/)
 assert.equal(await generateReservedCourtesyInspections({...input,canCreate:async()=>true}),1);assert.equal(actor,PACKAGE)
})
test('coordinator home authorization enforces division assignments and rejects unavailable scope reads',async()=>{
 const {stubModule}=require('./support/starts-harness')
 let decision={allowed:true,divisionScope:'assigned',divisionIds:[PACKAGE]}
 stubModule('@/lib/services/authorization',{authorize:async()=>decision})
 delete require.cache[require.resolve('../lib/services/warranty-courtesy-reservations')]
 const {authorizeCourtesyHome}=require('../lib/services/warranty-courtesy-reservations')
 const db=createFakeSupabase({projects:[{id:PROJECT,org_id:ORG,division_id:PACKAGE}]}),input={supabase:db,orgId:ORG,userId:PACKAGE,projectId:PROJECT}
 assert.equal(await authorizeCourtesyHome(input),true)
 db.store.projects[0].division_id=PROJECT;assert.equal(await authorizeCourtesyHome(input),false)
 db.store.projects[0].division_id=null;assert.equal(await authorizeCourtesyHome(input),false)
 decision={allowed:true,divisionScope:'all'};assert.equal(await authorizeCourtesyHome(input),true)
 decision.allowed=false;assert.equal(await authorizeCourtesyHome(input),false)
 decision.allowed=true;const from=db.from.bind(db);db.from=t=>{const q=from(t);q.run=()=>({data:null,error:{message:'Scope unavailable'}});return q}
 await assert.rejects(authorizeCourtesyHome(input),/Scope unavailable/)
})
