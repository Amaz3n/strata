require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const { bankStatus, capturedExpenseMatch, matchWindowBounds, codingForTransactionTotal, codingProblem, receiptCandidates, similarBankTransactions, bankCodingSchema } = require('../lib/services/books/banking-model')
const { completeBankAiBatch, validatedBankAiIds, bankAiRetryState } = require('../lib/services/books/bank-ai-model')
const { bankingQuerySchema } = require('../lib/services/books/banking-workspace')
const { BankFeedProviderError } = require('../lib/integrations/banking/provider')
const { bankFeedFailureState, bankFeedSuccessState, bankFeedWebhookFailureState, canSyncBankFeed } = require('../lib/services/books/bank-feed-health')
const { formatBankDate, bankingPaginationItems, bankingOptimisticCounts } = require('../components/books/banking-ui')
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const line={id:uuid(1),accountId:uuid(2),projectId:null,costCodeId:null,amountCents:10000}
const coding={vendorId:null,memo:'',receiptStatus:'missing',learn:false,lines:[line]}
const accounts=[{id:uuid(2),account_type:'expense'},{id:uuid(3),account_type:'cogs'}]
test('bank lifecycle remains distinct from ledger posting and exclusions',()=>{
 const row={lifecycle_status:'posted',excluded:false,amount_cents:10000,matches:[]}
 assert.equal(bankStatus(row),'review')
 assert.equal(bankStatus({...row,lifecycle_status:'pending'}),'pending')
 assert.equal(bankStatus({...row,excluded:true}),'excluded')
 assert.equal(bankStatus({...row,matches:[{status:'confirmed',match_type:'exact',matched_amount_cents:4000}]}),'review')
 assert.equal(bankStatus({...row,matches:[{status:'confirmed',match_type:'exact',matched_amount_cents:10000}]}),'posted')
 assert.equal(bankStatus({...row,matches:[{status:'reversed',match_type:'exact',matched_amount_cents:10000}]}),'review')
})
test('coding validates split totals and project cost dimensions before posting',()=>{
 assert.equal(codingProblem(coding,10000,accounts),null)
 assert.match(codingProblem({...coding,lines:[{...line,amountCents:9999}]},10000,accounts),/equal/)
 assert.match(codingProblem({...coding,lines:[{...line,accountId:uuid(3)}]},10000,accounts),/project/)
 assert.match(codingProblem({...coding,lines:[{...line,projectId:uuid(8)}]},10000,accounts),/direct cost/)
 assert.equal(codingProblem({...coding,lines:[{...line,amountCents:4000},{...line,id:uuid(7),accountId:uuid(3),projectId:uuid(8),amountCents:6000}]},10000,accounts),null)
 assert.match(codingProblem({...coding,lines:[{...line,costCodeId:uuid(9)}]},10000,accounts),/cost code requires a project/i)
 assert.equal(bankCodingSchema.safeParse({...coding,lines:[{...line,amountCents:NaN}]}).success,false)
 assert.equal(bankCodingSchema.safeParse({...coding,lines:[{...line,amountCents:Number.MAX_SAFE_INTEGER+1}]}).success,false)
})

test('a single coding line always follows the bank transaction total',()=>{
 const stale={...coding,lines:[{...line,amountCents:270}]}
 const repaired=codingForTransactionTotal(stale,540)
 assert.equal(repaired.lines[0].amountCents,540)
 assert.equal(repaired.lines[0].accountId,line.accountId)
 assert.equal(codingProblem(repaired,540,accounts),null)

 const split={...coding,lines:[{...line,amountCents:270},{...line,id:uuid(7),amountCents:270}]}
 assert.equal(codingForTransactionTotal(split,540),split)
 assert.match(codingProblem(codingForTransactionTotal(split,600),600,accounts),/equal/)
})

test('office allocation rejects a stale cost code when no project is selected',()=>{
 const office={...line,costCodeId:uuid(99),projectId:null}
 assert.match(codingProblem({...coding,lines:[office]},10000,accounts),/cost code requires a project/i)
})

test('receipt date matching treats date-only values as calendar dates in every timezone',()=>{
 const receipt={totalDollars:29,vendorName:'Example',expenseDate:'2026-11-01'}
 const transaction={id:uuid(1),amount_cents:2900,merchant_name:'Example',description:'Invoice',transaction_date:'2026-11-08'}
 const boundary=receiptCandidates(receipt,[transaction])[0]
 assert.equal(boundary.strong,true)
 for(const transactionDate of ['2026-10-25','2026-11-08']) {
   assert.equal(receiptCandidates(receipt,[{...transaction,transaction_date:transactionDate}]).length,1,transactionDate)
 }
 assert.equal(receiptCandidates(receipt,[{...transaction,transaction_date:'2026-11-09'}]).length,0)
 assert.equal(receiptCandidates(receipt,[{...transaction,transaction_date:'2026-11-10'}]).length,0)
})

test('banking query pagination accepts the final page and rejects an unsafe page',()=>{
 assert.equal(bankingQuerySchema.parse({page:0}).page,0)
 assert.equal(bankingQuerySchema.parse({page:100000}).page,100000)
 assert.equal(bankingQuerySchema.safeParse({page:100001}).success,false)
 assert.equal(bankingQuerySchema.safeParse({page:-1}).success,false)
})
test('banking query only accepts server-backed stable sorts',()=>{
 const defaults=bankingQuerySchema.parse({})
 assert.equal(defaults.sort,'date')
 assert.equal(defaults.sortDir,'desc')
 for(const sort of ['date','description','amount']) assert.equal(bankingQuerySchema.safeParse({sort,sortDir:'asc'}).success,true)
 assert.equal(bankingQuerySchema.safeParse({sort:'merchant'}).success,false)
 assert.equal(bankingQuerySchema.safeParse({sort:'date',sortDir:'sideways'}).success,false)
})

test('bank date formatting preserves the date portion across ISO offsets',()=>{
 assert.equal(formatBankDate('2026-09-03'),'09/03/2026')
 assert.equal(formatBankDate('2026-09-03T23:30:00-04:00'),'09/03/2026')
 assert.equal(formatBankDate('unknown'),'unknown')
})

test('numbered banking pagination handles empty, edge and middle pages',()=>{
 assert.deepEqual(bankingPaginationItems(0,0),[])
 assert.deepEqual(bankingPaginationItems(0,3),[0,1,2])
 assert.deepEqual(bankingPaginationItems(0,12),[0,1,'ellipsis',11])
 assert.deepEqual(bankingPaginationItems(5,12),[0,'ellipsis',4,5,6,'ellipsis',11])
 assert.deepEqual(bankingPaginationItems(11,12),[0,'ellipsis',10,11])
})
test('similar selection requires account, direction, merchant, exact description and amount',()=>{
 const a={bank_account_id:uuid(1),direction:'outflow',merchant_name:'Example Software',description:'EXAMPLE MONTHLY',amount_cents:2900}
 assert.equal(similarBankTransactions(a,{...a,merchant_name:' example  software '}),true)
 for(const changes of [{bank_account_id:uuid(2)},{direction:'inflow'},{amount_cents:5900},{description:'EXAMPLE HARDWARE'},{merchant_name:null}]) assert.equal(similarBankTransactions(a,{...a,...changes}),false)
})
test('receipt matching preserves ambiguity rather than silently choosing a duplicate amount',()=>{
 const receipt={totalDollars:29,vendorName:'Example',expenseDate:'2026-09-10'}
 const transaction={id:uuid(1),amount_cents:2900,merchant_name:'Example Software',description:'Invoice',transaction_date:'2026-09-11'}
 assert.deepEqual(receiptCandidates(receipt,[transaction,{...transaction,id:uuid(2)}]),[{id:uuid(1),strong:true},{id:uuid(2),strong:true}])
 assert.deepEqual(receiptCandidates({...receipt,totalDollars:null},[transaction]),[])
 assert.deepEqual(receiptCandidates(receipt,[{...transaction,transaction_date:'2026-08-01'}]),[])
})

test('new Banking exports retain compatibility with pre-workspace archives',()=>{
 const { EXPORT_TABLES, verifyBooksExportBundle } = require('../lib/services/books/export-contract')
 const { booksDigest } = require('../lib/services/books/hash')
 const tables=Object.fromEntries(EXPORT_TABLES.filter(name=>!['bank_transaction_details','bank_receipts'].includes(name)).map(name=>[name,[]]))
 const manifest={schemaVersion:2,orgId:'org',tables:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}]))}
 assert.equal(verifyBooksExportBundle({tables,manifest}).valid,true)
 assert.equal(verifyBooksExportBundle({tables,manifest:{...manifest,schemaVersion:3}}).valid,false)
})

test('optimistic banking counts compose across posts and one rollback',()=>{
 const initial={'bank-1:review':4,'bank-1:posted':2}
 const first=bankingOptimisticCounts(initial,'bank-1','post')
 const second=bankingOptimisticCounts(first,'bank-1','post')
 assert.deepEqual(second,{'bank-1:review':2,'bank-1:posted':4})
 assert.deepEqual(bankingOptimisticCounts(second,'bank-1','rollback'),{'bank-1:review':3,'bank-1:posted':3})
 assert.deepEqual(initial,{'bank-1:review':4,'bank-1:posted':2})
})

test('AI bank batches reject missing and duplicate transaction results',()=>{
 const raw=(transactionId)=>({transactionId,accountId:uuid(2),vendorId:null,confidence:.9,rationale:'Recurring software'})
 assert.equal(completeBankAiBatch([uuid(1),uuid(2)],[raw(uuid(1)),raw(uuid(2))]),true)
 assert.equal(completeBankAiBatch([uuid(1),uuid(2)],[raw(uuid(1))]),false)
 assert.equal(completeBankAiBatch([uuid(1),uuid(2)],[raw(uuid(1)),raw(uuid(1))]),false)
})

test('AI bank IDs abstain below confidence and discard IDs outside the organization options',()=>{
 const allowedAccounts=new Set([uuid(2)]), allowedVendors=new Set([uuid(3)])
 const valid={transactionId:uuid(1),accountId:uuid(2),vendorId:uuid(3),confidence:.75,rationale:'Known merchant'}
 assert.deepEqual(validatedBankAiIds(valid,allowedAccounts,allowedVendors),{accountId:uuid(2),vendorId:uuid(3)})
 assert.deepEqual(validatedBankAiIds({...valid,confidence:.749},allowedAccounts,allowedVendors),{accountId:null,vendorId:null})
 assert.deepEqual(validatedBankAiIds({...valid,accountId:uuid(9),vendorId:uuid(8)},allowedAccounts,allowedVendors),{accountId:null,vendorId:null})
})

test('AI bank lifecycle never recalls completed abstentions and does not burn attempts while unavailable',()=>{
 assert.deepEqual(bankAiRetryState({status:'completed',attemptCount:1,unavailable:false}),{shouldCallModel:false,attemptCount:1})
 assert.deepEqual(bankAiRetryState({status:'pending',attemptCount:1,unavailable:true}),{shouldCallModel:false,attemptCount:0})
 assert.deepEqual(bankAiRetryState({status:'failed',attemptCount:2,unavailable:false}),{shouldCallModel:true,attemptCount:2})
 assert.deepEqual(bankAiRetryState({status:'failed',attemptCount:3,unavailable:false}),{shouldCallModel:false,attemptCount:3})
})

test('bank feed health separates healthy, expired, disconnected, and repaired states',()=>{
 assert.equal(canSyncBankFeed('active'),true)
 assert.equal(canSyncBankFeed('reauth_required'),true)
 assert.equal(canSyncBankFeed('error'),true)
 assert.equal(canSyncBankFeed('disconnected'),false)
 assert.deepEqual(bankFeedFailureState(new BankFeedProviderError('Login required','ITEM_ERROR','ITEM_LOGIN_REQUIRED')),{status:'reauth_required',lastError:'Login required'})
 assert.deepEqual(bankFeedFailureState(new BankFeedProviderError('Institution unavailable','INSTITUTION_ERROR','INSTITUTION_DOWN')),{status:'error',lastError:'Institution unavailable'})
 assert.deepEqual(bankFeedWebhookFailureState({error:{error_type:'ITEM_ERROR',error_code:'ITEM_LOGIN_REQUIRED',error_message:'Credentials expired'}}),{status:'reauth_required',lastError:'Credentials expired'})
 assert.deepEqual(bankFeedSuccessState(),{status:'active',lastError:null})
})

test('a card charge is the approved expense that already recorded its cost', () => {
  const charge = { date: '2026-10-10', amountCents: 8450, direction: 'outflow', counterparty: 'THE HOME DEPOT #4127' }
  const expense = (vendorName) => ({ expenseId: uuid(50), vendorName, homeLabel: 'Smith job', hasReceipt: true, receiptFileId: uuid(51) })
  const candidate = (n, overrides = {}) => ({ id: uuid(n), availableCents: 8450, entryDate: '2026-10-09', expense: expense('Home Depot'), ...overrides })

  assert.equal(capturedExpenseMatch(charge, [candidate(1)]).id, uuid(1))
  assert.equal(capturedExpenseMatch(charge, [candidate(1, { availableCents: 8400 })]), null, 'amount must equal')
  assert.equal(capturedExpenseMatch(charge, [candidate(1, { entryDate: '2026-09-20' })]), null, 'outside the window')
  assert.equal(capturedExpenseMatch(charge, [candidate(1, { expense: null })]), null, 'a bare ledger line is not an expense')
  assert.equal(capturedExpenseMatch({ ...charge, direction: 'inflow' }, [candidate(1)]), null, 'money arriving is never an expense')

  assert.equal(capturedExpenseMatch(charge, [candidate(1), candidate(2)]), null, 'two equally good receipts are ambiguous')
  assert.equal(
    capturedExpenseMatch(charge, [candidate(1, { expense: expense('Lowes') }), candidate(2)]).id,
    uuid(2),
    'vendor agreement breaks the tie',
  )
  assert.equal(
    capturedExpenseMatch(charge, [candidate(1, { expense: expense('Lowes') }), candidate(2, { expense: expense('Menards') })]),
    null,
    'no vendor agrees and two remain',
  )
})

test('a charge cannot be posted or categorized again when it is an approved captured expense', async () => {
  const { createServiceHarness, ORG } = require('./support/service')
  const { freshRequire } = require('./support/modules')
  const { createServiceSupabaseClient } = require('@/lib/supabase/server')
  const { assertNotCapturedExpense } = freshRequire('lib/services/books/captured-expenses.ts')
  assert.deepEqual(matchWindowBounds('2026-10-10'), { from: '2026-09-30', to: '2026-10-20' })

  const tables = (entryDate, vendor = 'Home Depot') => ({
    bank_transactions: [{ id: uuid(1), org_id: ORG, direction: 'outflow', amount_cents: 8450, transaction_date: '2026-10-10', merchant_name: 'THE HOME DEPOT #4127', description: 'HOME DEPOT', bank_account: { gl_account_id: uuid(5) } }],
    journal_lines: [{ id: uuid(2), org_id: ORG, account_id: uuid(5), debit_cents: 0, credit_cents: 8450, description: 'Expense', entry: { entry_date: entryDate, status: 'posted', memo: null, source_type: 'expense', source_id: uuid(3) }, matches: [] }],
    project_expenses: [{ id: uuid(3), org_id: ORG, vendor_name_text: vendor, vendor_company_id: null, project_id: null, overhead_category: 'fuel_vehicles', receipt_file_id: null }],
    projects: [], companies: [],
  })
  const check = (tablesFor) => {
    const service = createServiceHarness({ tables: tablesFor, permissions: ['books.write'] })
    return service.run(() => assertNotCapturedExpense(createServiceSupabaseClient(), ORG, uuid(1)))
  }
  await assert.rejects(check(tables('2026-10-09')), /already recorded as the approved expense from Home Depot/)
  await assert.doesNotReject(check(tables('2026-08-01')), 'a ledger line outside the window is not the charge')
})
