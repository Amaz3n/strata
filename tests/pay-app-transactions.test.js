const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const runtime = process.env.ARC_PGLITE_MODULE

test('pay application transactions preserve financial invariants', { skip: !runtime }, async (t) => {
  const { PGlite } = require(runtime)
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.jwt() returns jsonb language sql as $$ select '{"role":"service_role"}'::jsonb $$;
      create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
      create table memberships(id uuid,org_id uuid,user_id uuid,status text,role_id uuid,project_scope text);
      create table membership_permission_overrides(membership_id uuid,permission_key text,effect text);
      create table role_permissions(role_id uuid,permission_key text);
      create table project_members(org_id uuid,project_id uuid,user_id uuid,status text);
      create table portal_access_tokens(id uuid primary key);
      create table contracts(id uuid primary key, org_id uuid, project_id uuid);
      create table invoices(id uuid primary key,org_id uuid,project_id uuid,source_pay_application_id uuid,
        status text,approval_status text,client_visible boolean,token text,sent_at timestamptz,sent_to_emails text[],delivery_status text,
        issued_snapshot jsonb,product_posture text,invoice_number text,title text,issue_date date,due_date date,
        metadata jsonb default '{}',source_type text,subtotal_cents bigint,tax_cents bigint,total_cents bigint,balance_due_cents bigint);
      create table pay_applications(id uuid primary key,org_id uuid,project_id uuid,contract_id uuid,application_number integer,status text,
        invoice_id uuid,submitted_at timestamptz,approved_at timestamptz,paid_at timestamptz,pdf_file_id uuid,
        original_contract_sum_cents bigint,change_order_sum_cents bigint,contract_sum_to_date_cents bigint,total_completed_stored_cents bigint,
        retainage_cents bigint,total_earned_less_retainage_cents bigint,previous_certificates_cents bigint,current_payment_due_cents bigint,balance_to_finish_cents bigint,
        metadata jsonb default '{}',updated_at timestamptz default now());
      create table prime_sov_lines(id uuid primary key,org_id uuid,contract_id uuid,line_number integer,description text,scheduled_value_cents bigint,
        previous_billed_cents bigint default 0,stored_materials_cents bigint default 0,retainage_held_cents bigint default 0,retainage_released_cents bigint default 0);
      create table pay_application_lines(id uuid primary key,org_id uuid,pay_application_id uuid,prime_sov_line_id uuid,
        scheduled_value_cents bigint,previous_billed_cents bigint,this_period_cents bigint,stored_materials_cents bigint,
        percent_complete numeric,balance_to_finish_cents bigint,retainage_cents bigint,metadata jsonb default '{}');
      create table invoice_lien_waivers(id uuid,org_id uuid,invoice_id uuid,status text);
      create table invoice_lines(id uuid primary key default gen_random_uuid(),org_id uuid,invoice_id uuid,cost_code_id uuid,budget_line_id uuid,
        description text,quantity numeric,unit text,unit_price_cents integer,metadata jsonb default '{}',sort_order integer default 0);
      create table outbox(id bigint generated always as identity,org_id uuid,job_type text,payload jsonb,run_at timestamptz,dedupe_key text unique);
      -- Isolate the new transaction from the preexisting invoice-void RPC. Injected failure proves rollback across its call boundary.
      create function public.void_invoice_atomic(p_org_id uuid,p_invoice_id uuid,p_actor_id uuid) returns jsonb language plpgsql as $$
      begin
        if current_setting('test.fail_invoice_void',true)='yes' then raise exception 'Injected invoice failure'; end if;
        update public.invoices set status='void' where id=p_invoice_id and org_id=p_org_id;
        return '{}'::jsonb;
      end; $$;
    `)
    await db.exec(fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260905004132_pay_application_integrity.sql'), 'utf8'))
    const org = randomUUID(), project = randomUUID(), contract = randomUUID(), actor = randomUUID(), sov = randomUUID()
    await db.query('insert into contracts values ($1,$2,$3)', [contract, org, project])
    await db.query("insert into prime_sov_lines(id,org_id,contract_id,line_number,description,scheduled_value_cents) values($1,$2,$3,1,'Foundations',100000)", [sov, org, contract])
    async function draft(number, previous=0, work=10000, priorStored=0, stored=0) {
      const app=randomUUID(), invoice=randomUUID(), line=randomUUID()
      await db.query("insert into pay_applications(id,org_id,project_id,contract_id,application_number,status) values($1,$2,$3,$4,$5,'draft')",[app,org,project,contract,number])
      await db.query("insert into pay_application_lines values($1,$2,$3,$4,100000,$5,$6,$7,10,90000,1000,$8::jsonb)",[line,org,app,sov,previous,work,stored,JSON.stringify({previous_stored_materials_cents:priorStored})])
      await db.query("insert into invoices(id,org_id,project_id,source_pay_application_id,status,total_cents,metadata,token) values($1,$2,$3,$4,'draft',9000,'{}','existing-token')",[invoice,org,project,app])
      await db.query("insert into invoice_lines(org_id,invoice_id,description,quantity,unit,unit_price_cents) values($1,$2,'Foundations',1,'sov',9000)",[org,invoice])
      return {app,invoice,line}
    }
    async function post(item) {
      const lines=(await db.query('select to_jsonb(l) item from pay_application_lines l where pay_application_id=$1',[item.app])).rows.map(row=>row.item)
      const summary={expected_lines:lines,original_contract_sum_cents:100000,change_order_sum_cents:0,contract_sum_to_date_cents:100000,
        total_completed_stored_cents:10000,retainage_cents:1000,total_earned_less_retainage_cents:9000,
        previous_certificates_cents:0,current_payment_due_cents:9000,balance_to_finish_cents:91000,
        metadata:{report_snapshot:{projectName:'Frozen project',revision:0,lines:[{description:'Original scope'}]}}}
      return db.query('select post_pay_application($1,$2,$3,$4::jsonb)',[org,item.app,item.invoice,JSON.stringify(summary)])
    }
    const first=await draft(1)
    await t.test('rejects a stale SOV baseline without changing rollups or application',async()=>{
      await db.query('update prime_sov_lines set previous_billed_cents=1 where id=$1',[sov])
      await assert.rejects(post(first),/Schedule of values changed/)
      assert.equal((await db.query('select status from pay_applications where id=$1',[first.app])).rows[0].status,'draft')
      await db.query('update prime_sov_lines set previous_billed_cents=0 where id=$1',[sov])
    })
    await post(first)
    const certificate={requested_amount_cents:9000,deferred_amount_cents:0,deferrals:[],certified_amount_cents:9000,signer_name:'Owner',certified_at:'2026-09-05T00:00:00Z'}
    const certify=()=>db.query('select certify_pay_application_atomic($1,$2,$3,$4::jsonb,$5::text[],0)',[org,first.app,actor,JSON.stringify(certificate),['owner@example.test']])
    await t.test('invoice failure rolls back certificate and preserves draft invoice',async()=>{
      await db.exec("alter table invoices add constraint force_failure check(status<>'sent')")
      await assert.rejects(certify(),/force_failure/)
      assert.equal((await db.query('select status from pay_applications where id=$1',[first.app])).rows[0].status,'invoiced')
      assert.equal((await db.query('select count(*)::int n from outbox')).rows[0].n,0)
      await db.exec('alter table invoices drop constraint force_failure')
    })
    await t.test('certification commits invoice snapshot, certificate, actor and durable job together',async()=>{
      await certify()
      const app=(await db.query('select * from pay_applications where id=$1',[first.app])).rows[0]
      const invoice=(await db.query('select * from invoices where id=$1',[first.invoice])).rows[0]
      assert.equal(app.status,'approved');assert.equal(app.metadata.certification_recorded_by,actor)
      assert.equal(invoice.status,'sent');assert.equal(invoice.token,'existing-token')
      assert.equal(invoice.issued_snapshot.totals.total_cents,9000)
      assert.equal((await db.query('select count(*)::int n from outbox')).rows[0].n,1)
      await certify()
      assert.equal((await db.query('select count(*)::int n from outbox')).rows[0].n,1)
    })
    await t.test('partial certification issues only the certified receivable and freezes explained deferrals',async()=>{
      const contract2=randomUUID(),sov2=randomUUID(),item=await (async()=>{
        await db.query('insert into contracts values ($1,$2,$3)',[contract2,org,project])
        await db.query("insert into prime_sov_lines(id,org_id,contract_id,line_number,description,scheduled_value_cents) values($1,$2,$3,1,'Steel',100000)",[sov2,org,contract2])
        const app=randomUUID(),invoice=randomUUID(),line=randomUUID()
        await db.query("insert into pay_applications(id,org_id,project_id,contract_id,application_number,status,invoice_id,current_payment_due_cents,metadata) values($1,$2,$3,$4,1,'invoiced',$5,9000,'{}')",[app,org,project,contract2,invoice])
        await db.query("insert into pay_application_lines values($1,$2,$3,$4,100000,0,10000,0,10,90000,1000,'{}')",[line,org,app,sov2])
        await db.query("insert into invoices(id,org_id,project_id,source_pay_application_id,status,total_cents,metadata) values($1,$2,$3,$4,'draft',9000,'{}')",[invoice,org,project,app])
        await db.query("insert into invoice_lines(org_id,invoice_id,description,quantity,unit,unit_price_cents) values($1,$2,'Steel',1,'sov',9000)",[org,invoice])
        return {app,invoice}
      })()
      const cert={requested_amount_cents:9000,deferred_amount_cents:2500,certified_amount_cents:6500,signer_name:'Owner',certified_at:'2026-09-05T00:00:00Z',
        deferrals:[{prime_sov_line_id:sov2,deferred_cents:2500,reason:'Awaiting inspection'}]}
      await db.query('select certify_pay_application_atomic($1,$2,$3,$4::jsonb,$5::text[],0)',[org,item.app,actor,JSON.stringify(cert),['owner@example.test']])
      const invoice=(await db.query('select * from invoices where id=$1',[item.invoice])).rows[0]
      assert.equal(Number(invoice.total_cents),6500);assert.equal(Number(invoice.balance_due_cents),6500)
      assert.equal(invoice.issued_snapshot.totals.total_cents,6500)
      assert.equal(invoice.issued_snapshot.lines.length,2)
      assert.equal((await db.query("select unit_price_cents from invoice_lines where invoice_id=$1 and unit='deferral'",[item.invoice])).rows[0].unit_price_cents,-2500)
    })
    const second=await draft(2,10000,5000)
    const returned={reason:'Revise quantities',revision:0}
    const returnFirst=()=>db.query('select return_pay_application_atomic($1,$2,$3,$4::jsonb,0)',[org,first.app,actor,JSON.stringify(returned)])
    await t.test('invoice reversal failure rolls back SOV, application and later draft rebasing',async()=>{
      await db.exec("set test.fail_invoice_void='yes'")
      await assert.rejects(returnFirst(),/Injected invoice failure/)
      assert.equal(Number((await db.query('select previous_billed_cents from prime_sov_lines where id=$1',[sov])).rows[0].previous_billed_cents),10000)
      assert.equal((await db.query('select status from pay_applications where id=$1',[first.app])).rows[0].status,'approved')
      await db.exec("set test.fail_invoice_void='no'")
    })
    await t.test('return preserves immutable revision and rebases a later draft without losing new work',async()=>{
      await returnFirst()
      const app=(await db.query('select * from pay_applications where id=$1',[first.app])).rows[0]
      assert.equal(app.status,'draft');assert.equal(app.metadata.revision,1);assert.equal(app.invoice_id,null)
      assert.equal(app.metadata.revision_history[0].report_snapshot.projectName,'Frozen project')
      assert.equal((await db.query('select status from invoices where id=$1',[first.invoice])).rows[0].status,'void')
      const line=(await db.query('select * from pay_application_lines where id=$1',[second.line])).rows[0]
      assert.equal(Number(line.previous_billed_cents),0);assert.equal(Number(line.this_period_cents),5000)
      await assert.rejects(post(second),/earlier returned application/)
      await assert.rejects(certify(),/revision changed/)
    })
    await t.test('public roles cannot execute financial mutation RPCs',async()=>{
      const rows=(await db.query("select has_function_privilege('authenticated','public.certify_pay_application_atomic(uuid,uuid,uuid,jsonb,text[],integer)','execute') allowed")).rows
      assert.equal(rows[0].allowed,false)
    })
  } finally { await db.close() }
})
