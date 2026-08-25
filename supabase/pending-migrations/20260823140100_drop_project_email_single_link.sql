-- DESTRUCTIVE / PENDING HUMAN APPROVAL
--
-- `project_emails.linked_entity_type` / `linked_entity_id` held at most one link
-- and, in practice, only ever held 'change_event'. Their contents were copied
-- into `project_email_links` by 20260823140000_correspondence_workbench.sql and
-- nothing has read them since that release. Apply once that release is the only
-- one in production.

begin;

do $$
begin
  if exists (
    select 1
    from public.project_emails pe
    where pe.linked_entity_id is not null
      and not exists (
        select 1
        from public.project_email_links pl
        where pl.org_id = pe.org_id
          and pl.project_email_id = pe.id
          and pl.entity_type = pe.linked_entity_type
          and pl.entity_id = pe.linked_entity_id
      )
  ) then
    raise exception 'Legacy project_emails links exist with no row in project_email_links; re-run the backfill before dropping the columns';
  end if;
end $$;

alter table public.project_emails
  drop column linked_entity_type,
  drop column linked_entity_id;

commit;
