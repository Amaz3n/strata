const assert=require('node:assert/strict'),test=require('node:test')
const {PGlite}=require('@electric-sql/pglite')
const {installCatalogRevision,tables}=require('./fixtures/agreement-catalog-database')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
async function database(t){
 const db=new PGlite();t.after(()=>db.close())
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create table orgs(id uuid primary key)')
 await db.query('insert into orgs values($1),($2)',[id(1),id(2)])
 await installCatalogRevision(db)
 return db
}
const revision=async(db,org=id(1))=>(await db.query('select revision::text revision from agreement_catalog_revisions where org_id=$1',[org])).rows[0]?.revision
test('all committed pricing/configuration source inserts, updates and deletes advance only their tenant revision',async t=>{
 const db=await database(t);let expected=1
 for(const table of tables){
  await db.query(`insert into ${table}(id,org_id) values($1,$2)`,[id(10),id(1)])
  assert.equal(await revision(db),String(++expected),`${table} insert`)
  await db.query(`update ${table} set org_id=org_id where id=$1`,[id(10)])
  assert.equal(await revision(db),String(++expected),`${table} update`)
  await db.query(`delete from ${table} where id=$1`,[id(10)])
  assert.equal(await revision(db),String(++expected),`${table} delete`)
  assert.equal(await revision(db,id(2)),'1')
 }
})
test('source rollback rolls revision back and tenant moves invalidate both tenants',async t=>{
 const db=await database(t)
 await db.exec('begin');await db.query('insert into selection_options(org_id) values($1)',[id(1)]);assert.equal(await revision(db),'2');await db.exec('rollback')
 assert.equal(await revision(db),'1')
 await db.query('insert into selection_options(id,org_id) values($1,$2)',[id(10),id(1)])
 await db.query('update selection_options set org_id=$1 where id=$2',[id(2),id(10)])
 assert.equal(await revision(db),'3');assert.equal(await revision(db,id(2)),'2')
 await db.query('insert into orgs values($1)',[id(3)]);assert.equal(await revision(db,id(3)),'1')
})
test('verified revision assertion rejects missing/stale evidence and catalog truncation cannot bypass it',async t=>{
 const db=await database(t)
 for(const expected of [null,'0','01','-1','1.5','999999999999999999999999'])await assert.rejects(db.query('select assert_agreement_catalog_revision($1,$2)',[id(1),expected]))
 await db.query('select assert_agreement_catalog_revision($1,$2)',[id(1),'1'])
 await db.query('insert into incentives(org_id) values($1)',[id(1)])
 await assert.rejects(db.query('select assert_agreement_catalog_revision($1,$2)',[id(1),'1']),error=>error.detail==='AGREEMENT_QUOTE_CHANGED')
 for(const table of tables)await assert.rejects(db.exec(`truncate ${table}`),/bypasses revision evidence/)
})
test('users can read their revision but cannot forge it; source triggers still work under authenticated writers',async t=>{
 const db=await database(t)
 await db.exec(`set test.org_id='${id(1)}';grant insert,select on selection_options to authenticated;set role authenticated`)
 assert.equal((await db.query('select org_id from agreement_catalog_revisions')).rows.length,1)
 await assert.rejects(db.exec('update agreement_catalog_revisions set revision=1'),/permission denied/)
 await db.query('insert into selection_options(org_id) values($1)',[id(1)])
 assert.equal(await revision(db),'2')
 await assert.rejects(db.query('select assert_agreement_catalog_revision($1,$2)',[id(1),'2']),/permission denied/)
 await db.exec('reset role;set role anon');await assert.rejects(db.exec('select * from agreement_catalog_revisions'),/permission denied/)
 await db.exec('reset role;set role service_role');await assert.rejects(db.exec('delete from agreement_catalog_revisions'),/permission denied/)
 await db.exec('reset role')
})
