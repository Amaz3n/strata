const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const runtime = process.env.ARC_PGLITE_MODULE
const read = name => fs.readFileSync(path.join(__dirname,'../supabase/migrations',name),'utf8')
function fn(sql,name) {
  const start=sql.indexOf(`create or replace function public.${name}(`)
  assert.ok(start>=0,name)
  return sql.slice(start,sql.indexOf('$$;',sql.indexOf('as $$',start))+3)
}
test('customer refunds preserve balances, deposits, idempotency and tenant boundaries', {skip:!runtime}, async t => {
  const {PGlite}=require(runtime)
  const db=new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table invoices(id uuid primary key,org_id uuid,project_id uuid,status text,total_cents integer,balance_due_cents integer,due_date date,client_visible boolean,sent_at timestamptz);
      create table payments(id uuid primary key,org_id uuid,project_id uuid,invoice_id uuid,amount_cents integer,provider text,status text,metadata jsonb default '{}');
      create table payment_allocations(id uuid,org_id uuid,invoice_id uuid,payment_id uuid,amount_cents integer);
      create table receivable_adjustments(id uuid,org_id uuid,invoice_id uuid,amount_cents integer,status text);
      create table payment_reversals(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,invoice_id uuid,payment_id uuid,amount_cents integer,reversal_type text,status text,provider_reversal_id text,reason text,metadata jsonb);
      create table accounting_sync_records(org_id uuid,entity_type text,entity_id uuid,external_id text,status text,error_message text);
      create unique index reversal_reference on payment_reversals(org_id,provider_reversal_id);`)
    const engine=read('20260715100001_unify_invoice_status_engine.sql')
    await db.exec(fn(engine,'derive_invoice_status')+fn(read('20260812160000_receivable_adjustments.sql'),'invoice_paid_cents')+fn(engine,'record_payment_reversal_atomic'))
    await db.exec(read('20260921123155_customer_billing_refunds.sql'))
    async function seed(provider='manual', applied=0, credit=0) {
      const org=randomUUID(),invoice=randomUUID(),payment=randomUUID(),actor=randomUUID()
      await db.query(`insert into invoices values($1,$2,null,'paid',10000,0,'2026-01-01',true,now())`,[invoice,org])
      await db.query(`insert into payments(id,org_id,invoice_id,amount_cents,provider,status) values($1,$2,$3,10000,$4,'succeeded')`,[payment,org,invoice,provider])
      if(applied) await db.query(`insert into payments(id,org_id,amount_cents,status,metadata) values($1,$2,$3,'succeeded',$4)`,[randomUUID(),org,applied,JSON.stringify({deposit_payment_id:payment,customer_deposit_application:true})])
      if(credit) await db.query(`insert into receivable_adjustments values($1,$2,$3,$4,'posted')`,[randomUUID(),org,invoice,credit])
      return {org,invoice,payment,actor}
    }
    const refund=(s,amount,key=randomUUID(),reason='Returned by check')=>db.query(`select public.record_manual_customer_refund_atomic($1,$2,$3,$4,$5,$6) result`,[s.org,s.payment,amount,reason,key,s.actor])
    await t.test('partial refund reopens only the returned amount and keeps existing credit',async()=>{
      const s=await seed('manual',0,2000)
      await db.query(`insert into accounting_sync_records values($1,'invoice',$2,'external-invoice','synced',null)`,[s.org,s.invoice])
      await refund(s,3000)
      assert.equal((await db.query('select status from accounting_sync_records where entity_id=$1',[s.invoice])).rows[0].status,'needs_review')
      const {rows:[invoice]}=await db.query('select status,balance_due_cents from invoices where id=$1',[s.invoice])
      assert.equal(invoice.balance_due_cents,1000);assert.equal(invoice.status,'partial')
    })
    await t.test('retry returns the same refund and rejects changed details',async()=>{
      const s=await seed(),key=randomUUID()
      const a=await refund(s,4000,key),b=await refund(s,4000,key)
      assert.equal(a.rows[0].result.id,b.rows[0].result.id)
      await assert.rejects(refund(s,5000,key),/different details/)
      await assert.rejects(refund(s,4000,key,'Other reason'),/different details/)
    })
    await t.test('applied deposits cannot also be refunded',async()=>{
      const s=await seed('manual',7500)
      await assert.rejects(refund(s,2501),/still available/)
      await refund(s,2500)
      await assert.rejects(refund(s,1),/still available/)
    })
    await t.test('full refunds are retryable and cannot be repeated',async()=>{
      const s=await seed(),key=randomUUID();await refund(s,10000,key);await refund(s,10000,key)
      assert.equal((await db.query('select status from payments where id=$1',[s.payment])).rows[0].status,'refunded')
      await assert.rejects(refund(s,1),/Only received manual/)
    })
    await t.test('provider payments and another organization are rejected',async()=>{
      const s=await seed('stripe');await assert.rejects(refund(s,100),/Only received manual/)
      await assert.rejects(refund({...s,org:randomUUID()},100),/not found/)
    })
    await t.test('browser roles cannot invoke the privileged command',async()=>{
      const {rows:[row]}=await db.query(`select has_function_privilege('authenticated','public.record_manual_customer_refund_atomic(uuid,uuid,integer,text,text,uuid)','execute') browser, has_function_privilege('service_role','public.record_manual_customer_refund_atomic(uuid,uuid,integer,text,text,uuid)','execute') service`)
      assert.equal(row.browser,false);assert.equal(row.service,true)
    })
  } finally {await db.close()}
})
