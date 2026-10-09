const { migrationSql } = require("../support/migration-sql")
const {proposalFixture,prepareProposal,reviewProposal}=require('./books-payroll-correction-proposal-fixture'),{id,org}=require('./books-payroll-register-fixture')
async function correctionPostingFixture(t,options={}){
 const f=await proposalFixture(t,options)
 await f.db.exec('drop table books_payroll_correction_postings')
 await f.db.exec(migrationSql("20261004031113_books_payroll_correction_atomic_posting"))
 await require('../fixtures/books-export-snapshot-database').installBooksExportSnapshot(f.db)
 await prepareProposal(f);await reviewProposal(f)
 f.proposal=(await f.db.query('select to_jsonb(p) row from books_payroll_correction_proposals p where id=$1',[id(750)])).rows[0].row
 return f
}
const postCorrection=(f,overrides={})=>f.db.query('select post_books_payroll_correction_proposal($1,$2,$3,$4,$5,$6,$7) result',[overrides.org||org,overrides.id||id(760),overrides.proposalId||id(750),overrides.actor||id(2),overrides.digest||f.proposal.plan_digest,overrides.notes||'Post complete correction and preserve customer billing',overrides.key||'atomic-correction-post-key'])
module.exports={correctionPostingFixture,postCorrection}
