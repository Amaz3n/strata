require('../scripts/register-ts-node-test');
const test=require('node:test');const assert=require('node:assert/strict');
const {installBooksExportSnapshot}=require('./fixtures/books-export-snapshot-database');
const {PGlite}=require('@electric-sql/pglite');
const {EXPORT_TABLES}=require('../lib/services/books/export-contract');
test('real export snapshot RPC scopes every table, keeps all rows and uses statement visibility',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec('create role anon;create role authenticated;create role service_role;');
 for(const table of EXPORT_TABLES) await db.exec(`create table public.${table}(id uuid primary key,org_id uuid not null,payload text)`);
 await installBooksExportSnapshot(db);
 const org='00000000-0000-4000-8000-000000000001';const other='00000000-0000-4000-8000-000000000002';
 await db.query("insert into journal_lines select md5(n::text)::uuid,$1,'line' from generate_series(1,1251) n",[org]);
 await db.query("insert into journal_lines values(md5('other')::uuid,$1,'private')",[other]);
 await db.query("insert into payment_run_fee_charges values(md5('fee')::uuid,$1,'settled-fee'),(md5('other-fee')::uuid,$2,'private')",[org,other]);
 // Version evidence is part of schema v8, including retained originals that no
 // longer match the file's current storage path. Capture all, scoped to org.
 await db.query("insert into doc_versions select md5(('version-'||n)::text)::uuid,$1,'retained-version' from generate_series(1,1251) n",[org]);
 await db.query("insert into doc_versions values(md5('private-version')::uuid,$1,'private')",[other]);
 const capture=async()=> (await db.query('select capture_books_export_snapshot($1) snapshot',[org])).rows[0].snapshot;
 const snapshot=await capture();assert.equal(snapshot.orgId,org);assert.ok(snapshot.databaseSnapshot);assert.ok(snapshot.capturedAt);
 assert.deepEqual(Object.keys(snapshot.tables).sort(),[...EXPORT_TABLES].sort());
 assert.equal(snapshot.tables.payment_run_fee_charges.length,1);assert.equal(snapshot.tables.payment_run_fee_charges[0].payload,"settled-fee");
 assert.equal(snapshot.tables.doc_versions.length,1251);assert.ok(snapshot.tables.doc_versions.every(row=>row.org_id===org));
 const versionIds=snapshot.tables.doc_versions.map(row=>row.id);assert.deepEqual(versionIds,[...versionIds].sort());
 assert.equal(snapshot.tables.journal_lines.length,1251);assert.ok(snapshot.tables.journal_lines.every(row=>row.org_id===org));
 const ids=snapshot.tables.journal_lines.map(row=>row.id);assert.deepEqual(ids,[...ids].sort());
 const during=(await db.query("with late as (insert into projects values(md5('late')::uuid,$1,'late') returning id) select capture_books_export_snapshot($1) snapshot from late",[org])).rows[0].snapshot;
 assert.equal(during.tables.projects.length,0,'snapshot must not see writes made by its calling statement');
 assert.equal((await capture()).tables.projects.length,1,'next statement sees committed row');
 await assert.rejects(db.query('select capture_books_export_snapshot(null)'),/organization is required/);
 const permissions=(await db.query("select has_function_privilege('authenticated','capture_books_export_snapshot(uuid)','execute') browser,has_function_privilege('anon','capture_books_export_snapshot(uuid)','execute') anon,has_function_privilege('service_role','capture_books_export_snapshot(uuid)','execute') service")).rows[0];
 assert.deepEqual(permissions,{browser:false,anon:false,service:true});
 await db.exec('set role authenticated');await assert.rejects(capture(),/permission denied/);await db.exec('reset role');
});
test('actual bigint audit identities survive capture, verification and SQL restoration beyond JavaScript precision',async t=>{
 const {BOOKS_EXPORT_SCHEMA_VERSION,verifyBooksExportBundle}=require('../lib/services/books/export-contract');
 const {booksDigest}=require('../lib/services/books/hash');
 const {prepareLegacyOwnershipInventory}=require('../lib/services/books/legacy-ownership-inventory');
 const db=new PGlite();t.after(()=>db.close());
 await db.exec('create role anon;create role authenticated;create role service_role;');
 for(const table of EXPORT_TABLES)await db.exec(`create table ${table}(id ${table==='audit_log'?'bigint':'uuid'} primary key,org_id uuid not null)`);
 await installBooksExportSnapshot(db);
 const org='88700000-0000-4000-8000-000000000001';
 await db.query("insert into audit_log values(9007199254740993,$1),(9223372036854775806,$1)",[org]);
 const captured=(await db.query('select capture_books_export_snapshot($1) value',[org])).rows[0].value;
 assert.deepEqual(captured.tables.audit_log.map(row=>row.id),['9007199254740993','9223372036854775806']);
 const bundle={tables:captured.tables,manifest:{schemaVersion:BOOKS_EXPORT_SCHEMA_VERSION,orgId:org,legalEntityIds:[],tables:Object.fromEntries(Object.entries(captured.tables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}])),supportingFiles:[],supportingHistoricalFiles:[]}};
 assert.equal(verifyBooksExportBundle(bundle).valid,true);
 const inventory=prepareLegacyOwnershipInventory(bundle,{orgId:org,accountingCutoff:'2026-09-30'});
 assert.deepEqual(inventory.populations.find(p=>p.table==='audit_log').retainedRows.map(row=>row.id),['9007199254740993','9223372036854775806']);
 // The target retains its actual bigint column, rather than changing database
 // identities into text or casting through a JavaScript Number.
 await db.exec('create table restored_audit (like audit_log including all)');
 await db.query('insert into restored_audit select * from jsonb_populate_recordset(null::restored_audit,$1::jsonb)',[JSON.stringify(captured.tables.audit_log)]);
 const restored=(await db.query('select id::text id,org_id from restored_audit order by id')).rows;
 assert.deepEqual(restored,captured.tables.audit_log);
 await db.query('insert into restored_audit values(9223372036854775807,$1)',[org]);
 assert.equal((await db.query('select max(id)::text id from restored_audit')).rows[0].id,'9223372036854775807');
});
