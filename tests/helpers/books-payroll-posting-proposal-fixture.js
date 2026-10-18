require('../../scripts/register-ts-node-test')
const {setup}=require('./books-payroll-payment-fixture')
const {capture}=require('./books-payroll-workflow-fixture')
const {prepare,review}=require('./books-payroll-database')
const {id,org}=require('./books-payroll-register-fixture')
const {payrollPostingPlan}=require('../../lib/services/books/payroll-posting-plan')
const notes='Reviewed complete dated payroll and construction proposal'
async function sources(t,{paymentActor=id(50)}={}){
 const f=await setup(t),p=f.payment
 await prepare(f.db,f.evidence);await review(f.db,f.evidence)
 await f.db.query('select prepare_books_payroll_payment_review($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7)',[org,paymentActor,JSON.stringify(p.request),JSON.stringify(p.evidence),p.evidenceDigest,notes,'proposal-payment-review-key'])
 await f.db.query('select review_books_payroll_payment_review($1,$2,$3,$4::jsonb,$5,$6)',[org,p.request.id,id(51),JSON.stringify(p.evidence),p.evidenceDigest,notes])
 const tables=(await capture(f.db)).tables;f.parent=tables.books_payroll_imports[0];f.paymentRecord=tables.books_payroll_payment_reviews[0];f.plan=payrollPostingPlan(f.parent,f.paymentRecord)
 return f
}
const prepareProposal=(f,plan=f.plan,identifier=id(230),key='full-proposal-retry-key',actor=id(2))=>f.db.query('select prepare_books_payroll_posting_proposal($1,$2,$3,$4,$5::jsonb,$6,$7,$8) id',[org,identifier,f.run.id,actor,JSON.stringify(plan),plan.digest,notes,key])
const reviewProposal=(f,actor=id(51))=>f.db.query('select review_books_payroll_posting_proposal($1,$2,$3,$4::jsonb,$5,$6) id',[org,id(230),actor,JSON.stringify(f.plan),f.plan.digest,notes])
const withdrawProposal=f=>f.db.query('select withdraw_books_payroll_posting_proposal($1,$2,$3,$4) id',[org,id(230),id(2),'Superseded original posting proposal'])
module.exports={sources,prepareProposal,reviewProposal,withdrawProposal,notes}
