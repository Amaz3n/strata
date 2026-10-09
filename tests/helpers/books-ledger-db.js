const { migrationSql } = require("../support/migration-sql")
const { PGlite } = require("@electric-sql/pglite")
const read = name => migrationSql(name.replace(/\.sql$/, ""))

function definition(sql, prefix, end) {
  const start = sql.indexOf(prefix)
  if (start < 0) throw new Error(`Missing SQL definition: ${prefix}`)
  const finish = sql.indexOf(end, start)
  if (finish < 0) throw new Error(`Missing SQL terminator: ${prefix}`)
  return sql.slice(start, finish + end.length)
}

/** Real journal tables, RPC, and constraints. Only non-accounting parents are fixtures. */
async function createBooksLedgerDb({ coreOwnerRelationships = true, exactReversals = true } = {}) {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table orgs(id uuid primary key);
    create table app_users(id uuid primary key);
    create table projects(id uuid primary key, org_id uuid, status text default 'active');
    create table companies(id uuid primary key, org_id uuid);
    create table contracts(id uuid primary key,org_id uuid,project_id uuid,parent_contract_id uuid,status text);
  `)
  const foundation = read("20260801143926_books_accounting_foundation.sql")
  for (const table of ["gl_accounts", "accounting_periods", "accounting_facts", "journal_entries", "journal_lines", "poc_snapshots", "books_close_items"]) {
    await db.exec(definition(foundation, `create table public.${table} (`, "\n);"))
  }
  for (const fn of ["books_validate_period_range", "books_validate_journal_line_scope", "books_guard_posted_journal", "books_guard_closed_period", "books_reject_mutation", "post_books_journal_entry"]) {
    await db.exec(definition(foundation, `create or replace function public.${fn}(`, "\n$$;"))
  }
  await db.exec(read("20260808170000_books_balance_trigger_row_type_fix.sql"))
  for (const trigger of ["accounting_periods_validate_range", "journal_lines_validate_scope", "journal_entries_guard_posted", "journal_lines_guard_posted", "journal_entries_closed_period_guard", "poc_snapshots_immutable", "accounting_facts_immutable"]) {
    await db.exec(definition(foundation, `create trigger ${trigger}\n`, ";"))
  }
  for (const trigger of ["journal_entries_balanced", "journal_lines_balanced"]) {
    await db.exec(definition(foundation, `create constraint trigger ${trigger}\n`, ";"))
  }
  const hardening = read("20260812120755_books_release_hardening.sql")
  for (const fn of ["books_guard_posted_journal", "reverse_books_journal_entry", "begin_books_period_close", "cancel_books_period_close"]) {
    await db.exec(definition(hardening, `create or replace function public.${fn}(`, "\n$$;"))
  }
  await db.exec(read("20261003002108_books_close_control_integrity.sql"))
  await db.exec("alter table books_close_items add column support_review jsonb")
  await db.exec(read("20261003010157_books_wip_review.sql"))
  await db.exec(`create table job_cost_entries(id uuid,org_id uuid,project_id uuid,status text,incurred_on date,cost_cents bigint);
    create table invoices(id uuid,org_id uuid,project_id uuid,status text,issue_date date,total_cents bigint,tax_cents bigint,metadata jsonb);
    create table retainage(org_id uuid,invoice_id uuid,release_invoice_id uuid,amount_cents bigint);
    create table receivable_adjustments(id uuid,org_id uuid,project_id uuid,status text,adjustment_type text,effective_date date,amount_cents bigint,tax_cents bigint,voided_at timestamptz);`)
  await db.exec(read("20261003011254_books_historical_wip_preparation.sql"))
  await db.exec(read("20261003012630_books_completed_wip_carryforward.sql"))
  await db.exec(read("20261003013441_books_wip_input_integrity.sql"))
  await db.exec(read("20261003014320_books_expected_loss_provisions.sql"))
  const fences=read('20261003235436_books_period_and_payroll_fences.sql')
  await db.exec(fences.slice(0,fences.indexOf('-- Ordinary source writers')))
  if (coreOwnerRelationships) await db.exec(read("20261004193127_books_core_ledger_owner_relationships.sql"))
  if (exactReversals) await db.exec(read("20261004194104_books_exact_reversal_posting.sql"))
  return db
}

module.exports = { createBooksLedgerDb }
