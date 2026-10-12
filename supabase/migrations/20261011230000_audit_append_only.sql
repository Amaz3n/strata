-- Audit evidence is append-only.
--
-- `audit_log` (what changed) and `authorization_audit_log` (who was allowed or
-- refused) are the evidence an auditor exports. They are kept for the life of
-- the organization's account: no role may change or remove a row — not the
-- browser roles, not `service_role`, not `postgres` — and neither table can be
-- truncated.
--
-- The one way a row leaves is the organization itself being deleted:
--
--   * `audit_log.org_id` cascades from `orgs`. Inside the cascaded delete the
--     parent row is already gone, so a row whose organization no longer exists
--     may be deleted. The FK guarantees that is never true of a live row.
--   * `authorization_audit_log.org_id` does not cascade, so the platform deletes
--     an organization only through `delete_organization(org)`, which sets the
--     transaction-local `arc.purge_org` to that org (only a row of exactly that
--     organization may be deleted under it) and deletes the evidence and the
--     organization in one transaction: either both go or neither does.
--
-- `authorization_audit_log.project_id` is `on delete set null`: deleting a
-- project nulls the reference, which is the only update allowed — the project
-- column alone, to null, for a project that no longer exists.
--
-- A superuser can still disable a trigger; this guards every application and
-- service path, and makes a deliberate bypass a visible act.

create function public.guard_audit_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  purging text := nullif(current_setting('arc.purge_org', true), '');
  old_row jsonb;
  new_row jsonb;
begin
  if tg_op = 'TRUNCATE' then
    raise exception '% is append-only: audit evidence cannot be truncated', tg_table_name
      using errcode = '42501';
  end if;

  old_row := to_jsonb(old);

  if tg_op = 'DELETE' then
    if old_row ->> 'org_id' is not null and (
      purging = old_row ->> 'org_id'
      or not exists (select 1 from public.orgs o where o.id = (old_row ->> 'org_id')::uuid)
    ) then
      return old;
    end if;
    raise exception '% is append-only: audit evidence cannot be deleted', tg_table_name
      using errcode = '42501',
            hint = 'Audit rows are removed only when their organization is deleted.';
  end if;

  new_row := to_jsonb(new);
  if tg_table_name = 'authorization_audit_log'
    and old_row ->> 'project_id' is not null
    and new_row ->> 'project_id' is null
    and (old_row - 'project_id') = (new_row - 'project_id')
    and not exists (select 1 from public.projects p where p.id = (old_row ->> 'project_id')::uuid)
  then
    return new;
  end if;

  raise exception '% is append-only: audit evidence cannot be changed', tg_table_name
    using errcode = '42501';
end
$$;

revoke all on function public.guard_audit_append_only() from public, anon, authenticated, service_role;

create trigger audit_append_only_guard
  before update or delete on public.audit_log
  for each row execute function public.guard_audit_append_only();

create trigger audit_append_only_truncate_guard
  before truncate on public.audit_log
  for each statement execute function public.guard_audit_append_only();

create trigger audit_append_only_guard
  before update or delete on public.authorization_audit_log
  for each row execute function public.guard_audit_append_only();

create trigger audit_append_only_truncate_guard
  before truncate on public.authorization_audit_log
  for each statement execute function public.guard_audit_append_only();

-- Deleting an organization, in one transaction: its access-decision rows (the
-- one path allowed to remove them), the other rows that do not cascade, and the
-- organization itself, whose cascade removes `audit_log` and everything else.
-- If any step fails nothing is removed, so the evidence never outlives or
-- predeceases its organization.
create function public.delete_organization(p_org uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_org is null then
    raise exception 'An organization is required' using errcode = '22004';
  end if;
  perform set_config('arc.purge_org', p_org::text, true);
  -- Access decisions also reference the impersonation sessions removed next.
  delete from public.authorization_audit_log where org_id = p_org;
  if to_regclass('public.impersonation_sessions') is not null then
    delete from public.impersonation_sessions where org_id = p_org;
  end if;
  if to_regclass('public.closeout_items') is not null then
    delete from public.closeout_items where org_id = p_org;
  end if;
  if to_regclass('public.closeout_packages') is not null then
    delete from public.closeout_packages where org_id = p_org;
  end if;
  if to_regclass('public.decisions') is not null then
    delete from public.decisions where org_id = p_org;
  end if;
  delete from public.orgs where id = p_org;
  if not found then
    raise exception 'Organization not found' using errcode = 'P0002';
  end if;
  perform set_config('arc.purge_org', '', true);
end
$$;

revoke all on function public.delete_organization(uuid) from public, anon, authenticated;
grant execute on function public.delete_organization(uuid) to service_role;

-- The customer export reads one organization's rows in time order, keyset-paged
-- on (time, id).
create index if not exists audit_log_org_created_id_idx
  on public.audit_log (org_id, created_at, id);

create index if not exists authorization_audit_log_org_occurred_id_idx
  on public.authorization_audit_log (org_id, occurred_at, id);
