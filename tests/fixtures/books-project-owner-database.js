const fs = require("node:fs"),
  { createHash } = require("node:crypto");
const supportBytes = Buffer.from("Original project ownership evidence");
const checksum = createHash("sha256").update(supportBytes).digest("hex");
const {
  setup: chartSetup,
  id,
  org,
  entity,
  maker,
  reviewer,
  notes,
} = require("./books-entity-chart-database");
async function setup(t) {
  const f = await chartSetup(t);
  await f.db.exec(
    `create table projects(id uuid primary key,org_id uuid,name text);insert into projects values('${id(70)}','${org}','Builder project'),('${id(71)}','${org}','Other project'),('${id(72)}','${id(9)}','Foreign project');create table accounting_facts(id uuid primary key,org_id uuid,payload jsonb,source_type text,source_id uuid);create table vendor_bills(id uuid primary key,org_id uuid,project_id uuid);create table invoices(id uuid primary key,org_id uuid,project_id uuid);create table project_expenses(id uuid primary key,org_id uuid,project_id uuid);create table payments(id uuid primary key,org_id uuid,invoice_id uuid,bill_id uuid,project_id uuid);create table journal_entries(id uuid primary key,org_id uuid,source_type text,source_id uuid);create table journal_lines(id uuid primary key,org_id uuid,project_id uuid,dimensions jsonb default '{}');create table files(id uuid primary key,org_id uuid,project_id uuid,storage_path text,checksum text,size_bytes bigint);create table doc_versions(id uuid primary key,org_id uuid,file_id uuid,storage_path text,checksum text,size_bytes bigint,file_name text,mime_type text);insert into files values('${id(80)}','${org}',null,'${org}/ownership-original.pdf','${checksum}',${supportBytes.length});insert into doc_versions values('${id(81)}','${org}','${id(80)}','${org}/ownership-original.pdf','${checksum}',${supportBytes.length},'ownership-original.pdf','application/pdf');`,
  );
  await f.db.exec(
    fs.readFileSync(
      "supabase/migrations/20261004231952_books_project_legal_ownership.sql",
      "utf8",
    ),
  );
  await f.db.exec(
    "create table books_legacy_entity_proposals(id uuid primary key,org_id uuid)",
  );
  await f.db.exec(
    fs.readFileSync(
      "supabase/migrations/20261004233548_books_project_owner_archive.sql",
      "utf8",
    ),
  );
  await f.db.exec(
    fs.readFileSync(
      "supabase/migrations/20261005000141_books_project_owner_workflow_reads.sql",
      "utf8",
    ),
  );
  await f.db.exec(
    fs.readFileSync(
      "supabase/migrations/20261005001726_books_project_owner_workspace.sql",
      "utf8",
    ),
  );
  await f.db.exec(
    fs.readFileSync(
      "supabase/migrations/20261005005818_books_project_owner_request_resolutions.sql",
      "utf8",
    ),
  );
  await f.db.exec(
    "alter table doc_versions add column version_number integer default 1, add column created_at timestamptz default now()",
  );
  const decision = {
    single_entity_project_confirmed: true,
    rationale: "Original contract confirms this entity owns this project",
    document_version_ids: [id(81)],
  };
  const prepare = (v = {}) =>
    f.rpc("prepare_books_project_entity", [
      v.org ?? org,
      v.entity ?? entity,
      v.project ?? id(70),
      v.id ?? id(90),
      v.profile ?? id(20),
      v.actor ?? maker,
      v.effective ?? "2026-01-01",
      JSON.stringify(v.decision ?? decision),
      v.notes ?? notes,
    ]);
  const review = (v = {}) =>
    f.rpc("review_books_project_entity", [
      org,
      v.entity ?? entity,
      v.project ?? id(70),
      v.proposal ?? id(90),
      v.id ?? id(91),
      v.actor ?? reviewer,
      v.notes ?? notes,
    ]);
  return { ...f, prepare, review, decision };
}
module.exports = {
  setup,
  id,
  org,
  entity,
  maker,
  reviewer,
  notes,
  supportBytes,
};
