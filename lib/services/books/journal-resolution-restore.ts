import { z } from "zod";
import { verifyBooksExportBundle } from "./export-contract";
import { JOURNAL_RESOLUTION_TABLE } from "./journal-resolution-archive";

const targetSchema = z
  .object({
    instanceId: z.string().uuid(),
    projectId: z.string().regex(/^arc-books-acceptance-[a-z0-9-]+$/),
    migrationManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    database: z.literal("postgres"),
    migrationVersions: z
      .array(z.string().regex(/^\d{14}$/))
      .min(1)
      .refine(
        (v) => new Set(v).size === v.length,
        "Duplicate migration identities",
      ),
  })
  .strict();
// Hex encoding also prevents archived dollar-quote delimiters from escaping DO bodies.
const literal = (value: string) =>
  "convert_from(decode('" +
  Buffer.from(value, "utf8").toString("hex") +
  "','hex'),'UTF8')";
const closureTables = [
  "books_journal_proposals",
  "journal_entries",
  "journal_lines",
  "gl_accounts",
  "accounting_periods",
  "projects",
  "companies",
] as const;

/** Offline administrative SQL only. Never connects to a database or enables an application restore endpoint. */
export function prepareJournalResolutionRestoreSql(
  bundle: Parameters<typeof verifyBooksExportBundle>[0],
  target: z.input<typeof targetSchema>,
) {
  const identity = targetSchema.parse(target);
  const verified = verifyBooksExportBundle(bundle);
  if (
    !bundle.manifest ||
    ![20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32].includes(
      bundle.manifest.schemaVersion,
    ) ||
    !verified.valid
  )
    throw new Error(
      "Journal resolution restoration requires a verified schema20 through schema32 archive",
    );
  const org = z.string().uuid().parse(bundle.manifest.orgId);
  const rows = bundle.tables[JOURNAL_RESOLUTION_TABLE];
  const compare = (table: string, expected: Record<string, unknown>[]) => `
 if (select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from public.${table} r where org_id=${literal(org)}::uuid) is distinct from
 (select coalesce(jsonb_agg(v order by v->>'id'),'[]'::jsonb) from jsonb_array_elements(${literal(JSON.stringify(expected))}::jsonb) v)
 then raise exception 'Restored ${table} differs from retained archive';end if;`;
  return `-- Isolated administrative restoration of exact schema20 journal recovery history.
-- Restore the ordinary accounting tables first. Execute with psql ON_ERROR_STOP.
-- Transactional DDL keeps foreign keys and append-only protections enabled.
begin;
set local standard_conforming_strings=on;
set local lock_timeout='5s';
set local statement_timeout='60s';
lock table books_acceptance.environment in share mode;
do $books_restore_identity$
begin
 if current_database()<>${literal(identity.database)} or current_setting('session_replication_role')<>'origin'
 or (select count(*) from books_acceptance.environment)<>1
 or not exists(select 1 from books_acceptance.environment where instance_id=${literal(identity.instanceId)}::uuid and project_id=${literal(identity.projectId)} and isolated=true and migration_manifest_sha256=${literal(identity.migrationManifestSha256)})
 then raise exception 'Exact isolated restore identity is required';end if;
 if (select coalesce(jsonb_agg(version order by version),'[]'::jsonb) from supabase_migrations.schema_migrations) is distinct from ${literal(JSON.stringify([...identity.migrationVersions].sort()))}::jsonb
 then raise exception 'Installed migration identities differ from the isolated restore target';end if;
 if current_setting('cron.launch_active_jobs',true) is not null and current_setting('cron.launch_active_jobs',true) not in('off','false') then raise exception 'Isolated restore requires scheduled jobs disabled';end if;
end;
$books_restore_identity$;
lock table public.books_journal_request_resolutions in access exclusive mode;
lock table ${closureTables.map((t) => "public." + t).join(",")} in share mode;
do $books_restore_preflight$
begin
 if not exists(select 1 from pg_trigger where tgrelid='public.books_journal_request_resolutions'::regclass and tgname='books_journal_resolution_guard' and tgenabled='O')
 or exists(select 1 from pg_trigger where tgrelid='public.books_journal_request_resolutions'::regclass and tgenabled<>'O')
 then raise exception 'Resolution restoration requires all ordinary guards enabled';end if;
 if exists(select 1 from public.books_journal_request_resolutions where org_id=${literal(org)}::uuid) then raise exception 'Resolution history target must be empty for the archived organization';end if;
 ${closureTables.map((t) => compare(t, bundle.tables[t] ?? [])).join("\n")}
end;
$books_restore_preflight$;
alter table public.books_journal_request_resolutions disable trigger books_journal_resolution_guard;
insert into public.books_journal_request_resolutions
select * from jsonb_populate_recordset(null::public.books_journal_request_resolutions,${literal(JSON.stringify(rows))}::jsonb);
alter table public.books_journal_request_resolutions enable trigger books_journal_resolution_guard;
do $books_restore_verify$
begin
 ${compare(JOURNAL_RESOLUTION_TABLE, rows)}
 if exists(select 1 from pg_trigger where tgrelid='public.books_journal_request_resolutions'::regclass and tgenabled<>'O') then raise exception 'Restore left a disabled resolution guard';end if;
end;
$books_restore_verify$;
set constraints all immediate;
commit;
`;
}
