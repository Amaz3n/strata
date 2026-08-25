-- Every project has an inbound address, always.
--
-- The slug used to be minted by someone pressing "Enable email filing", on the
-- reasoning that a publishable credential should be created deliberately. In
-- practice it was a step with one possible answer in front of a feature nobody
-- can use without it, and it left the address absent on 75 of 76 existing
-- projects.
--
-- So the slug becomes a property of the project, set at insert like a project
-- number. The alternative — minting it lazily when the correspondence page
-- loads — would make a GET write, which also means a reader without
-- `correspondence.write` could not open the page.
--
-- Generation happens in the database rather than in `createProject` because
-- projects are inserted from several paths (the create form, WIP imports, plan
-- instantiation, lot starts, demo seeds); a trigger is the only place that
-- covers all of them.

-- Readable stem plus entropy, matching the address format the app already
-- publishes. The stem makes the address recognizable in a vendor's sent folder;
-- the token keeps it unguessable, because an inbound address is an
-- unauthenticated write into the project's record.
--
-- SECURITY DEFINER because `projects_correspondence_slug_idx` is unique across
-- every org: the collision check has to see rows the caller's RLS policy hides,
-- or two orgs could be handed the same address. It reads one indexed column and
-- returns text; EXECUTE is revoked from every client role below, since only the
-- trigger needs it.
create or replace function public.generate_project_correspondence_slug(project_name text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- No look-alike characters: an address gets read off a screen and typed into
  -- a mail client's forwarding rule.
  alphabet constant text := 'abcdefghijkmnpqrstuvwxyz23456789';
  stem text;
  token text;
  candidate text;
  attempt int;
begin
  stem := regexp_replace(lower(coalesce(project_name, '')), '[^a-z0-9]+', '-', 'g');
  stem := trim(both '-' from stem);
  stem := left(stem, 40);
  stem := regexp_replace(stem, '-+$', '');
  if stem = '' then
    stem := 'project';
  end if;

  for attempt in 1..10 loop
    token := '';
    for _position in 1..10 loop
      token := token || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    candidate := stem || '-' || token;
    if not exists (select 1 from public.projects where correspondence_slug = candidate) then
      return candidate;
    end if;
  end loop;

  raise exception 'Could not reserve a correspondence slug for %', project_name;
end;
$$;

revoke all on function public.generate_project_correspondence_slug(text) from public;
revoke all on function public.generate_project_correspondence_slug(text) from anon;
revoke all on function public.generate_project_correspondence_slug(text) from authenticated;

create or replace function public.tg_project_correspondence_slug()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- An explicit slug is honored, so a restore or a data move can carry its own.
  if new.correspondence_slug is null then
    new.correspondence_slug := public.generate_project_correspondence_slug(new.name);
  end if;
  return new;
end;
$$;

revoke all on function public.tg_project_correspondence_slug() from public;
revoke all on function public.tg_project_correspondence_slug() from anon;
revoke all on function public.tg_project_correspondence_slug() from authenticated;

drop trigger if exists projects_set_correspondence_slug on public.projects;
create trigger projects_set_correspondence_slug
  before insert on public.projects
  for each row execute function public.tg_project_correspondence_slug();

-- Row at a time, not one UPDATE: inside a single statement every call sees the
-- same snapshot, so the collision check could not see slugs the same statement
-- had just written.
do $$
declare
  project record;
begin
  for project in select id, name from public.projects where correspondence_slug is null loop
    update public.projects
    set correspondence_slug = public.generate_project_correspondence_slug(project.name)
    where id = project.id;
  end loop;
end $$;

comment on column public.projects.correspondence_slug is
  'Local part of the project''s inbound mail address (project-<slug>@$PAYABLES_INBOUND_DOMAIN). Set at insert by projects_set_correspondence_slug and unique across every org, because the address space is global.';
