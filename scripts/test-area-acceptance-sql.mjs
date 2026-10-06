// Executes the real migration in an isolated PostgreSQL WASM instance.
import assert from 'node:assert/strict'
const {PGlite}=await import(process.env.ARC_PGLITE_MODULE ?? '@electric-sql/pglite')
const db=new PGlite()
const {id,setupAreaAcceptance}=await import('../tests/fixtures/area-acceptance.mjs')
await setupAreaAcceptance(sql=>db.exec(sql))
const row=n=>({id:id(n),org_id:id(1),drawing_sheet_id:id(3),sheet_version_id:id(4),condition_id:id(6),data:{type:'area',points:[[0,0],[1,0],[1,1],[0,1]]},quantity:100,uom:'sf'})
const accept=(snapshot,rows,org=id(1))=>db.query('select accept_takeoff_area_snapshot($1,$2,$3,$4::jsonb,$5::jsonb) as count',[org,id(4),id(6),JSON.stringify(snapshot),JSON.stringify(rows)])
const snapshot=async()=> (await db.query('select id,data from drawing_markups order by id')).rows
assert.equal((await accept([],[row(10)])).rows[0].count,1)
await assert.rejects(accept([],[row(11)]),/Measurements changed/)
assert.equal((await accept(await snapshot(),[row(10)])).rows[0].count,0,'exact retry remains idempotent')
await assert.rejects(accept(await snapshot(),[{...row(11),org_id:id(9)}]),/scope mismatch/)
await assert.rejects(accept([], [row(11)],id(9)),/Drawing or condition changed/)
await db.query('update drawing_markups set data=$1 where id=$2',[JSON.stringify({type:'area',points:[[0,0],[.5,0],[.5,1],[0,1]]}),id(10)])
await assert.rejects(accept([{id:id(10),data:row(10).data}],[row(11)]),/Measurements changed/)
assert.equal((await db.query('select count(*)::int as n from drawing_markups')).rows[0].n,1)
// Fail the second member: outer area and deduction must roll back together.
await db.exec('alter table drawing_markups add constraint nonzero_quantity check(quantity <> 0)')
await assert.rejects(accept(await snapshot(),[row(11),{...row(12),quantity:0}]),/nonzero_quantity/)
assert.equal((await db.query('select count(*)::int as n from drawing_markups')).rows[0].n,1)
await db.close()
console.log('PASS: real SQL rejects stale snapshots/scope changes, preserves retries, and rolls back complete batches. Run the separate PostgreSQL concurrency suite for multi-session verification.')
