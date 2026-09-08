require('../scripts/register-ts-node-test');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { EXPORT_TABLES, verifyBooksExportBundle } = require('../lib/services/books/export-contract');
const { booksDigest } = require('../lib/services/books/hash');
const { verifyFileCopy } = require('../scripts/verify-books-export.cjs');
function fixture() {
 const tables=Object.fromEntries(EXPORT_TABLES.map(name=>[name,[]]));
 tables.gl_accounts=[{id:'cash',org_id:'org'},{id:'clearing',org_id:'org'}];
 tables.journal_entries=[{id:'entry',org_id:'org',status:'posted'}];
 tables.journal_lines=[{id:'debit',org_id:'org',entry_id:'entry',account_id:'cash',debit_cents:10000,credit_cents:0},{id:'credit',org_id:'org',entry_id:'entry',account_id:'clearing',debit_cents:0,credit_cents:10000}];
 tables.bank_accounts=[{id:'bank',org_id:'org'}];
 tables.bank_transactions=[{id:'transaction',org_id:'org',bank_account_id:'bank'}];
 tables.payments=[{id:'receipt',org_id:'org'}];
 tables.books_deposit_batches=[{id:'batch',org_id:'org',journal_entry_id:'entry',bank_transaction_id:'transaction'}];
 tables.books_deposit_batch_items=[{id:'member',org_id:'org',batch_id:'batch',payment_id:'receipt'}];
 return { tables, manifest:{schemaVersion:2,orgId:'org',tables:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}])),supportingFiles:[]} };
}
test('export roundtrip retains operational relationships and verifies copied file bytes',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'arc-books-export-'));
 try {
  const bundle=fixture(); const file=Buffer.from('Bank statement fixture\n');
  bundle.manifest.supportingFiles=[{id:'file',storagePath:'org/statement.pdf',checksum:createHash('sha256').update(file).digest('hex'),sizeBytes:file.length}];
  mkdirSync(path.join(root,'org'));writeFileSync(path.join(root,'org/statement.pdf'),file);
  const archive=path.join(root,'books.json.gz');writeFileSync(archive,gzipSync(JSON.stringify(bundle)));
  assert.equal((await verifyFileCopy(archive,root)).verifiedFiles,1);
  writeFileSync(path.join(root,'org/statement.pdf'),'changed');
  await assert.rejects(verifyFileCopy(archive,root),/changed/);
 } finally { rmSync(root,{recursive:true,force:true}); }
});
test('balanced journals cannot hide a missing deposit membership relationship',()=>{
 const bundle=fixture(); bundle.tables.payments=[];bundle.manifest.tables.payments={rows:0,checksum:booksDigest([])};
 const result=verifyBooksExportBundle(bundle);assert.equal(result.valid,false);assert.ok(result.integrityErrors.some(error=>error.includes('payment_id')));
});
test('table bytes and organization scope are independently verified',()=>{
 const bundle=fixture();bundle.tables.payments[0].org_id='another-org';
 assert.equal(verifyBooksExportBundle(bundle).valid,false);
 bundle.manifest.tables.payments.checksum=booksDigest(bundle.tables.payments);
 assert.ok(verifyBooksExportBundle(bundle).integrityErrors.some(error=>error.includes('Organization mismatch')));
});
