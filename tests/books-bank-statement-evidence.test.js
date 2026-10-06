require('../scripts/register-ts-node-test');
const test=require('node:test');const assert=require('node:assert/strict');const Module=require('node:module');
test('closed statement detail uses frozen transactions and never reconstructs legacy history from live feeds',async()=>{
 let legacy=false,hasEvidence=true;let feedReads=0;
 const service={from(table){if(table==='bank_transactions'){feedReads++;throw new Error('Closed evidence must not read the live feed')};assert.equal(table,'bank_reconciliations');const q={select(){return q},eq(){return q},single:async()=>({data:{id:'rec',bank_account_id:'bank',statement_start:'2026-09-01',statement_end:'2026-09-30',beginning_balance_cents:10000,ending_balance_cents:12000,status:'closed',digest:'frozen-digest'},error:null})};return q},rpc:async()=>({data:{frozen:hasEvidence,book_balance_cents:11000,outstanding_balance_cents:-1000,direction_factor:1,items:[{journal_line_id:'check',amount_cents:-1000,item_status:'outstanding'}],...(legacy?{}:{statement_transactions:[{id:'deposit',transaction_date:'2026-09-15',description:'Original deposit',merchant_name:null,direction:'inflow',amount_cents:2000,excluded:false,matches:[{matched_amount_cents:2000,status:'confirmed'}]}]})},error:null})};
 const original=Module._load;let detail;
 try{Module._load=function(name,...args){
 if(name==='server-only')return {};
 if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>service};
 if(name==='@/lib/services/context')return {requireOrgContext:async()=>({orgId:'org',userId:'user',supabase:service})};
 if(name==='@/lib/services/books/access')return {requireBooksAuthorization:async()=>{}};
 if(['@/lib/services/books/bank-ai-suggestions','@/lib/services/books/bank-rules-data','@/lib/services/audit','@/lib/services/events'].includes(name))return {};
 return original.call(this,name,...args);
 };detail=require('../lib/services/books/bank-reconciliation').getBankReconciliationDetail;}finally{Module._load=original}
 const closed=await detail('rec');assert.equal(closed.items[0].description,'Original deposit');assert.equal(closed.clearedBalanceCents,12000);assert.equal(closed.bookDifferenceCents,0);assert.equal(closed.evidenceDigest,'frozen-digest');assert.equal(closed.outstandingItems[0].amount_cents,-1000);
 legacy=true;const older=await detail('rec');assert.equal(older.legacyTransactionEvidence,true);assert.deepEqual(older.items,[]);assert.equal(older.differenceCents,0);assert.equal(older.clearedBalanceCents,12000);assert.equal(feedReads,0);hasEvidence=false;await assert.rejects(detail("rec"),/no preserved accounting evidence/);assert.equal(feedReads,0);
});
for (const scenario of [{name:'outstanding check',factor:1,outstanding:-1000},{name:'deposit in transit',factor:1,outstanding:1000},{name:'credit-card payment in transit',factor:-1,outstanding:-1000}]) test(`real bank close rolls forward ${scenario.name} and preserves reopen history`,async t=>{
 const {createBooksLedgerDb}=require('./helpers/books-ledger-db');const fs=require('node:fs');const path=require('node:path');const db=await createBooksLedgerDb();t.after(()=>db.close());
 await db.exec(`create schema extensions;create function extensions.digest(text,text) returns bytea language sql as $$select sha256(convert_to($1,'UTF8'))$$;
 create table bank_accounts(id uuid primary key,org_id uuid,gl_account_id uuid);
 create table bank_transactions(id uuid primary key,org_id uuid,bank_account_id uuid,transaction_date date,lifecycle_status text,excluded boolean,direction text,amount_cents bigint,description text,merchant_name text);
 create table bank_transaction_matches(id uuid primary key,org_id uuid,bank_transaction_id uuid,journal_line_id uuid,matched_amount_cents bigint,status text);
 create table bank_reconciliations(id uuid primary key,org_id uuid,bank_account_id uuid,statement_start date,statement_end date,beginning_balance_cents bigint,ending_balance_cents bigint,status text default 'draft',digest text,cleared_balance_cents bigint,difference_cents bigint,book_balance_cents bigint,outstanding_balance_cents bigint,evidence jsonb,closed_by uuid,closed_at timestamptz,evidence_history jsonb default '[]'::jsonb);
 create table bank_reconciliation_items(id uuid primary key default gen_random_uuid(),org_id uuid,reconciliation_id uuid,bank_transaction_id uuid,journal_line_id uuid,amount_cents bigint,item_status text);`);
 const integrity=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260908010036_books_bank_integrity.sql'),'utf8');
 const definition=name=>{const start=integrity.indexOf(`create or replace function public.${name}(`);return integrity.slice(start,integrity.indexOf('\n$$;',start)+4)};
 await db.exec(definition('validate_books_bank_match'));
 await db.exec('create trigger validate_match before insert or update on bank_transaction_matches for each row execute function validate_books_bank_match()');
 await db.exec(definition('reopen_books_bank_reconciliation'));
 await db.exec("alter table bank_transaction_matches add column match_type text default 'exact'");
 await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261003021045_books_bank_statement_evidence.sql'),'utf8'));
 await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261003020833_books_bank_statement_sequence.sql'),'utf8'));
 const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;const org=id(1),actor=id(2),cash=id(3),equity=id(4),bank=id(5),sept=id(6),oct=id(7);
 await db.exec(`insert into orgs values('${org}');insert into app_users values('${actor}');insert into gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance) values('${cash}','${org}','1000','Bank','${scenario.factor===1?'asset':'liability'}','${scenario.factor===1?'cash':'credit_card'}','${scenario.factor===1?'debit':'credit'}'),('${equity}','${org}','3000','Equity','equity','owner_equity','credit');insert into bank_accounts values('${bank}','${org}','${cash}');`);
 const post=async(key,normalAmount,kind='operational')=>{const amount=normalAmount*scenario.factor;return (await db.query('select post_books_journal_entry($1,$2,$3) id',[org,JSON.stringify({entry_date:'2026-09-15',entry_kind:kind,memo:key,posting_key:key,policy_version:1,source_type:'test'}),JSON.stringify([{line_no:1,account_id:cash,debit_cents:Math.max(amount,0),credit_cents:Math.max(-amount,0)},{line_no:2,account_id:equity,debit_cents:Math.max(-amount,0),credit_cents:Math.max(amount,0)}])])).rows[0].id;};
 await post('opening',10000,'opening');const deposit=await post('deposit',2000);const check=await post('outstanding',scenario.outstanding);
 const match=async(n,date,amount,direction,entry)=>{
 await db.query("insert into bank_transactions values($1,$2,$3,$4,'posted',false,$5,$6,'Original statement description',null)",[id(n),org,bank,date,direction,amount]);
 await db.query("insert into bank_transaction_matches(id,org_id,bank_transaction_id,journal_line_id,matched_amount_cents,status) select $1,$2,$3,id,$4,'confirmed' from journal_lines where entry_id=$5 and account_id=$6",[id(n+100),org,id(n),amount,entry,cash]);};
 await match(10,'2026-09-20',2000,scenario.factor===1?'inflow':'outflow',deposit);
 await db.query("insert into bank_reconciliations(id,org_id,bank_account_id,statement_start,statement_end,beginning_balance_cents,ending_balance_cents) values($1,$2,$3,'2026-09-01','2026-09-30',10000,12000)",[sept,org,bank]);
 const close=id=>db.query('select close_books_bank_reconciliation_atomic($1,$2,$3)',[org,id,actor]);await close(sept);
 const evidence=async id=>(await db.query('select evidence from bank_reconciliations where id=$1',[id])).rows[0].evidence;
 const first=await evidence(sept);assert.equal(first.outstanding_balance_cents,scenario.outstanding);assert.equal(first.statement_transactions[0].description,'Original statement description');
 await match(11,'2026-10-03',1000,scenario.outstanding*scenario.factor>0?'inflow':'outflow',check);
 await db.query("insert into bank_reconciliations(id,org_id,bank_account_id,statement_start,statement_end,beginning_balance_cents,ending_balance_cents) values($1,$2,$3,'2026-10-01','2026-10-31',12000,$4)",[oct,org,bank,12000+scenario.outstanding]);await close(oct);
 const second=await evidence(oct);assert.equal(second.outstanding_balance_cents,0);assert.equal(second.book_balance_cents,12000+scenario.outstanding);assert.equal(second.statement_transactions.length,1);assert.deepEqual(await evidence(sept),first);
 await close(oct);assert.deepEqual(await evidence(oct),second);
 const reopen=rec=>db.query('select reopen_books_bank_reconciliation($1,$2,$3,$4)',[org,rec,'Correct statement classification',actor]);
 await assert.rejects(reopen(sept),/later bank statements first/);
 await reopen(oct);await reopen(sept);
 const histories=(await db.query('select evidence_history from bank_reconciliations order by statement_end')).rows;
 assert.deepEqual(histories[0].evidence_history[0].evidence,first);assert.deepEqual(histories[1].evidence_history[0].evidence,second);
 await close(sept);await close(oct);
 assert.equal((await evidence(sept)).outstanding_balance_cents,scenario.outstanding);
 assert.equal((await evidence(oct)).outstanding_balance_cents,0);

});
