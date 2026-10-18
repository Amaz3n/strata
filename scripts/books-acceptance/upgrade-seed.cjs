// Synthetic, representative data for the populated-upgrade route. It is written
// against the PRODUCTION BASELINE schema (docs/books-evidence/*/production-baseline.txt)
// and goes through the same SQL functions the application calls, so the October
// train's backfills and validation blocks meet rows shaped like real ones.
// Never contains customer data; every identifier is deterministic.
require("../register-ts-node-test")
const { CONSTRUCTION_CHART_TEMPLATE } = require("../../lib/services/books/chart-of-accounts")

const id = (n) => `5eed0000-0000-4000-8000-${String(n).padStart(12, "0")}`
const q = (s) => `'${String(s).replace(/'/g, "''")}'`
const ORG = id(1),
  MAKER = id(2),
  REVIEWER = id(3)
const PROJECTS = [
  { id: id(10), name: "Residential custom home", type: "residential" },
  { id: id(11), name: "Commercial tenant improvement", type: "commercial" },
  { id: id(12), name: "Production lot 14", type: "production" },
]
const COST_CODE = id(22)
const VENDOR = id(20),
  CLIENT = id(21)

function seedSql() {
  const sql = []
  sql.push("begin;")
  for (const [user, email, name] of [
    [MAKER, "upgrade-maker@example.test", "Upgrade Maker"],
    [REVIEWER, "upgrade-reviewer@example.test", "Upgrade Reviewer"],
  ]) {
    sql.push(`insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at,raw_app_meta_data,raw_user_meta_data)
values(${q(user)},'00000000-0000-0000-0000-000000000000','authenticated','authenticated',${q(email)},'',now(),now(),'{}','{}');`)
    sql.push(`insert into public.app_users(id,email,full_name) values(${q(user)},${q(email)},${q(name)}) on conflict (id) do nothing;`)
  }
  sql.push(`insert into public.orgs(id,name,slug,created_by,product_tier) values(${q(ORG)},'Upgrade Acceptance Builder','upgrade-acceptance-builder',${q(MAKER)},'production');`)
  for (const [user, role] of [
    [MAKER, "org_owner"],
    [REVIEWER, "org_books_reviewer"],
  ])
    sql.push(`insert into public.memberships(org_id,user_id,role_id,status) select ${q(ORG)},${q(user)},id,'active' from public.roles where key=${q(role)};`)

  // Mirrors initializeArcBooks (lib/services/books/ledger.ts).
  sql.push(`insert into public.books_settings(org_id,workspace_enabled,ledger_authority,arc_ledger_mode,external_sync_posture,functional_currency,reporting_basis,active_policy_version,created_by,updated_by)
values(${q(ORG)},true,'external','shadow','normal','usd','accrual',1,${q(MAKER)},${q(MAKER)});`)
  // Today's template includes accounts whose subtypes arrive with later
  // migrations; a baseline-era org can only hold the ones its schema accepts.
  sql.push(
    `do $chart$ declare a record; begin for a in select * from (values\n` +
      CONSTRUCTION_CHART_TEMPLATE.map(
        (a) =>
          `(${q(a.code)},${q(a.name)},${q(a.accountType)},${q(a.subtype)},${q(a.normalBalance)},${a.cashFlowCategory ? q(a.cashFlowCategory) : "null::text"},${a.system})`,
      ).join(",\n") +
      `) v(code,name,account_type,subtype,normal_balance,cash_flow_category,is_system) loop
  begin
    insert into public.gl_accounts(org_id,code,name,account_type,subtype,normal_balance,cash_flow_category,is_system,active,created_by,updated_by)
    values(${q(ORG)},a.code,a.name,a.account_type,a.subtype,a.normal_balance,a.cash_flow_category,a.is_system,true,${q(MAKER)},${q(MAKER)});
  exception when check_violation then null;
  end;
end loop; end $chart$;`,
  )

  sql.push(`insert into public.cost_codes(id,org_id,code,name) values(${q(COST_CODE)},${q(ORG)},'06-100','Rough carpentry');`)
  sql.push(`insert into public.companies(id,org_id,name) values(${q(VENDOR)},${q(ORG)},'Upgrade Framing Co'),(${q(CLIENT)},${q(ORG)},'Upgrade Owner LLC');`)
  for (const p of PROJECTS) {
    sql.push(`insert into public.projects(id,org_id,name,property_type,created_by) values(${q(p.id)},${q(ORG)},${q(p.name)},${q(p.type)},${q(MAKER)});`)
    sql.push(`insert into public.project_financial_settings(org_id,project_id) values(${q(ORG)},${q(p.id)}) on conflict do nothing;`)
  }

  // Receivables: one invoice per project, issued, with partial and full payment.
  PROJECTS.forEach((p, i) => {
    const total = 1_250_000 + i * 310_000
    sql.push(`select public.create_invoice_atomic(${q(ORG)}, jsonb_build_object(
  'project_id',${q(p.id)},'invoice_number',${q(`UPG-${i + 1}`)},'title',${q(`Progress billing ${i + 1}`)},
  'issue_date','2026-08-0${i + 1}','due_date','2026-09-0${i + 1}','client_visible',true,'approval_status','approved',
  'product_posture',${q(p.type)},'subtotal_cents',${total},'tax_cents',0,'total_cents',${total},'balance_due_cents',${total},
  'token',${q(`upgrade-token-${i + 1}`)},'metadata','{}'::jsonb),
  jsonb_build_array(jsonb_build_object('description','Work completed','quantity',1,'unit_price_cents',${total},'amount_cents',${total})));`)
    const paid = i === 0 ? total : Math.floor(total / 2)
    sql.push(`select public.apply_invoice_payment_atomic(${q(ORG)},(select id from public.invoices where org_id=${q(ORG)} and invoice_number=${q(`UPG-${i + 1}`)}),${paid},'usd','ach','manual',${q(`upgrade-payment-${i + 1}`)},'succeeded',${q(`ACH-${i + 1}`)},0,${paid},${paid},${q(`upgrade-payment-${i + 1}`)},'{}'::jsonb);`)
  })

  // Payables: approved bills, one paid manually.
  PROJECTS.forEach((p, i) => {
    const bill = id(30 + i),
      total = 420_000 + i * 55_000
    sql.push(`insert into public.vendor_bills(id,org_id,project_id,company_id,bill_number,bill_date,due_date,status,total_cents,currency,metadata)
values(${q(bill)},${q(ORG)},${q(p.id)},${q(VENDOR)},${q(`VB-${i + 1}`)},'2026-08-1${i}','2026-09-1${i}','pending',${total},'usd','{}'::jsonb);`)
    sql.push(`insert into public.bill_lines(org_id,bill_id,description,quantity,unit_cost_cents,cost_code_id) values(${q(ORG)},${q(bill)},'Framing labor and material',1,${total},${q(COST_CODE)});`)
  })
  sql.push(`select public.approve_vendor_bills_atomic(${q(ORG)},${q(MAKER)},jsonb_build_array(${[30, 31, 32].map((n) => `jsonb_build_object('id',${q(id(n))})`).join(",")}));`)
  sql.push(`select public.record_manual_ap_payment_atomic(${q(ORG)},${q(id(30))},${q(MAKER)},420000,'usd','check','CHK-1001','1001','2026-09-05T12:00:00Z','{}'::jsonb,'upgrade-ap-1');`)

  // Expenses on each project.
  PROJECTS.forEach((p, i) =>
    sql.push(`insert into public.project_expenses(org_id,project_id,expense_date,amount_cents,description,status) values(${q(ORG)},${q(p.id)},'2026-08-2${i}',${18_500 + i * 1_000},'Site supplies','approved');`),
  )

  // A direct journal entry and an exact reversal of a second one.
  const line = (no, code, debit, credit, project) =>
    `jsonb_build_object('line_no',${no},'account_id',(select id from public.gl_accounts where org_id=${q(ORG)} and code=${q(code)}),'project_id',${project ? q(project) : "null"},'debit_cents',${debit},'credit_cents',${credit})`
  sql.push(`select public.post_books_journal_entry(${q(ORG)},jsonb_build_object('entry_date','2026-08-31','entry_kind','adjusting','memo','Accrued equipment rental','posting_key','upgrade-accrual','policy_version',1,'created_by',${q(MAKER)}),
  jsonb_build_array(${line(1, "5040", 75_000, 0, PROJECTS[0].id)},${line(2, "2000", 0, 75_000)}));`)
  sql.push(`select public.post_books_journal_entry(${q(ORG)},jsonb_build_object('entry_date','2026-08-31','entry_kind','adjusting','memo','Misposted accrual','posting_key','upgrade-misposted','policy_version',1,'created_by',${q(MAKER)}),
  jsonb_build_array(${line(1, "5040", 12_500, 0, PROJECTS[1].id)},${line(2, "2000", 0, 12_500)}));`)
  // Exactly reverse the misposted entry; the train re-validates existing chains.
  sql.push(`select public.reverse_books_journal_entry(${q(ORG)},(select id from public.journal_entries where org_id=${q(ORG)} and posting_key='upgrade-misposted'),
  jsonb_build_object('entry_date','2026-09-01','entry_kind','reversal','memo','Reverse misposted accrual','posting_key','upgrade-misposted-reversal','policy_version',1,'created_by',${q(MAKER)},
    'reversal_of_entry_id',(select id from public.journal_entries where org_id=${q(ORG)} and posting_key='upgrade-misposted')),
  jsonb_build_array(${line(1, "5040", 0, 12_500, PROJECTS[1].id)},${line(2, "2000", 12_500, 0)}));`)
  sql.push("commit;")
  return sql.join("\n")
}

module.exports = { seedSql, ORG }
if (require.main === module) process.stdout.write(seedSql() + "\n")
