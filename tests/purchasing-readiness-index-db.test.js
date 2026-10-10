const { migrationSql } = require("./support/migration-sql")
const test=require('node:test'),assert=require('node:assert/strict')
const {PGlite}=require('@electric-sql/pglite')
test('active readiness probes use the staged org/community/division index on a large price book',async t=>{
 const db=new PGlite();t.after(()=>db.close())
 await db.exec(`create table vendor_price_agreements(id uuid primary key default gen_random_uuid(),org_id uuid,community_id uuid,division_id uuid,status text);
 insert into vendor_price_agreements(org_id,community_id,division_id,status)
 select '00000000-0000-4000-8000-000000000001',md5((n%300)::text)::uuid,md5((n%10)::text)::uuid,case when n%7=0 then 'superseded' else 'active' end from generate_series(1,30000) n;`)
 await db.exec(migrationSql("20261003043000_purchasing_readiness_scope_index"))
 await db.exec('analyze vendor_price_agreements')
 for(const predicate of ["community_id is null and division_id is null","community_id=md5('299')::uuid and (division_id=md5('9')::uuid or division_id is null)","community_id is null and division_id=md5('9')::uuid"]){
  const plan=(await db.query(`explain(format json) select id from vendor_price_agreements where org_id='00000000-0000-4000-8000-000000000001' and status='active' and ${predicate} limit 1`)).rows
  assert.match(JSON.stringify(plan),/vendor_price_agreements_active_readiness_scope_idx/)
 }
})
