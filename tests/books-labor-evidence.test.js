const { migrationSql } = require("./support/migration-sql")
require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {PGlite}=require('@electric-sql/pglite')
const {laborBasisFromJobCost,economicLaborBasis}=require('../lib/services/books/labor-evidence')
const {draftFromFact,hashableFactPayload,preserveLegacyLaborPayload,preserveLegacyDimensionPayload}=require('../lib/services/books/fact-drafts')
const {booksDigest}=require('../lib/services/books/hash')
const id=n=>'99900000-0000-4000-8000-'+String(n).padStart(12,'0'),org=id(1)
function row(){return {id:id(2),org_id:org,source_type:'time_entry',status:'posted',source_id:id(3),project_id:id(4),cost_code_id:id(5),incurred_on:'2026-09-10',updated_at:'2026-09-10T12:00:00.000001Z',cost_cents:36000,metadata:{worker_user_id:id(6),hours:'8',base_rate_cents:3000,burden_multiplier:'1.5',is_overtime:false,ot_multiplier:'1.5',is_double_time:false,dt_multiplier:'2',labor_cost_policy_version:1}}}
test('original labor basis preserves worker, time source, policy, wages and estimated burden; incomplete evidence is unavailable',()=>{
 const source=row(),basis=laborBasisFromJobCost(org,source)
 assert.equal(basis.gross_cents,24000);assert.equal(basis.estimated_burden_cents,12000);assert.equal(basis.worker_id,id(6))
 assert.equal(laborBasisFromJobCost(org,{...source,cost_cents:54000,metadata:{...source.metadata,is_overtime:true}}).gross_cents,36000)
 const double={...source,cost_cents:72000,metadata:{...source.metadata,is_double_time:true}}
 assert.equal(laborBasisFromJobCost(org,double).gross_cents,48000)
 assert.equal(laborBasisFromJobCost(org,{...double,cost_cents:36000,metadata:{...double.metadata,labor_cost_policy_version:0}}).gross_cents,24000)
 for(const patch of [{org_id:id(99)},{source_type:'vendor_bill_line'},{status:'voided'},{cost_cents:36001},{metadata:{...source.metadata,worker_user_id:null}},{metadata:{...source.metadata,is_double_time:undefined}},{metadata:{...source.metadata,labor_cost_policy_version:undefined}}])assert.equal(laborBasisFromJobCost(org,{...source,...patch}),null)
})
test('exact half-cent wage/burden rounding matches PostgreSQL numeric arithmetic',async t=>{
 const db=new PGlite();t.after(()=>db.close())
 for(const [hours,rate,burden,premium] of [['0.03',1150,'1.5','1'],['1.01',3333,'1.17','1.5'],['7.99',2750,'1.25','2']]){
  const result=(await db.query('select round($1::numeric*$2::numeric*$3::numeric*$4::numeric)::integer cost,round($1::numeric*$2::numeric*$4::numeric)::integer gross',[hours,rate,burden,premium])).rows[0]
  const source=row();source.cost_cents=result.cost;Object.assign(source.metadata,{hours,base_rate_cents:rate,burden_multiplier:burden,is_overtime:premium==='1.5',is_double_time:premium==='2',ot_multiplier:premium,dt_multiplier:premium})
  const basis=laborBasisFromJobCost(org,source);assert.equal(basis.gross_cents,result.gross);assert.equal(basis.cost_cents,result.cost)
 }
})
test('rollout never enriches unchanged historical labor and timestamp-only updates preserve frozen capture',()=>{
 const source=row(),basis=laborBasisFromJobCost(org,source),old={amount_cents:36000,project_id:source.project_id},date=source.incurred_on
 const previous={accounting_date:date,payload:old,payload_hash:booksDigest({accountingDate:date,payload:hashableFactPayload('labor_cost',old)})}
 const candidate={...old,labor_basis:basis,dimensions:{cost_type:'labor',cost_code_id:source.cost_code_id}}
 assert.deepEqual(preserveLegacyDimensionPayload('labor_cost',date,preserveLegacyLaborPayload('labor_cost',date,candidate,previous),previous),old)
 const changed={...candidate,amount_cents:36001};assert.equal(preserveLegacyLaborPayload('labor_cost',date,changed,previous),changed)
 const frozen={accounting_date:date,payload:candidate,payload_hash:booksDigest({accountingDate:date,payload:hashableFactPayload('labor_cost',candidate)})}
 const advanced={...candidate,labor_basis:{...basis,source_revision:'2026-09-11T12:00:00.000002Z'}}
 assert.deepEqual(preserveLegacyLaborPayload('labor_cost',date,advanced,frozen),candidate)
 const ownership={...advanced,labor_basis:{...advanced.labor_basis,worker_id:id(99)}}
 assert.notEqual(booksDigest(hashableFactPayload('labor_cost',ownership)),booksDigest(hashableFactPayload('labor_cost',candidate)))
 assert.equal(preserveLegacyLaborPayload('labor_cost',date,ownership,frozen),ownership)
})
test('journal replay links original labor identity and refuses source, amount, date or project mismatch',()=>{
 const source=row(),basis=laborBasisFromJobCost(org,source),input={sourceType:'labor_cost',sourceId:source.id,accountingDate:source.incurred_on,sourceVersion:1,projectionVersion:1,policyVersion:1,payload:{amount_cents:source.cost_cents,project_id:source.project_id,labor_basis:basis,dimensions:{cost_code_id:source.cost_code_id}}}
 for(const line of draftFromFact(input).lines){assert.equal(line.dimensions.labor_worker_id,basis.worker_id);assert.equal(line.dimensions.labor_time_entry_id,basis.time_entry_id);assert.equal(line.dimensions.labor_basis_hash,booksDigest(basis));assert.equal(line.dimensions.cost_code_id,source.cost_code_id)}
 for(const patch of [{sourceId:id(99)},{accountingDate:'2026-09-11'},{payload:{...input.payload,amount_cents:36001}},{payload:{...input.payload,project_id:id(99)}},{payload:{...input.payload,dimensions:{cost_code_id:id(99)}}}])assert.throws(()=>draftFromFact({...input,...patch}),/differs/)
 assert.deepEqual(economicLaborBasis({...basis,source_revision:'2026-09-11T12:00:00Z'}),economicLaborBasis(basis))
})
test('actual double-time migration preserves historical generated costs and fixes new double-time entries',async t=>{
 const db=new PGlite();t.after(()=>db.close())
 await db.exec(`create table time_entries(id uuid primary key,hours numeric,base_rate_cents integer,burden_multiplier numeric,is_overtime boolean,ot_multiplier numeric,is_double_time boolean,dt_multiplier numeric,cost_cents integer generated always as(round(hours*base_rate_cents::numeric*burden_multiplier*case when is_overtime then ot_multiplier else 1 end)::integer) stored);
 insert into time_entries(id,hours,base_rate_cents,burden_multiplier,is_overtime,ot_multiplier,is_double_time,dt_multiplier) values('${id(10)}',8,3000,1.5,false,1.5,true,2);`)
 await db.exec(migrationSql("20261003195833_books_time_cost_double_time_policy"))
 assert.deepEqual((await db.query('select cost_cents,labor_cost_policy_version from time_entries')).rows[0],{cost_cents:36000,labor_cost_policy_version:0})
 await db.exec(`insert into time_entries(id,hours,base_rate_cents,burden_multiplier,is_overtime,ot_multiplier,is_double_time,dt_multiplier) values('${id(11)}',8,3000,1.5,false,1.5,true,2),('${id(12)}',8,3000,1.5,true,1.5,false,2);`)
 assert.equal((await db.query('select cost_cents from time_entries where id=$1',[id(11)])).rows[0].cost_cents,72000)
 assert.equal((await db.query('select cost_cents from time_entries where id=$1',[id(12)])).rows[0].cost_cents,54000)
})
