const { migrationSql } = require("../support/migration-sql")
require('../../scripts/register-ts-node-test')
const {sourceFixture,prepareSource,reviewSource}=require('./books-payroll-correction-source-fixture'),{capture}=require('./books-payroll-workflow-fixture'),{id,org}=require('./books-payroll-register-fixture')
async function proposalFixture(t,options={}){
 const f=await sourceFixture(t,options)
 await f.db.exec('drop table if exists books_payroll_correction_proposals')
 for(const name of ['20261004021236_books_payroll_correction_math.sql','20261004022226_books_payroll_correction_context.sql','20261004024219_books_payroll_correction_proposals.sql'])await f.db.exec(migrationSql(name.replace(/\.sql$/, "")))
 await require('../fixtures/books-export-snapshot-database').installBooksExportSnapshot(f.db)
 await prepareSource(f);await reviewSource(f)
 const plan=(await f.db.query('select lock_books_payroll_correction_context($1,$2) result',[org,id(700)])).rows[0].result;delete plan.locksHeldUntilTransactionEnd
 return {...f,plan,tables:(await capture(f.db)).tables}
}
const prepareProposal=(f,plan=f.plan,key='correction-proposal-prepare-key',actor=id(2),proposalId=id(750))=>f.db.query('select prepare_books_payroll_correction_proposal($1,$2,$3,$4,$5::jsonb,$6,$7) id',[org,proposalId,id(700),actor,JSON.stringify(plan),'Prepare exact corrective journal and project cost proposal',key])
async function reviewProposal(f,actor=id(51),notes='Independent corrective monetary and construction review'){
 const row=(await f.db.query('select plan_digest from books_payroll_correction_proposals where id=$1',[id(750)])).rows[0]
 return f.db.query('select review_books_payroll_correction_proposal($1,$2,$3,$4,$5) id',[org,id(750),actor,row.plan_digest,notes])
}
module.exports={proposalFixture,prepareProposal,reviewProposal}
