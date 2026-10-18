// Optional real PostgreSQL engine. Run with ARC_TEST_PGLITE_MODULE pointing to
// an isolated installation, or install @electric-sql/pglite in your test runtime.
const assert=require("node:assert/strict")
const test=require("node:test")
const fs=require("node:fs")
const path=require("node:path")
let PGlite
try { ({PGlite}=require(process.env.ARC_TEST_PGLITE_MODULE || "@electric-sql/pglite")) } catch {}
const root=path.join(__dirname,"..")
const org="20000000-0000-0000-0000-000000000001",actor="10000000-0000-0000-0000-000000000001",prospect="30000000-0000-0000-0000-000000000001",estimate="40000000-0000-0000-0000-000000000001",project="50000000-0000-0000-0000-000000000001"

test("transactional award, failure rollback, signed baseline and authorized release",{skip:!PGlite},async(t)=>{
 const db=new PGlite()
 t.after(()=>db.close())
 await db.exec(fs.readFileSync(path.join(__dirname,"fixtures/precon-handoff-schema.sql"),"utf8"))
 for(const migration of ["20260921121029_precon_workspace.sql","20260921121038_precon_transactional_handoff.sql"]) await db.exec(fs.readFileSync(path.join(root,"supabase/migrations",migration),"utf8"))
 await db.query("insert into orgs(id,name) values($1,'Test')",[org])
 await db.query("insert into app_users(id,email) values($1,'pm@example.test')",[actor])
 await db.query("insert into prospects(id,org_id,name,status) values($1,$2,'Test job','pricing')",[prospect,org])
 await db.query("insert into projects(id,org_id,prospect_id,name,status,phase) values($1,$2,$3,'Test job','planning','precon')",[project,org,prospect])
 await db.query("insert into contracts(org_id,project_id,title,status,snapshot) values($1,$2,'Placeholder','active','{\"billing_setup_source\":\"project_settings\"}')",[org,project])
 await db.query("insert into estimates(id,org_id,prospect_id,status,metadata,total_cents,executed_at) values($1,$2,$3,'executed','{\"precon\":{\"purpose\":\"construction_agreement\"}}',14000,now())",[estimate,org,prospect])
 await db.query("insert into prospect_contacts(org_id,prospect_id,full_name,email,is_primary) values($1,$2,'Owner','owner@example.test',true)",[org,prospect])
 const lines=[{description:"Allowance",amount_cents:10000,sort_order:0,metadata:{source_estimate_item_id:"scope",is_allowance:true,allowance_policy:"Owner selections reconcile by change order"}},{description:"Accepted deduct",amount_cents:-1000,sort_order:1,metadata:{source_estimate_item_id:"deduct",accepted_optional:true,alternate_kind:"deduct"}}]
 const commercial={billing_model:"cost_plus_gmp",gmp_cents:14000,fixed_fee_cents:0,retainage_percent:5,total_cents:14000,contingency_cents:0,terms:"Signed terms"}
 const convert=async()=>{
  const {rows}=await db.query("select updated_at from estimates where id=$1",[estimate])
  return (await db.query("select convert_executed_prospect_handoff($1,$2,$3,$4,$5,$6,$7,$8) result",[org,prospect,estimate,actor,rows[0].updated_at,{name:"Awarded job",property_type:"commercial",project_type:"renovation"},commercial,lines])).rows[0].result
 }
 await t.test("artifact-transfer failure rolls back every contact, contract and project write",async()=>{
  await db.exec("create function fail_precon_documents() returns trigger language plpgsql as $$begin raise exception 'Injected transfer failure';end$$;create trigger fail_documents before update on documents for each statement execute function fail_precon_documents();")
  await assert.rejects(convert,/Injected transfer failure/)
  assert.equal((await db.query("select count(*)::integer n from contacts")).rows[0].n,0)
  assert.equal((await db.query("select status from contracts")).rows[0].status,"active")
  assert.equal((await db.query("select name from projects where id=$1",[project])).rows[0].name,"Test job")
  await db.exec("drop trigger fail_documents on documents")
 })
 await t.test("line failure also rolls back the contract, budget header and award",async()=>{
  await db.exec("create function fail_precon_lines() returns trigger language plpgsql as $$begin raise exception 'Injected budget line failure';end$$;create trigger fail_lines before insert on budget_lines for each row execute function fail_precon_lines();")
  await assert.rejects(convert,/Injected budget line failure/)
  assert.equal((await db.query("select count(*)::integer n from budgets")).rows[0].n,0)
  assert.equal((await db.query("select count(*)::integer n from contracts where status='active'")).rows[0].n,1)
  assert.equal((await db.query("select status from prospects")).rows[0].status,"pricing")
  await db.exec("drop trigger fail_lines on budget_lines")
 })
 let result
 await t.test("award supersedes blank setup contract, preserves commercial value, and keeps delivery gated",async()=>{
  result=await convert()
  assert.equal(result.projectId,project)
  assert.equal(result.alreadyConverted,false)
  assert.equal((await db.query("select total_cents from contracts where status='active'")).rows[0].total_cents,14000)
  assert.equal((await db.query("select status,total_cents from budgets")).rows[0].status,"draft")
  assert.equal((await db.query("select total_cents from budgets")).rows[0].total_cents,9000)
  assert.equal((await db.query("select phase from projects")).rows[0].phase,"precon")
  assert.equal((await db.query("select budget_cents from allowances")).rows[0].budget_cents,10000)
  assert.equal((await db.query("select project_type from projects")).rows[0].project_type,"renovation")
  assert.equal((await convert()).alreadyConverted,true)
  assert.equal((await db.query("select count(*)::integer n from allowances")).rows[0].n,1)
 })
 const transition=async(action,review={})=>(await db.query("select transition_precon_handoff($1,$2,$3,$4,$5) result",[org,project,actor,action,review])).rows[0].result
 const baseline={scope_reviewed:true,coding_exception:"Small-job budget intentionally uncoded; PM reviewed scope"}
 const readiness={delivery_lead:"Alex / PM",checks:Object.fromEntries(["scope","documents","procurement","permits","start_authorization"].map(x=>[x,{confirmed:true}]))}
 await t.test("draft cost edits reconcile the header and reject stale or cross-organization changes",async()=>{
  const revision=(await db.query("select precon_baseline_signature($1,$2) revision",[org,project])).rows[0].revision
  const line=(await db.query("select id from budget_lines where amount_cents>0")).rows[0]
  const edit={line_id:line.id,expected_revision:revision,description:"Allowance cost review",amount_cents:11000,cost_code_id:null,reason:"PM updated the expected cost after vendor clarification"}
  await assert.rejects(()=>transition("edit_baseline",{...edit,cost_code_id:"90000000-0000-0000-0000-000000000009"}),/organization/)
  await transition("edit_baseline",edit)
  assert.equal((await db.query("select total_cents from budgets")).rows[0].total_cents,10000)
  assert.equal((await db.query("select total_cents from contracts where status='active'")).rows[0].total_cents,14000)
  assert.equal((await db.query("select budget_cents from allowances")).rows[0].budget_cents,10000)
  await assert.rejects(()=>transition("edit_baseline",edit),/baseline changed/)
 })
 await t.test("baseline approval and named acceptance precede release; cost changes invalidate review",async()=>{
  await assert.rejects(()=>transition("release"),/baseline changed/)
  await assert.rejects(()=>transition("approve_baseline",{scope_reviewed:true}),/Map uncoded/)
  await transition("approve_baseline",baseline)
  await assert.rejects(()=>transition("accept",{checks:{}}),/delivery lead/)
  await transition("accept",readiness)
  await db.query("update budget_lines set description='Scope clarified' where budget_id=$1",[result.budgetId])
  assert.equal((await db.query("select status from project_precon_handoffs")).rows[0].status,"awarded")
  await assert.rejects(()=>transition("release"),/baseline changed/)
  await transition("approve_baseline",baseline)
  await transition("accept",readiness)
 })
 await t.test("open start blockers require recorded resolution before delivery release",async()=>{
  await db.query("insert into precon_decisions(org_id,prospect_id,title,kind,owner_user_id,blocks_start,created_by,updated_by) values($1,$2,'Permit pending','readiness',$3,true,$3,$3)",[org,prospect,actor])
  await assert.rejects(()=>transition("release"),/start blockers/)
  await db.query("update precon_decisions set status='resolved',resolution='Permit issued',resolved_by=$1",[actor])
  assert.equal((await transition("release")).status,"released")
  assert.equal((await db.query("select phase,status from projects")).rows[0].phase,"delivery")
  assert.equal((await transition("release")).status,"released")
 })
 await t.test("public roles cannot call financial conversion or handoff transitions",async()=>{
  assert.equal((await db.query("select has_function_privilege('authenticated','public.convert_executed_prospect_handoff(uuid,uuid,uuid,uuid,timestamptz,jsonb,jsonb,jsonb)','execute') allowed")).rows[0].allowed,false)
  assert.equal((await db.query("select has_function_privilege('anon','public.transition_precon_handoff(uuid,uuid,uuid,text,jsonb)','execute') allowed")).rows[0].allowed,false)
 })
})
