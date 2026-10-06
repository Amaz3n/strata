require("../../scripts/register-ts-node-test");
const fs = require("node:fs");
const {
  setup: base,
  id,
  org,
  entity,
  maker,
  reviewer,
  notes,
} = require("./books-native-adjustment-database");
async function setup(t) {
  const f = await base(t);
  await f.db
    .exec(`alter table invoices add column issue_date date default '2026-04-15',add column total_cents bigint default 10000,add column tax_cents bigint default 1000,add column status text default 'sent',add column metadata jsonb default '{}';alter table projects add column property_type text default 'residential',add column status text default 'active';
 create table books_settings(org_id uuid,workspace_enabled boolean,active_policy_version integer);insert into books_settings values('${org}',true,1);
 create table accounting_policies(id uuid,org_id uuid,version integer,status text,effective_on date,policy jsonb,created_by uuid,approved_by uuid,created_at timestamptz,approved_at timestamptz);insert into accounting_policies values('${id(600)}','${org}',1,'approved','2026-01-01','{}','${maker}','${reviewer}',now(),now());
 create table project_financial_settings(org_id uuid,project_id uuid,billing_model text,fixed_price_billing_basis text);insert into project_financial_settings values('${org}','${id(70)}','fixed_price','progress');
 create table contracts(id uuid,org_id uuid,project_id uuid,status text,parent_contract_id uuid,effective_date date,contract_type text);insert into contracts values('${id(601)}','${org}','${id(70)}','active',null,'2026-01-01','fixed_price');
 create table invoice_lines(id uuid,org_id uuid,invoice_id uuid,quantity numeric,unit_price_cents bigint,cost_code_id uuid,metadata jsonb);insert into invoice_lines values('${id(602)}','${org}','${id(100)}',1,11000,null,'{}'),('${id(603)}','${org}','${id(100)}',1,-2000,null,'{"system_generated_kind":"retainage_hold"}');
 create table retainage(id uuid,org_id uuid,project_id uuid,invoice_id uuid,release_invoice_id uuid,amount_cents bigint);insert into retainage values('${id(604)}','${org}','${id(70)}','${id(100)}',null,2000);
 create table closings(id uuid,org_id uuid,project_id uuid,closing_invoice_id uuid,status text,actual_date date,settlement jsonb);`);
  await f.db.exec(
    fs.readFileSync(
      "supabase/migrations/20261005021730_books_native_invoice_economic_context.sql",
      "utf8",
    ),
  );
  await f.db.exec(
    fs.readFileSync(
      "supabase/migrations/20261005120313_books_native_invoice_exact_quantity_transport.sql",
      "utf8",
    ),
  );
  const economic = (v = {}) =>
    f.rpc("read_books_native_invoice_economic_context", [
      v.org ?? org,
      v.project ?? id(70),
      "invoice",
      v.source ?? id(100),
      v.actor ?? maker,
      v.date ?? "2026-04-15",
    ]);
  return { ...f, economic };
}
module.exports = { setup, id, org, entity, maker, reviewer, notes };
