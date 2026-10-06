-- Task mentions use the same durable notification-email worker and user preferences.
-- The task write, in-app notification, and outbox enqueue commit together.
create or replace function public.queue_task_mentions()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  recipient uuid;
  notification_id uuid;
  prior_ids jsonb := '[]'::jsonb;
  actor uuid := auth.uid();
  actor_name text;
begin
  if tg_op = 'UPDATE' then prior_ids := coalesce(old.metadata->'mentioned_user_ids', '[]'::jsonb); end if;
  if coalesce(new.metadata->'mentioned_user_ids', '[]'::jsonb) = prior_ids then return new; end if;
  select coalesce(full_name, 'A teammate') into actor_name from public.app_users where id = actor;
  for recipient in select distinct value::uuid from jsonb_array_elements_text(coalesce(new.metadata->'mentioned_user_ids', '[]'::jsonb)) loop
    if prior_ids ? recipient::text then continue; end if;
    -- Check the recipient independently of the caller. Never email project content
    -- to an inactive user, another organization, or someone without project access.
    if not exists (
      select 1 from public.memberships m join public.roles r on r.id = m.role_id
      where m.org_id = new.org_id and m.user_id = recipient and m.status = 'active'
        and (new.project_id is null
          or (r.scope = 'org' and r.key in ('org_owner','org_admin','org_office_admin'))
          or exists (select 1 from public.project_members pm where pm.org_id = new.org_id and pm.project_id = new.project_id and pm.user_id = recipient and pm.status = 'active'))
    ) then raise exception 'Mention recipient cannot access this task'; end if;
    if recipient = actor then continue; end if;
    insert into public.notifications(org_id,user_id,notification_type,payload)
      values(new.org_id,recipient,'task_mentioned',jsonb_build_object(
        'title','You were mentioned in a task',
        'message',coalesce(actor_name,'A teammate') || ' mentioned you in “' || new.title || '”.',
        'project_id',new.project_id,'entity_type','task','entity_id',new.id,
        'href','/tasks?task=' || new.id::text)) returning id into notification_id;
    insert into public.outbox(org_id,job_type,payload,dedupe_key)
      values(new.org_id,'deliver_notification',jsonb_build_object('notificationId',notification_id), 'task_mention:' || notification_id::text);
  end loop;
  return new;
end;
$$;
revoke all on function public.queue_task_mentions() from public, anon, authenticated;
create trigger tasks_queue_mentions after insert or update of metadata on public.tasks
  for each row execute function public.queue_task_mentions();

-- Preserve both pieces of existing text where the two former editors diverged.
-- Prospect notes is now the canonical Scope field; no old text is discarded.
update public.prospects p set notes = case
  when nullif(trim(p.notes),'') is null then w.brief->>'scope'
  else p.notes || E'\n\n' || (w.brief->>'scope') end
from public.precon_workspaces w where w.org_id=p.org_id and w.prospect_id=p.id
  and nullif(trim(w.brief->>'scope'),'') is not null
  and coalesce(p.notes,'') is distinct from w.brief->>'scope';
update public.precon_workspaces w set
  brief=jsonb_set(jsonb_set(w.brief,'{scope}',to_jsonb(coalesce(p.notes,''))),'{pricing_revision}',to_jsonb(w.version+1)),
  version=w.version+1
from public.prospects p where p.org_id=w.org_id and p.id=w.prospect_id
  and coalesce(w.brief->>'scope','') is distinct from coalesce(p.notes,'');

create or replace function public.sync_prospect_scope()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and new.notes is not distinct from old.notes then return new; end if;
  if tg_op = 'INSERT' and coalesce(new.notes,'') = '' then return new; end if;
  insert into public.precon_workspaces(org_id,prospect_id,brief,version,updated_by)
    values(new.org_id,new.id,jsonb_build_object('scope',coalesce(new.notes,''),'pricing_revision',1),1,auth.uid())
  on conflict(prospect_id) do update set
    brief=jsonb_set(jsonb_set(precon_workspaces.brief,'{scope}',to_jsonb(coalesce(new.notes,''))),'{pricing_revision}',to_jsonb(precon_workspaces.version+1)),
    version=precon_workspaces.version+1,updated_by=auth.uid()
  where coalesce(precon_workspaces.brief->>'scope','') is distinct from coalesce(new.notes,'');
  return new;
end;
$$;
revoke all on function public.sync_prospect_scope() from public, anon, authenticated;
create trigger prospects_sync_scope after insert or update of notes on public.prospects
  for each row execute function public.sync_prospect_scope();

-- All other brief editors preserve the canonical scope, even stale/legacy clients.
create or replace function public.preserve_prospect_scope()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare canonical_scope text;
begin
  select coalesce(notes,'') into canonical_scope from public.prospects where id=new.prospect_id and org_id=new.org_id;
  if canonical_scope is null then raise exception 'Prospect not found'; end if;
  new.brief := jsonb_set(new.brief,'{scope}',to_jsonb(canonical_scope));
  return new;
end;
$$;
revoke all on function public.preserve_prospect_scope() from public, anon, authenticated;
create trigger precon_preserve_scope before insert or update of brief on public.precon_workspaces
  for each row execute function public.preserve_prospect_scope();
