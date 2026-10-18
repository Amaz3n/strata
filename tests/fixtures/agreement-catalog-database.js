const { migrationSql } = require("../support/migration-sql")
const tables=['selection_categories','selection_options','selection_packages','selection_package_items','selection_catalog_prices','selection_configuration_rules','house_plans','house_plan_versions','house_plan_elevations','community_plan_availability','incentives','feature_flags','communities']
async function installCatalogRevision(db){
 for(const table of tables){
  const exists=(await db.query('select to_regclass($1) relation',[`public.${table}`])).rows[0].relation
  if(!exists)await db.exec(`create table public.${table}(id uuid primary key default gen_random_uuid(),org_id uuid references public.orgs(id))`)
  else if(!(await db.query("select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name='org_id'",[table])).rows.length)await db.exec(`alter table public.${table} add column org_id uuid references public.orgs(id)`)
 }
 await db.exec("create or replace function public.is_org_member(p_org_id uuid) returns boolean language sql stable as $$ select p_org_id::text=current_setting('test.org_id',true) $$")
 await db.exec(migrationSql("20261004000030_agreement_catalog_revisions"))
}
module.exports={installCatalogRevision,tables}
