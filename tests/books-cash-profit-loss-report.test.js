require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module')
const {cashProfitAndLossFromSnapshot}=require('../lib/services/books/cash-profit-loss')
const {org,fixture}=require('./support/books-cash-profit-loss-fixture')
const {reportToCsv}=require('../lib/reports/export-csv')
const original=Module._load
let fail=false,reads=0,extraEvidence=[]
let definitions
try{
 Module._load=function(name,...args){if(name==='@/lib/services/books/cash-activity')return {buildCashProfitAndLoss:async(start,end)=>{reads++;assert.equal(start,'2026-09-01');assert.equal(end,'2026-09-30');if(fail)throw new Error('Refresh missing posting evidence');const result=cashProfitAndLossFromSnapshot(org,start,end,fixture());result.evidence.push(...extraEvidence);return result}};return original.call(this,name,...args)}
 definitions=require('../lib/reports/definitions/financial').FINANCIAL_REPORTS
}finally{Module._load=original}
const definition=definitions.find(report=>report.slug==='books-cash-profit-loss')
const context={scope:'org',scopeLabel:'Accounting acceptance',posture:'custom',params:{period:'range:2026-09-01:2026-09-30'}}
test('cash P&L is a distinct Books statement and shared result exports exact native costs, dimensions and exclusions',async()=>{
 assert.ok(definition);assert.deepEqual(definition.permissions,['books.read']);assert.equal(definition.available({hasArcBooks:false}),false);assert.equal(definition.available({hasArcBooks:true}),true)
 assert.ok(definitions.find(report=>report.slug==='books-cash-basis'))
 const result=await definition.run(context);assert.equal(reads,1)
 const accounts=result.tables.find(table=>table.key==='cash-accounts')
 assert.equal(accounts.totals.amount,-3);assert.equal(accounts.rows[0].cells.projectName,'Native construction job')
 const detail=result.tables.find(table=>table.key==='cash-evidence')
 assert.equal(detail.rows[0].href,'/projects/job/expenses?expense=purchase')
 const csv=reportToCsv(result)
 assert.match(csv,/Net income,.*-3/);assert.match(csv,/Native construction job/);assert.match(csv,/Sales tax collected, net of refunds/);assert.match(csv,/Capitalized purchases, net of refunds/)
 assert.match(csv,/Posting fact ID/);assert.match(csv,/purchase,fact/);assert.match(csv,/tax adjustments are reviewed on the tax workpaper/);assert.match(csv,/Net cash movement,-3/);assert.equal(result.provenance.generatedAt,'2026-09-20T12:00:00Z')
})
test('source evidence links use the actual billing and payables workflow URL contracts',async()=>{
 const base={source:'invoice_income',documentId:'invoice',snapshotId:'fact',entryId:null,accountCode:'4000',kind:'income',amountCents:0,dimensions:{},documentLabel:'Invoice',projectName:'Organization'}
 extraEvidence=[base,{...base,documentId:'project-invoice',dimensions:{project_id:'job'}},{...base,source:'paid_bill',documentId:'bill',dimensions:{project_id:'job'}},{...base,source:'paid_bill',documentId:'org-bill'}]
 try{
  const result=await definition.run(context),links=result.tables.find(table=>table.key==='cash-evidence').rows.slice(-4).map(row=>row.href)
  assert.deepEqual(links,['/billing?invoice=invoice','/projects/job/financials/billing?invoice=project-invoice','/projects/job/financials/payables?bill=bill','/payables?bill=org-bill'])
 }finally{extraEvidence=[]}
})
test('unsupported or missing source treatment stops the report and therefore cannot publish a partial export',async()=>{
 fail=true;try{await assert.rejects(definition.run(context),/Refresh missing posting evidence/)}finally{fail=false}
})
