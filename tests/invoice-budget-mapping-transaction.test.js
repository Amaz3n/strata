const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const runtime = process.env.ARC_PGLITE_MODULE

test('invoice create, edit and revision preserve project budget allocations', { skip: !runtime }, async (t) => {
  const { PGlite } = require(runtime)
  const db = new PGlite()
  try {
    await db.exec(`
      create schema auth;
      create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
      create function public.is_org_member(uuid) returns boolean language sql as $$ select true $$;
      create table budgets(id uuid primary key, org_id uuid, project_id uuid);
      create table budget_lines(id uuid primary key, org_id uuid, budget_id uuid);
      create table invoices(id uuid primary key default gen_random_uuid(), org_id uuid, project_id uuid, token text,
        invoice_number text, title text, status text, issue_date date, due_date date, notes text,
        client_visible boolean default false, subtotal_cents bigint, tax_cents bigint, total_cents bigint, balance_due_cents bigint,
        source_type text, source_draw_id uuid, source_change_order_id uuid, source_pay_application_id uuid,
        metadata jsonb default '{}', sent_at timestamptz, sent_to_emails text[], product_posture text, approval_status text,
        delivery_status text, issued_snapshot jsonb, updated_at timestamptz default now(), currency text default 'USD',
        recipient_contact_id uuid, tax_rate numeric, billing_period_id uuid, tax_jurisdiction_id uuid);
      create table invoice_lines(id uuid primary key default gen_random_uuid(), org_id uuid, invoice_id uuid,
        cost_code_id uuid, budget_line_id uuid, description text, quantity numeric, unit text, unit_price_cents bigint, metadata jsonb);
      create table billable_costs(id uuid primary key, org_id uuid, invoice_id uuid, invoice_line_id uuid, status text, billed_at timestamptz);
      create table draw_schedules(id uuid primary key, org_id uuid, invoice_id uuid, status text, invoiced_at timestamptz);
      create table retainage(id uuid primary key default gen_random_uuid(), org_id uuid, project_id uuid, contract_id uuid,
        invoice_id uuid, amount_cents bigint, status text, updated_at timestamptz);
      create table payments(id uuid primary key, org_id uuid, invoice_id uuid, status text);
      create table payment_allocations(id uuid primary key, org_id uuid, invoice_id uuid, payment_id uuid);
      create table project_fee_schedule_lines(id uuid primary key, org_id uuid, invoice_id uuid, invoice_line_id uuid);
      create table project_fee_billings(id uuid primary key, org_id uuid, invoice_id uuid, status text);
      create table project_billing_periods(id uuid primary key, org_id uuid, invoice_ids uuid[], metadata jsonb);
      create table qbo_invoice_reservations(id uuid primary key, org_id uuid, status text, used_by_invoice_id uuid, reserved_number text);
    `)
    await db.exec(fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260905004943_invoice_budget_mapping.sql'), 'utf8'))
    const org = randomUUID(), project = randomUUID(), budget = randomUUID(), budgetLine = randomUUID(), otherLine = randomUUID()
    const otherBudget = randomUUID(), otherProject = randomUUID()
    await db.query('insert into budgets values ($1,$2,$3),($4,$2,$5)', [budget, org, project, otherBudget, otherProject])
    await db.query('insert into budget_lines values ($1,$2,$3),($4,$2,$5)', [budgetLine, org, budget, otherLine, otherBudget])
    const header = { project_id: project, invoice_number: 'INV-1', title: 'Progress', status: 'draft', client_visible: false,
      total_cents: 10000, subtotal_cents: 10000, balance_due_cents: 10000 }
    const line = { budget_line_id: budgetLine, description: 'Foundation progress', quantity: 1, unit_price_cents: 10000 }
    const create = (lines) => db.query('select create_invoice_atomic($1,$2::jsonb,$3::jsonb) result', [org, JSON.stringify(header), JSON.stringify(lines)])
    const update = (id, lines) => db.query('select update_invoice_atomic($1,$2,$3::jsonb,$4::jsonb) result', [org, id, JSON.stringify(header), JSON.stringify(lines)])
    let invoice
    await t.test('creation persists the code-off budget link', async () => {
      invoice = (await create([line])).rows[0].result.invoice
      assert.equal((await db.query('select budget_line_id from invoice_lines where invoice_id=$1', [invoice.id])).rows[0].budget_line_id, budgetLine)
    })
    await t.test('invalid allocation rolls back the invoice header and earlier lines', async () => {
      const count = (await db.query('select count(*) from invoices')).rows[0].count
      await assert.rejects(create([line, { ...line, budget_line_id: otherLine }]), /must belong to its project/)
      assert.equal((await db.query('select count(*) from invoices')).rows[0].count, count)
    })
    await t.test('editing retains mapping and wrong-project edit rolls back deleted lines', async () => {
      await update(invoice.id, [{ ...line, description: 'Updated progress' }])
      const before = (await db.query('select * from invoice_lines where invoice_id=$1', [invoice.id])).rows
      assert.equal(before[0].budget_line_id, budgetLine)
      await assert.rejects(update(invoice.id, [{ ...line, budget_line_id: otherLine }]), /must belong to its project/)
      assert.deepEqual((await db.query('select * from invoice_lines where invoice_id=$1', [invoice.id])).rows, before)
    })
    await t.test('revising an issued invoice copies allocation into an editable draft', async () => {
      await db.query("update invoices set status='sent', client_visible=true, sent_at=now() where id=$1", [invoice.id])
      const revised = (await db.query('select revise_invoice_atomic($1,$2,$3,$4) result', [org, invoice.id, randomUUID(), 'INV-2'])).rows[0].result
      assert.equal(revised.original.status, 'void')
      assert.equal(revised.replacement.status, 'draft')
      assert.equal((await db.query('select budget_line_id from invoice_lines where invoice_id=$1', [revised.replacement.id])).rows[0].budget_line_id, budgetLine)
      await update(revised.replacement.id, [{ ...line, description: 'Revised progress' }])
    })
  } finally { await db.close() }
})
