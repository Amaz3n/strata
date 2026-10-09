const { migrationSql } = require("../support/migration-sql")
require("../../scripts/register-ts-node-test");
const { scenario } = require("./books-payroll-construction-decisions-fixture"),
  { id, org } = require("./books-payroll-register-fixture");
const migration = migrationSql("20261004055553_books_private_payroll_documents");
async function fixture(t) {
  const f = await scenario(t);
  await f.db.exec(
    "alter table files add metadata jsonb not null default '{}',add visibility text not null default 'private',add share_with_subs boolean not null default false,add share_with_clients boolean not null default false,add uploaded_by uuid default '99400000-0000-4000-8000-000000000050',add project_id uuid,add category text,add source text;alter table doc_versions add version_number integer default 1,add created_by uuid;alter table file_links add file_id uuid;alter table files enable row level security;alter table doc_versions enable row level security;alter table file_links enable row level security;create policy test_file_members on files for all to authenticated using(org_id=current_setting('test.org')::uuid) with check(org_id=current_setting('test.org')::uuid);create policy test_version_members on doc_versions for all to authenticated using(org_id=current_setting('test.org')::uuid) with check(org_id=current_setting('test.org')::uuid);create policy test_link_members on file_links for all to authenticated using(org_id=current_setting('test.org')::uuid) with check(org_id=current_setting('test.org')::uuid);grant select,insert,update,delete on files,doc_versions,file_links to authenticated;grant select,insert,update on files,doc_versions to service_role;grant select on memberships,books_payroll_imports,books_payroll_correction_sources to service_role;alter role service_role bypassrls",
  );
  await f.db.query("select set_config('test.org',$1,false)", [org]);
  await f.db.exec(migration);
  return f;
}
module.exports = { fixture };
