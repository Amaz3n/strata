-- Design studio capacity, and buyer approvals that bind what was sent.
--
-- EP06-01. A selections appointment was a free-text location and a time. Two
-- coordinators could book the same consultant into the same hour, a studio
-- with two rooms could hold five sessions at once, and moving an appointment
-- told nobody. Now:
--
-- 1. design_studio_locations / design_studio_rooms / design_studio_consultant_hours.
--    A studio is a place with a time zone; its capacity is its active rooms;
--    a consultant (an active member holding design_studio.manage) works the
--    hours written for them at a studio, read in that studio's zone.
-- 2. design_studio_appointments gains the studio, the room, its end, a
--    revision and cancellation. Three exclusion constraints make the calendar
--    the fence: a consultant is never in two sessions at once, a room never
--    holds two, and a home never has two. The window is half-open, so a
--    session ending at 12:00 and the next starting at 12:00 are back to back.
--    Finished and canceled sessions no longer hold their window. A session is
--    inside the consultant's hours at that studio and before the cutoff of
--    every open group it covers -- moving it never moves a deadline, and it
--    may not move past one.
-- 3. Every booking, move and cancellation queues one buyer notice
--    (send_design_studio_appointment_notice), in the same transaction as the
--    write, keyed by the appointment's revision.
--
-- EP06-02. A buyer's approval confirmed whatever was selected when the
-- signature landed, so an option changed between sending and signing was
-- confirmed as if it had been signed. Now:
--
-- 4. selection_approvals / selection_approval_lines: one request to approve one
--    group's selections (or a home's ungrouped ones), frozen at the moment it
--    is sent -- every selection's option, package, their revisions and the
--    snapshot price -- with the sha256 of those terms. Channels: esign (a
--    generated document the buyer signs), portal (the buyer confirms in the
--    portal, bound to the terms hash the page showed), in_person (a
--    coordinator records a signed paper copy filed on the home). Stored
--    states: sent, approved, declined, expired, voided. "Unsigned" is the
--    absence of a live or decided request, and a voided one.
-- 5. A change to a group's selections after it was sent voids the request (and
--    its envelope) in the same transaction. Approving re-reads the terms under
--    the home's selection lock and confirms each selection at the price that
--    was sent; the signature's time decides expiry, so a signature made before
--    the cutoff lands even when the group locked before the job ran.
-- 6. The e-sign envelope's decline, void and expiry reach the approval through
--    a trigger, so every path that ends an envelope -- the signing link's
--    decline, the builder's void, the expiry cron -- leaves the approval
--    declined, voided or expired, never "sent" forever.
-- 7. Envelopes and documents gain the source type selection_approval; only
--    the trusted publication path may create one.
-- 8. Existing e-signed selections become approved esign approvals.
-- 9. A signature request on a single selection (source 'selection', a PDF
--    uploaded by hand) binds no terms and no longer confirms anything when
--    signed. Every one still out is voided with its reason, and whoever sent
--    it is told in the app to send the group from the design studio. No new
--    one can be created; executed ones stay as history.
--
-- Data API: appointments, approvals and their lines are written only by the
-- service role and the definer functions here; a signed-in member reads them
-- with selections.read and writes nothing. Studios, rooms and hours are
-- written by design_studio.manage holders.
--
-- RBAC: no new keys. design_studio.manage covers booking and studio setup;
-- selections.write covers sending, voiding and recording approvals.
--
-- The free-text design_studio_appointments.location column is dropped by
-- supabase/pending-migrations/20261013100001_drop_design_studio_appointment_location.sql.

set local lock_timeout = '3s';

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- 0. Who holds a permission.
-- ---------------------------------------------------------------------------

-- An active member of the org holding the permission through their role or a
-- grant, and not denied it.
create or replace function public.member_holds_org_permission(p_org_id uuid, p_user_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.org_id = p_org_id
      and m.user_id = p_user_id
      and m.status = 'active'
      and (
        exists (select 1 from public.role_permissions rp where rp.role_id = m.role_id and rp.permission_key in (p_permission, '*'))
        or exists (
          select 1 from public.membership_permission_overrides o
          where o.membership_id = m.id and o.permission_key = p_permission and o.effect = 'grant'
        )
      )
      and not exists (
        select 1 from public.membership_permission_overrides o
        where o.membership_id = m.id and o.permission_key = p_permission and o.effect = 'deny'
      )
  )
$$;

revoke all on function public.member_holds_org_permission(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.member_holds_org_permission(uuid, uuid, text) to service_role;

-- Members who hold the permission AND reach the home: their division scope
-- covers its division and their project scope covers it. Notifications about a
-- home go to these people and nobody else.
create or replace function public.project_permission_holders(p_org_id uuid, p_project_id uuid, p_permission text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id
  from public.memberships m
  join public.projects p on p.id = p_project_id and p.org_id = p_org_id
  where m.org_id = p_org_id
    and public.member_holds_org_permission(p_org_id, m.user_id, p_permission)
    and (
      m.division_scope = 'all'
      or public.membership_is_org_admin(m.id, m.role_id)
      or (p.division_id is not null and exists (
        select 1 from public.membership_divisions md where md.membership_id = m.id and md.division_id = p.division_id
      ))
    )
    and (
      m.project_scope is distinct from 'assigned'
      or public.membership_is_org_admin(m.id, m.role_id)
      or exists (
        select 1 from public.project_members pm
        where pm.org_id = p_org_id and pm.project_id = p_project_id and pm.user_id = m.user_id and pm.status = 'active'
      )
    )
$$;

revoke all on function public.project_permission_holders(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.project_permission_holders(uuid, uuid, text) to service_role;

-- Everyone in the org who holds the permission (the people who can run a
-- design studio session, for the studio's hours table).
create or replace function public.org_permission_holders(p_org_id uuid, p_permission text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id
  from public.memberships m
  where m.org_id = p_org_id
    and public.member_holds_org_permission(p_org_id, m.user_id, p_permission)
$$;

revoke all on function public.org_permission_holders(uuid, text) from public, anon, authenticated;
grant execute on function public.org_permission_holders(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 1. Studios, rooms and consultant hours.
-- ---------------------------------------------------------------------------

create table public.design_studio_locations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  division_id uuid references public.divisions(id) on delete set null,
  name text not null check (length(btrim(name)) between 1 and 120),
  address text check (address is null or length(address) <= 500),
  time_zone text not null,
  is_archived boolean not null default false,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index design_studio_locations_name_key on public.design_studio_locations (org_id, lower(name));
create index design_studio_locations_division_idx on public.design_studio_locations (org_id, division_id);
create index design_studio_locations_created_by_idx on public.design_studio_locations (created_by) where created_by is not null;

comment on table public.design_studio_locations is
  'A design studio: where buyers meet a consultant. Its time zone reads consultant hours and appointment times; its active rooms are its capacity.';

create table public.design_studio_rooms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  location_id uuid not null references public.design_studio_locations(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index design_studio_rooms_name_key on public.design_studio_rooms (location_id, lower(name));
create index design_studio_rooms_location_idx on public.design_studio_rooms (org_id, location_id, sort_order);

comment on table public.design_studio_rooms is
  'One room at a studio. A studio can hold as many concurrent sessions as it has active rooms; each session takes one.';

create table public.design_studio_consultant_hours (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references public.app_users(id) on delete cascade,
  location_id uuid not null references public.design_studio_locations(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  start_minute smallint not null check (start_minute between 0 and 1439),
  end_minute smallint not null check (end_minute between 1 and 1440),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint design_studio_consultant_hours_window check (end_minute > start_minute),
  -- A consultant is in one place at a time, whichever studio the hours are at.
  constraint design_studio_consultant_hours_no_overlap exclude using gist (
    org_id with =,
    user_id with =,
    weekday with =,
    int4range(start_minute::integer, end_minute::integer) with &&
  )
);

create index design_studio_consultant_hours_user_idx on public.design_studio_consultant_hours (org_id, user_id);
create index design_studio_consultant_hours_location_idx on public.design_studio_consultant_hours (location_id, weekday);

comment on table public.design_studio_consultant_hours is
  'When a consultant works at a studio: weekday (0 = Sunday) and minutes from local midnight, read in the studio''s time zone.';

-- A consultant's week at one studio is replaced whole: the old windows and the
-- new ones never both stand, and an overlap with their hours elsewhere refuses
-- the lot.
create or replace function public.replace_consultant_hours(p_org_id uuid, p_location_id uuid, p_user_id uuid, p_windows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if jsonb_typeof(p_windows) is distinct from 'array' then
    raise exception 'Hours are a list of windows' using errcode = '22023';
  end if;
  delete from public.design_studio_consultant_hours
  where org_id = p_org_id and location_id = p_location_id and user_id = p_user_id;
  insert into public.design_studio_consultant_hours (org_id, user_id, location_id, weekday, start_minute, end_minute)
  select p_org_id, p_user_id, p_location_id, (w->>'weekday')::smallint, (w->>'startMinute')::smallint, (w->>'endMinute')::smallint
  from jsonb_array_elements(p_windows) w;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.replace_consultant_hours(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.replace_consultant_hours(uuid, uuid, uuid, jsonb) to service_role;

create trigger design_studio_locations_set_updated_at before update on public.design_studio_locations
  for each row execute function public.tg_set_updated_at();
create trigger design_studio_rooms_set_updated_at before update on public.design_studio_rooms
  for each row execute function public.tg_set_updated_at();
create trigger design_studio_consultant_hours_set_updated_at before update on public.design_studio_consultant_hours
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Appointments: studio, room, end, revision, cancellation.
-- ---------------------------------------------------------------------------

alter table public.design_studio_appointments
  add column if not exists location_id uuid references public.design_studio_locations(id),
  add column if not exists room_id uuid references public.design_studio_rooms(id),
  add column if not exists ends_at timestamptz,
  add column if not exists revision integer not null default 1,
  add column if not exists canceled_at timestamptz,
  add column if not exists cancel_reason text,
  add column if not exists booked_by uuid references public.app_users(id) on delete set null;

alter table public.design_studio_appointments
  add constraint design_studio_appointments_revision_check check (revision > 0),
  add constraint design_studio_appointments_cancel_reason_check check (cancel_reason is null or length(cancel_reason) <= 500);

update public.design_studio_appointments
set ends_at = scheduled_at + make_interval(mins => duration_minutes)
where ends_at is null;

alter table public.design_studio_appointments alter column ends_at set not null;

-- Appointments booked before studios existed move into one "Design studio" per
-- org, in the org's zone, with as many rooms as their overlaps need. A legacy
-- double booking of one consultant or one home is a conflict a person has to
-- resolve; the constraints below refuse to build over it.
do $$
declare
  v_org uuid;
  v_location uuid;
  v_room uuid;
  v_rooms uuid[];
  v_candidate uuid;
  v_row record;
begin
  if exists (
    select 1 from public.design_studio_appointments a
    join public.design_studio_appointments b
      on b.org_id = a.org_id and b.id > a.id and b.status = 'scheduled'
     and tstzrange(a.scheduled_at, a.ends_at, '[)') && tstzrange(b.scheduled_at, b.ends_at, '[)')
     and (b.coordinator_user_id = a.coordinator_user_id or b.project_id = a.project_id)
    where a.status = 'scheduled'
  ) then
    raise exception 'Reconcile double-booked design studio appointments (one consultant or one home in two sessions at once) before applying';
  end if;

  for v_org in select distinct org_id from public.design_studio_appointments where location_id is null loop
    insert into public.design_studio_locations (org_id, name, time_zone)
    select o.id, 'Design studio', coalesce(nullif(o.time_zone, ''), 'America/New_York')
    from public.orgs o where o.id = v_org
    returning id into v_location;

    v_rooms := '{}';
    for v_row in
      select id, scheduled_at, ends_at, status
      from public.design_studio_appointments
      where org_id = v_org and location_id is null
      order by scheduled_at, id
    loop
      v_room := null;
      if v_row.status = 'scheduled' then
        foreach v_candidate in array v_rooms loop
          if not exists (
            select 1 from public.design_studio_appointments a
            where a.room_id = v_candidate and a.status = 'scheduled'
              and tstzrange(a.scheduled_at, a.ends_at, '[)') && tstzrange(v_row.scheduled_at, v_row.ends_at, '[)')
          ) then
            v_room := v_candidate;
            exit;
          end if;
        end loop;
        if v_room is null then
          insert into public.design_studio_rooms (org_id, location_id, name, sort_order)
          values (v_org, v_location, 'Room ' || (coalesce(array_length(v_rooms, 1), 0) + 1), coalesce(array_length(v_rooms, 1), 0))
          returning id into v_room;
          v_rooms := v_rooms || v_room;
        end if;
      end if;
      update public.design_studio_appointments set location_id = v_location, room_id = v_room where id = v_row.id;
    end loop;

    if coalesce(array_length(v_rooms, 1), 0) = 0 then
      insert into public.design_studio_rooms (org_id, location_id, name) values (v_org, v_location, 'Room 1');
    end if;
  end loop;
end
$$;

alter table public.design_studio_appointments
  add constraint design_studio_appointments_consultant_free exclude using gist (
    org_id with =,
    coordinator_user_id with =,
    tstzrange(scheduled_at, ends_at, '[)') with &&
  ) where (status = 'scheduled'),
  add constraint design_studio_appointments_room_free exclude using gist (
    room_id with =,
    tstzrange(scheduled_at, ends_at, '[)') with &&
  ) where (status = 'scheduled'),
  add constraint design_studio_appointments_home_free exclude using gist (
    project_id with =,
    tstzrange(scheduled_at, ends_at, '[)') with &&
  ) where (status = 'scheduled');

-- A scheduled session has a consultant, a studio and a room. Legacy sessions
-- booked without a consultant keep their row until they are moved or canceled.
alter table public.design_studio_appointments
  add constraint design_studio_appointments_scheduled_slot check (
    status <> 'scheduled' or (coordinator_user_id is not null and location_id is not null and room_id is not null)
  ) not valid;

do $$
begin
  if not exists (
    select 1 from public.design_studio_appointments
    where status = 'scheduled' and (coordinator_user_id is null or location_id is null or room_id is null)
  ) then
    alter table public.design_studio_appointments validate constraint design_studio_appointments_scheduled_slot;
  end if;
end
$$;

create index design_studio_appointments_location_time_idx on public.design_studio_appointments (org_id, location_id, scheduled_at);
create index design_studio_appointments_consultant_time_idx on public.design_studio_appointments (org_id, coordinator_user_id, scheduled_at);
create index design_studio_appointments_room_idx on public.design_studio_appointments (room_id) where room_id is not null;
create index design_studio_appointments_booked_by_idx on public.design_studio_appointments (booked_by) where booked_by is not null;

-- Every reference stays inside the org; a zone is a real zone.
create or replace function public.tg_design_studio_config_references()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'design_studio_locations' then
    begin
      perform now() at time zone new.time_zone;
    exception when others then
      raise exception '% is not a time zone', new.time_zone using errcode = '22023';
    end;
    if new.division_id is not null and not exists (select 1 from public.divisions d where d.id = new.division_id and d.org_id = new.org_id) then
      raise exception 'The studio''s division belongs to another organization' using errcode = '23514';
    end if;
    if tg_op = 'UPDATE' and new.is_archived and not old.is_archived and exists (
      select 1 from public.design_studio_appointments a
      where a.location_id = new.id and a.status = 'scheduled' and a.ends_at > now()
    ) then
      raise exception 'Move or cancel the sessions booked at % before closing it', old.name using errcode = '23514';
    end if;
    return new;
  end if;
  if tg_table_name = 'design_studio_rooms' then
    if not exists (select 1 from public.design_studio_locations l where l.id = new.location_id and l.org_id = new.org_id) then
      raise exception 'The room''s studio belongs to another organization' using errcode = '23514';
    end if;
    if tg_op = 'UPDATE' and new.location_id is distinct from old.location_id then
      raise exception 'A room stays at its studio' using errcode = '23514';
    end if;
    if tg_op = 'UPDATE' and not new.is_active and old.is_active and exists (
      select 1 from public.design_studio_appointments a
      where a.room_id = new.id and a.status = 'scheduled' and a.ends_at > now()
    ) then
      raise exception 'Move the sessions booked in % before taking it out of service', old.name using errcode = '23514';
    end if;
    return new;
  end if;
  -- design_studio_consultant_hours
  if not exists (select 1 from public.design_studio_locations l where l.id = new.location_id and l.org_id = new.org_id) then
    raise exception 'The studio belongs to another organization' using errcode = '23514';
  end if;
  if (tg_op = 'INSERT' or new.user_id is distinct from old.user_id)
     and not public.member_holds_org_permission(new.org_id, new.user_id, 'design_studio.manage') then
    raise exception 'Hours are written for an active member who runs design studio sessions (design_studio.manage)' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_design_studio_config_references() from public, anon, authenticated;

create trigger design_studio_locations_references
  before insert or update on public.design_studio_locations
  for each row execute function public.tg_design_studio_config_references();
create trigger design_studio_rooms_references
  before insert or update on public.design_studio_rooms
  for each row execute function public.tg_design_studio_config_references();
create trigger design_studio_consultant_hours_references
  before insert or update on public.design_studio_consultant_hours
  for each row execute function public.tg_design_studio_config_references();

-- The session's end, revision and cancellation stamp, and every rule a
-- scheduled session must meet when its slot is written.
create or replace function public.tg_design_studio_appointment_slot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_location public.design_studio_locations;
  v_room public.design_studio_rooms;
  v_slot_changed boolean;
  v_local_start timestamp;
  v_local_end timestamp;
  v_start_minute integer;
  v_end_minute integer;
  v_cutoff date;
begin
  new.ends_at := new.scheduled_at + make_interval(mins => new.duration_minutes);
  if tg_op = 'INSERT' then
    if new.status <> 'scheduled' then
      raise exception 'An appointment is booked as scheduled' using errcode = '23514';
    end if;
    new.revision := 1;
    new.canceled_at := null;
    v_slot_changed := true;
  else
    if (new.org_id, new.project_id) is distinct from (old.org_id, old.project_id) then
      raise exception 'An appointment stays with its home' using errcode = '23514';
    end if;
    v_slot_changed := row(new.scheduled_at, new.duration_minutes, new.location_id, new.room_id, new.coordinator_user_id)
      is distinct from row(old.scheduled_at, old.duration_minutes, old.location_id, old.room_id, old.coordinator_user_id);
    if old.status <> 'scheduled' and (v_slot_changed or new.status is distinct from old.status or new.group_ids is distinct from old.group_ids) then
      raise exception 'A % appointment is a record; book a new session instead', replace(old.status, '_', ' ') using errcode = '23514';
    end if;
    new.revision := case when v_slot_changed then old.revision + 1 else old.revision end;
    if new.status = 'canceled' and old.status <> 'canceled' then
      new.canceled_at := now();
    else
      new.canceled_at := old.canceled_at;
    end if;
  end if;

  if new.status <> 'scheduled' or not (v_slot_changed or (tg_op = 'UPDATE' and new.group_ids is distinct from old.group_ids)) then
    return new;
  end if;

  select * into v_location from public.design_studio_locations where id = new.location_id and org_id = new.org_id;
  if not found then
    raise exception 'Choose a design studio for this session' using errcode = '23514', detail = 'DESIGN_STUDIO_LOCATION';
  end if;
  if v_location.is_archived then
    raise exception '% is closed; choose another studio', v_location.name using errcode = '23514', detail = 'DESIGN_STUDIO_LOCATION';
  end if;
  select * into v_room from public.design_studio_rooms where id = new.room_id and org_id = new.org_id and location_id = new.location_id;
  if not found or not v_room.is_active then
    raise exception 'That room is not in service at %', v_location.name using errcode = '23514', detail = 'DESIGN_STUDIO_ROOM';
  end if;
  if new.coordinator_user_id is null or not public.member_holds_org_permission(new.org_id, new.coordinator_user_id, 'design_studio.manage') then
    raise exception 'The consultant must be an active member who runs design studio sessions' using errcode = '23514', detail = 'DESIGN_STUDIO_CONSULTANT';
  end if;

  v_local_start := new.scheduled_at at time zone v_location.time_zone;
  v_local_end := new.ends_at at time zone v_location.time_zone;
  v_start_minute := extract(hour from v_local_start)::integer * 60 + extract(minute from v_local_start)::integer;
  v_end_minute := (extract(epoch from (v_local_end - date_trunc('day', v_local_start))) / 60)::integer;
  if not exists (
    select 1 from public.design_studio_consultant_hours h
    where h.org_id = new.org_id
      and h.user_id = new.coordinator_user_id
      and h.location_id = new.location_id
      and h.weekday = extract(dow from v_local_start)::integer
      and h.start_minute <= v_start_minute
      and h.end_minute >= v_end_minute
  ) then
    raise exception 'The consultant does not work at % at that time', v_location.name using errcode = '23514', detail = 'DESIGN_STUDIO_OUTSIDE_HOURS';
  end if;

  if exists (
    select 1 from unnest(new.group_ids) as covered(group_id)
    where not exists (
      select 1 from public.project_selection_groups psg
      where psg.org_id = new.org_id and psg.project_id = new.project_id and psg.group_id = covered.group_id
    )
  ) then
    raise exception 'A session covers only this home''s selection groups' using errcode = '23514', detail = 'DESIGN_STUDIO_GROUPS';
  end if;
  select min(psg.cutoff_date) into v_cutoff
  from public.project_selection_groups psg
  where psg.org_id = new.org_id and psg.project_id = new.project_id and psg.group_id = any (new.group_ids)
    and psg.status = 'open' and psg.cutoff_date is not null;
  if v_cutoff is not null and v_local_start::date > v_cutoff then
    raise exception 'That session would fall after the % selection cutoff; the cutoff does not move with the appointment', to_char(v_cutoff, 'Mon FMDD')
      using errcode = '23514', detail = 'DESIGN_STUDIO_AFTER_CUTOFF';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_design_studio_appointment_slot() from public, anon, authenticated;

drop trigger if exists design_studio_appointments_slot on public.design_studio_appointments;
create trigger design_studio_appointments_slot
  before insert or update on public.design_studio_appointments
  for each row execute function public.tg_design_studio_appointment_slot();

-- One buyer notice per booking, move and cancellation, queued with the write.
create or replace function public.tg_design_studio_appointment_notice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_previous jsonb;
begin
  if tg_op = 'INSERT' then
    v_kind := 'booked';
  elsif new.status = 'canceled' and old.status <> 'canceled' then
    v_kind := 'canceled';
  elsif new.status = 'scheduled' and new.revision <> old.revision then
    v_kind := 'rescheduled';
    v_previous := jsonb_build_object('scheduled_at', old.scheduled_at, 'ends_at', old.ends_at, 'location_id', old.location_id, 'coordinator_user_id', old.coordinator_user_id);
  else
    return null;
  end if;
  insert into public.outbox (org_id, job_type, payload, dedupe_key)
  values (
    new.org_id,
    'send_design_studio_appointment_notice',
    jsonb_build_object('appointment_id', new.id, 'revision', new.revision, 'kind', v_kind, 'previous', v_previous),
    'design-studio-notice:' || new.id::text || ':' || new.revision::text || ':' || v_kind
  )
  on conflict (org_id, dedupe_key) where status = 'pending' and dedupe_key is not null do nothing;
  return null;
end;
$$;

revoke all on function public.tg_design_studio_appointment_notice() from public, anon, authenticated;

drop trigger if exists design_studio_appointments_notice on public.design_studio_appointments;
create trigger design_studio_appointments_notice
  after insert or update on public.design_studio_appointments
  for each row execute function public.tg_design_studio_appointment_notice();

-- ---------------------------------------------------------------------------
-- 3. Row security for the studio.
-- ---------------------------------------------------------------------------

-- Named to fire before the slot trigger, so a member hears why the write is
-- not theirs to make.
create or replace function public.tg_design_studio_appointments_member_write_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  raise exception 'Design studio sessions are booked, moved and canceled from the design studio' using errcode = '42501';
end;
$$;

revoke all on function public.tg_design_studio_appointments_member_write_guard() from public, anon, authenticated;

drop trigger if exists design_studio_appointments_member_write_guard on public.design_studio_appointments;
create trigger design_studio_appointments_member_write_guard
  before insert or update or delete on public.design_studio_appointments
  for each row execute function public.tg_design_studio_appointments_member_write_guard();

drop policy if exists design_studio_appointments_org_access on public.design_studio_appointments;
drop policy if exists design_studio_appointments_read on public.design_studio_appointments;
create policy design_studio_appointments_read on public.design_studio_appointments
  for select
  to authenticated
  using (public.has_org_permission(org_id, 'selections.read'));

revoke insert, update, delete on table public.design_studio_appointments from anon, authenticated;
grant select on table public.design_studio_appointments to authenticated;

create or replace function public.tg_design_studio_config_member_write_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  if not public.has_org_permission(coalesce(new.org_id, old.org_id), 'design_studio.manage') then
    raise exception 'Setting up studios, rooms and consultant hours needs design_studio.manage' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public.tg_design_studio_config_member_write_guard() from public, anon, authenticated;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['design_studio_locations', 'design_studio_rooms', 'design_studio_consultant_hours'] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('drop trigger if exists %I on public.%I', v_table || '_member_write_guard', v_table);
    execute format(
      'create trigger %I before insert or update or delete on public.%I for each row execute function public.tg_design_studio_config_member_write_guard()',
      v_table || '_member_write_guard', v_table
    );
    execute format('drop policy if exists %I on public.%I', v_table || '_read', v_table);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.has_org_permission(org_id, ''selections.read''))',
      v_table || '_read', v_table
    );
    execute format('drop policy if exists %I on public.%I', v_table || '_manage', v_table);
    execute format(
      'create policy %I on public.%I for all to authenticated using (public.has_org_permission(org_id, ''design_studio.manage'')) with check (public.has_org_permission(org_id, ''design_studio.manage''))',
      v_table || '_manage', v_table
    );
    execute format('revoke all on table public.%I from anon, authenticated', v_table);
    execute format('grant select, insert, update, delete on table public.%I to authenticated', v_table);
    execute format('grant all on table public.%I to service_role', v_table);
  end loop;
end
$$;

-- The division wall: a studio assigned to a division is that division's.
drop policy if exists design_studio_locations_division_scope on public.design_studio_locations;
create policy design_studio_locations_division_scope on public.design_studio_locations
  as restrictive
  for all
  to authenticated
  using (
    division_id is null
    or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or division_id in (select public.member_reachable_division_ids())
  )
  with check (
    division_id is null
    or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or division_id in (select public.member_reachable_division_ids())
  );

-- ---------------------------------------------------------------------------
-- 4. Buyer approvals.
-- ---------------------------------------------------------------------------

create table public.selection_approvals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  -- Null: the home's ungrouped selections (a custom home's selection list).
  group_id uuid references public.selection_groups(id),
  channel text not null check (channel in ('esign', 'portal', 'in_person')),
  status text not null check (status in ('sent', 'approved', 'declined', 'expired', 'voided')),
  terms_hash text not null check (terms_hash ~ '^[0-9a-f]{64}$'),
  total_cents bigint not null,
  expires_at timestamptz,
  envelope_id uuid references public.envelopes(id),
  document_id uuid references public.documents(id),
  executed_file_id uuid references public.files(id),
  signed_copy_file_id uuid references public.files(id),
  sent_by uuid references public.app_users(id) on delete set null,
  sent_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by_contact_id uuid references public.contacts(id) on delete set null,
  approved_by_user_id uuid references public.app_users(id) on delete set null,
  signer_name text,
  signer_email text,
  signer_ip text,
  declined_at timestamptz,
  declined_by_contact_id uuid references public.contacts(id) on delete set null,
  decline_reason text check (decline_reason is null or length(decline_reason) <= 1000),
  expired_at timestamptz,
  voided_at timestamptz,
  voided_by uuid references public.app_users(id) on delete set null,
  void_reason text check (void_reason is null or length(void_reason) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint selection_approvals_approved_evidence check (status <> 'approved' or approved_at is not null),
  constraint selection_approvals_in_person_evidence check (
    channel <> 'in_person' or status <> 'approved' or (signed_copy_file_id is not null and approved_by_user_id is not null)
  ),
  constraint selection_approvals_portal_evidence check (
    channel <> 'portal' or status <> 'approved' or approved_by_contact_id is not null
  )
);

comment on table public.selection_approvals is
  'A request for the buyer to approve one group''s selections exactly as they stood when it was sent (terms_hash over every selection''s option, package, their revisions and snapshot price). Written only by the definer functions in 20261013100000.';

-- One live request per group.
create unique index selection_approvals_one_sent_key on public.selection_approvals
  (org_id, project_id, coalesce(group_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status = 'sent';
create index selection_approvals_home_idx on public.selection_approvals (org_id, project_id, group_id, sent_at desc);
create index selection_approvals_expiry_idx on public.selection_approvals (expires_at) where status = 'sent' and expires_at is not null;
create index selection_approvals_envelope_idx on public.selection_approvals (envelope_id) where envelope_id is not null;
create index selection_approvals_document_idx on public.selection_approvals (document_id) where document_id is not null;
create index selection_approvals_executed_file_idx on public.selection_approvals (executed_file_id) where executed_file_id is not null;
create index selection_approvals_signed_copy_idx on public.selection_approvals (signed_copy_file_id) where signed_copy_file_id is not null;
create index selection_approvals_group_idx on public.selection_approvals (group_id) where group_id is not null;

create table public.selection_approval_lines (
  approval_id uuid not null references public.selection_approvals(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  selection_id uuid not null references public.project_selections(id),
  category_id uuid not null,
  category_name text not null,
  option_id uuid,
  option_revision integer,
  option_name text,
  package_id uuid,
  package_revision integer,
  package_name text,
  price_cents integer not null,
  cost_cents integer,
  primary key (approval_id, selection_id)
);

comment on table public.selection_approval_lines is
  'What the buyer was asked to approve, one row per selection, frozen when the request was sent. The signing document and the confirmation are read from here, never from the live selections.';

create index selection_approval_lines_selection_idx on public.selection_approval_lines (org_id, selection_id);
create index selection_approval_lines_project_idx on public.selection_approval_lines (org_id, project_id);

create trigger selection_approvals_set_updated_at before update on public.selection_approvals
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- Selections e-signed before approvals existed become approved esign
-- approvals of the one selection each envelope carried. Written before the
-- triggers below exist, so the backfill queues no notifications.
-- ---------------------------------------------------------------------------

do $$
declare
  v_row record;
  v_approval uuid;
  v_approved_at timestamptz;
begin
  for v_row in
    select s.*, c.name as category_name, o.name as option_name, pk.name as package_name,
      e.id as envelope_ref, d.id as document_ref, f.id as file_ref
    from public.project_selections s
    left join public.selection_categories c on c.id = s.category_id
    left join public.selection_options o on o.id = s.selected_option_id
    left join public.selection_packages pk on pk.id = s.package_id
    left join public.envelopes e on e.org_id = s.org_id and e.id::text = s.metadata->>'approved_envelope_id'
    left join public.documents d on d.org_id = s.org_id and d.id::text = s.metadata->>'approved_document_id'
    left join public.files f on f.org_id = s.org_id and f.id::text = s.metadata->>'approved_executed_file_id'
    where s.metadata->>'approved_via_envelope' = 'true'
      and s.status in ('confirmed', 'ordered', 'received')
      and s.price_cents_snapshot is not null
  loop
    v_approved_at := coalesce(
      case when v_row.metadata->>'approved_at' ~ '^\d{4}-\d{2}-\d{2}' then (v_row.metadata->>'approved_at')::timestamptz end,
      v_row.confirmed_at,
      v_row.updated_at
    );
    insert into public.selection_approvals (
      org_id, project_id, group_id, channel, status, terms_hash, total_cents, envelope_id, document_id, executed_file_id,
      sent_at, approved_at, signer_name, signer_email, signer_ip
    ) values (
      v_row.org_id, v_row.project_id, v_row.group_id, 'esign', 'approved',
      encode(sha256(convert_to(jsonb_build_array(jsonb_build_array(v_row.id, v_row.selected_option_id, v_row.selected_option_revision,
        v_row.package_id, v_row.selected_package_revision, v_row.price_cents_snapshot))::text, 'UTF8')), 'hex'),
      v_row.price_cents_snapshot, v_row.envelope_ref, v_row.document_ref, v_row.file_ref,
      v_approved_at, v_approved_at, v_row.metadata->>'approved_signer_name', v_row.metadata->>'approved_signer_email', v_row.metadata->>'approved_signer_ip'
    ) returning id into v_approval;
    insert into public.selection_approval_lines (
      approval_id, org_id, project_id, selection_id, category_id, category_name, option_id, option_revision, option_name,
      package_id, package_revision, package_name, price_cents, cost_cents
    ) values (
      v_approval, v_row.org_id, v_row.project_id, v_row.id, v_row.category_id, coalesce(v_row.category_name, 'Selection'),
      v_row.selected_option_id, v_row.selected_option_revision, v_row.option_name,
      v_row.package_id, v_row.selected_package_revision, v_row.package_name, v_row.price_cents_snapshot, v_row.cost_cents_snapshot
    );
  end loop;
end
$$;

-- 9. Signature requests on a single selection are retired.
do $$
declare
  v_envelope record;
  v_reason constant text := 'Selections are now approved by sending the whole group from the design studio; this request no longer confirms anything.';
begin
  for v_envelope in
    select e.id, e.org_id, e.project_id, e.created_by
    from public.envelopes e
    where e.source_entity_type = 'selection' and e.status in ('draft', 'sent', 'partially_signed')
    order by e.org_id, e.id
  loop
    perform public.cancel_esign_envelope(v_envelope.org_id, v_envelope.id, v_reason, null, null);
    if v_envelope.created_by is not null and exists (
      select 1 from public.memberships m where m.org_id = v_envelope.org_id and m.user_id = v_envelope.created_by and m.status = 'active'
    ) then
      insert into public.notifications (org_id, user_id, notification_type, payload)
      values (v_envelope.org_id, v_envelope.created_by, 'selection_signature_withdrawn', jsonb_build_object(
        'title', 'Selection signature request withdrawn',
        'message', v_reason,
        'project_id', v_envelope.project_id,
        'entity_type', 'envelope',
        'entity_id', v_envelope.id,
        'href', case when v_envelope.project_id is null then '/design-studio' else '/design-studio/sheet/' || v_envelope.project_id::text end
      ));
    end if;
  end loop;
end
$$;

create or replace function public.tg_envelope_selection_source_retired()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Selections are signed by sending the group for approval from the design studio' using errcode = '42501';
end;
$$;

revoke all on function public.tg_envelope_selection_source_retired() from public, anon, authenticated;

drop trigger if exists envelopes_selection_source_retired on public.envelopes;
create trigger envelopes_selection_source_retired
  before insert on public.envelopes
  for each row when (new.source_entity_type = 'selection')
  execute function public.tg_envelope_selection_source_retired();

-- The home's zone: its community's, else the org's.
create or replace function public.selection_home_time_zone(p_org_id uuid, p_project_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select nullif(c.time_zone, '')
       from public.lots l
       join public.communities c on c.id = l.community_id and c.org_id = l.org_id
      where l.org_id = p_org_id and l.project_id = p_project_id
      order by l.id
      limit 1),
    (select nullif(o.time_zone, '') from public.orgs o where o.id = p_org_id),
    'America/New_York'
  )
$$;

revoke all on function public.selection_home_time_zone(uuid, uuid) from public, anon, authenticated;
grant execute on function public.selection_home_time_zone(uuid, uuid) to service_role;

-- The buyer who signs: the lot's reservation buyer, else the project's client.
create or replace function public.selection_home_buyer(p_org_id uuid, p_project_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select r.buyer_contact_id
       from public.lot_reservations r
       join public.lots l on l.id = r.lot_id and l.org_id = r.org_id
      where r.org_id = p_org_id and l.project_id = p_project_id
        and r.status in ('reserved', 'converted') and r.buyer_contact_id is not null
      order by r.created_at desc
      limit 1),
    (select p.client_id from public.projects p where p.id = p_project_id and p.org_id = p_org_id)
  )
$$;

revoke all on function public.selection_home_buyer(uuid, uuid) from public, anon, authenticated;
grant execute on function public.selection_home_buyer(uuid, uuid) to service_role;

-- The ONE canonical reading of a group's terms. Every path that sends, shows,
-- approves or voids compares this hash and nothing else.
create or replace function public.selection_terms(p_org_id uuid, p_project_id uuid, p_group_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with lines as (
    select
      s.id as selection_id,
      s.category_id,
      coalesce(c.name, 'Selection') as category_name,
      s.selected_option_id as option_id,
      s.selected_option_revision as option_revision,
      o.name as option_name,
      s.package_id,
      s.selected_package_revision as package_revision,
      pk.name as package_name,
      s.price_cents_snapshot as price_cents,
      s.cost_cents_snapshot as cost_cents,
      s.status
    from public.project_selections s
    left join public.selection_categories c on c.id = s.category_id
    left join public.selection_options o on o.id = s.selected_option_id
    left join public.selection_packages pk on pk.id = s.package_id
    where s.org_id = p_org_id
      and s.project_id = p_project_id
      and s.group_id is not distinct from p_group_id
  )
  select jsonb_build_object(
    'terms_hash', encode(sha256(convert_to(coalesce(
      jsonb_agg(jsonb_build_array(selection_id, option_id, option_revision, package_id, package_revision, price_cents) order by selection_id)::text,
      '[]'), 'UTF8')), 'hex'),
    'total_cents', coalesce(sum(price_cents), 0),
    'line_count', count(*),
    'complete', count(*) > 0 and coalesce(bool_and(option_id is not null and price_cents is not null), false),
    'confirmed', count(*) > 0 and coalesce(bool_and(status in ('confirmed', 'ordered', 'received')), false),
    'lines', coalesce(jsonb_agg(to_jsonb(lines) order by selection_id), '[]'::jsonb)
  )
  from lines
$$;

revoke all on function public.selection_terms(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.selection_terms(uuid, uuid, uuid) to service_role;

-- Every group on a home (and its ungrouped selections), with its terms.
create or replace function public.selection_home_terms(p_org_id uuid, p_project_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object('group_id', g.group_id) || (public.selection_terms(p_org_id, p_project_id, g.group_id) - 'lines')
    order by g.group_id nulls last), '[]'::jsonb)
  from (
    select distinct s.group_id
    from public.project_selections s
    where s.org_id = p_org_id and s.project_id = p_project_id
  ) g
$$;

revoke all on function public.selection_home_terms(uuid, uuid) from public, anon, authenticated;
grant execute on function public.selection_home_terms(uuid, uuid) to service_role;

-- The end of the cutoff day at the house, or null when the group has none.
create or replace function public.selection_group_deadline(p_org_id uuid, p_project_id uuid, p_group_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select ((psg.cutoff_date + 1)::timestamp at time zone public.selection_home_time_zone(p_org_id, p_project_id))
  from public.project_selection_groups psg
  where psg.org_id = p_org_id and psg.project_id = p_project_id and psg.group_id = p_group_id and psg.cutoff_date is not null
$$;

revoke all on function public.selection_group_deadline(uuid, uuid, uuid) from public, anon, authenticated;

-- Shared refusals before anything is recorded against a set of terms.
create or replace function public.assert_selection_terms_approvable(p_org_id uuid, p_project_id uuid, p_group_id uuid, p_terms_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_terms jsonb := public.selection_terms(p_org_id, p_project_id, p_group_id);
  v_status text;
begin
  if (v_terms->>'line_count')::integer = 0 then
    raise exception 'There are no selections here to approve' using errcode = 'P0002', detail = 'SELECTION_TERMS_EMPTY';
  end if;
  if v_terms->>'terms_hash' is distinct from p_terms_hash then
    raise exception 'These selections changed since they were shown; review them and try again' using errcode = '40001', detail = 'SELECTION_TERMS_CHANGED';
  end if;
  if not (v_terms->>'complete')::boolean then
    raise exception 'Choose an option for every selection before it is approved' using errcode = '23514', detail = 'SELECTION_TERMS_INCOMPLETE';
  end if;
  if (v_terms->>'confirmed')::boolean then
    raise exception 'These selections are already approved; a change now needs a change order' using errcode = '23514', detail = 'SELECTION_ALREADY_APPROVED';
  end if;
  if p_group_id is not null then
    select psg.status into v_status from public.project_selection_groups psg
    where psg.org_id = p_org_id and psg.project_id = p_project_id and psg.group_id = p_group_id;
    if v_status = 'locked' or public.selection_group_deadline(p_org_id, p_project_id, p_group_id) <= now() then
      raise exception 'The deadline for these selections has passed; a change now needs a change order' using errcode = '23514', detail = 'SELECTION_LOCKED_CUTOFF';
    end if;
  end if;
  return v_terms;
end;
$$;

revoke all on function public.assert_selection_terms_approvable(uuid, uuid, uuid, text) from public, anon, authenticated;

create or replace function public.lock_project_selections(p_org_id uuid, p_project_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('project-selections:' || p_org_id::text || ':' || p_project_id::text, 0))
$$;

revoke all on function public.lock_project_selections(uuid, uuid) from public, anon, authenticated;

-- Confirms every selection an approval froze, at the price it froze. The
-- approval is marked approved first, so the void trigger below sees no live
-- request to void while the selections are written.
create or replace function public.confirm_selection_approval(p_approval_id uuid, p_approved_at timestamptz, p_evidence jsonb)
returns public.selection_approvals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approval public.selection_approvals;
begin
  update public.selection_approvals set
    status = 'approved',
    approved_at = p_approved_at,
    approved_by_contact_id = coalesce((p_evidence->>'contact_id')::uuid, approved_by_contact_id),
    approved_by_user_id = coalesce((p_evidence->>'user_id')::uuid, approved_by_user_id),
    executed_file_id = coalesce((p_evidence->>'executed_file_id')::uuid, executed_file_id),
    signed_copy_file_id = coalesce((p_evidence->>'signed_copy_file_id')::uuid, signed_copy_file_id),
    signer_name = coalesce(p_evidence->>'signer_name', signer_name),
    signer_email = coalesce(p_evidence->>'signer_email', signer_email),
    signer_ip = coalesce(p_evidence->>'signer_ip', signer_ip)
  where id = p_approval_id
  returning * into v_approval;

  update public.project_selections s set
    status = 'confirmed',
    confirmed_at = p_approved_at,
    price_cents_snapshot = l.price_cents,
    cost_cents_snapshot = l.cost_cents
  from public.selection_approval_lines l
  where l.approval_id = p_approval_id
    and s.id = l.selection_id
    and s.org_id = v_approval.org_id
    and s.project_id = v_approval.project_id;
  return v_approval;
end;
$$;

revoke all on function public.confirm_selection_approval(uuid, timestamptz, jsonb) from public, anon, authenticated;

create or replace function public.insert_selection_approval(
  p_org_id uuid, p_project_id uuid, p_group_id uuid, p_channel text, p_status text, p_terms jsonb, p_actor_id uuid, p_expires_at timestamptz
)
returns public.selection_approvals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approval public.selection_approvals;
begin
  insert into public.selection_approvals (org_id, project_id, group_id, channel, status, terms_hash, total_cents, expires_at, sent_by)
  values (p_org_id, p_project_id, p_group_id, p_channel, p_status, p_terms->>'terms_hash', (p_terms->>'total_cents')::bigint, p_expires_at, p_actor_id)
  returning * into v_approval;
  insert into public.selection_approval_lines (
    approval_id, org_id, project_id, selection_id, category_id, category_name, option_id, option_revision, option_name,
    package_id, package_revision, package_name, price_cents, cost_cents
  )
  select v_approval.id, p_org_id, p_project_id, (l->>'selection_id')::uuid, (l->>'category_id')::uuid, l->>'category_name',
    (l->>'option_id')::uuid, (l->>'option_revision')::integer, l->>'option_name',
    (l->>'package_id')::uuid, (l->>'package_revision')::integer, l->>'package_name',
    (l->>'price_cents')::integer, (l->>'cost_cents')::integer
  from jsonb_array_elements(p_terms->'lines') l;
  return v_approval;
end;
$$;

revoke all on function public.insert_selection_approval(uuid, uuid, uuid, text, text, jsonb, uuid, timestamptz) from public, anon, authenticated;

-- Send a group's selections for approval: the terms the sender reviewed, or
-- nothing. Expires at the end of the group's cutoff day unless sooner.
create or replace function public.send_selection_approval(
  p_org_id uuid, p_project_id uuid, p_group_id uuid, p_channel text, p_expected_terms_hash text, p_actor_id uuid, p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_terms jsonb;
  v_deadline timestamptz;
  v_expires timestamptz;
begin
  if p_channel not in ('esign', 'portal') then
    raise exception 'Send selections for approval by e-signature or through the buyer portal' using errcode = '22023';
  end if;
  if not exists (select 1 from public.projects where id = p_project_id and org_id = p_org_id) then
    raise exception 'Home not found' using errcode = 'P0002';
  end if;
  perform public.lock_project_selections(p_org_id, p_project_id);
  v_terms := public.assert_selection_terms_approvable(p_org_id, p_project_id, p_group_id, p_expected_terms_hash);
  if exists (
    select 1 from public.selection_approvals a
    where a.org_id = p_org_id and a.project_id = p_project_id and a.group_id is not distinct from p_group_id and a.status = 'sent'
  ) then
    raise exception 'A request to approve these selections is already out; void it before sending another' using errcode = '23505', detail = 'SELECTION_APPROVAL_PENDING';
  end if;
  v_deadline := case when p_group_id is null then null else public.selection_group_deadline(p_org_id, p_project_id, p_group_id) end;
  v_expires := case
    when v_deadline is null then p_expires_at
    when p_expires_at is null then v_deadline
    else least(v_deadline, p_expires_at)
  end;
  if v_expires is not null and v_expires <= now() then
    raise exception 'That request would expire before the buyer could answer it' using errcode = '22023';
  end if;
  return to_jsonb(public.insert_selection_approval(p_org_id, p_project_id, p_group_id, p_channel, 'sent', v_terms, p_actor_id, v_expires));
end;
$$;

revoke all on function public.send_selection_approval(uuid, uuid, uuid, text, text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.send_selection_approval(uuid, uuid, uuid, text, text, uuid, timestamptz) to service_role;

-- The buyer approves in the portal (answering a sent portal request, or on
-- their own), or a coordinator records the buyer's signed paper copy. Either
-- way the hash is the one the approver was looking at.
create or replace function public.approve_selection_terms(
  p_org_id uuid, p_project_id uuid, p_group_id uuid, p_channel text, p_terms_hash text,
  p_contact_id uuid default null, p_user_id uuid default null, p_signed_copy_file_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_terms jsonb;
  v_pending public.selection_approvals;
  v_approval public.selection_approvals;
begin
  if p_channel = 'portal' then
    if p_contact_id is null then
      raise exception 'A portal approval names the buyer who gave it' using errcode = '22023';
    end if;
  elsif p_channel = 'in_person' then
    if p_user_id is null or p_signed_copy_file_id is null then
      raise exception 'An in-person approval needs the buyer''s signed copy filed on the home' using errcode = '22023', detail = 'SELECTION_SIGNED_COPY_REQUIRED';
    end if;
    if not exists (
      select 1 from public.files f
      where f.id = p_signed_copy_file_id and f.org_id = p_org_id and f.project_id = p_project_id and f.archived_at is null
    ) then
      raise exception 'The buyer''s signed copy must be a file on this home' using errcode = '23514', detail = 'SELECTION_SIGNED_COPY_REQUIRED';
    end if;
  else
    raise exception 'E-signed approvals are recorded by the signing document' using errcode = '22023';
  end if;
  if not exists (select 1 from public.projects where id = p_project_id and org_id = p_org_id) then
    raise exception 'Home not found' using errcode = 'P0002';
  end if;
  perform public.lock_project_selections(p_org_id, p_project_id);
  v_terms := public.assert_selection_terms_approvable(p_org_id, p_project_id, p_group_id, p_terms_hash);

  select * into v_pending from public.selection_approvals a
  where a.org_id = p_org_id and a.project_id = p_project_id and a.group_id is not distinct from p_group_id and a.status = 'sent'
  for update;
  if found then
    if v_pending.channel = 'esign' then
      raise exception 'These selections are out for e-signature; sign the document, or void it first' using errcode = '23505', detail = 'SELECTION_APPROVAL_PENDING';
    end if;
    if v_pending.channel <> p_channel then
      raise exception 'A request to approve these selections is already out; void it first' using errcode = '23505', detail = 'SELECTION_APPROVAL_PENDING';
    end if;
    if v_pending.terms_hash is distinct from p_terms_hash then
      raise exception 'These selections changed since they were shown; review them and try again' using errcode = '40001', detail = 'SELECTION_TERMS_CHANGED';
    end if;
    v_approval := v_pending;
  else
    v_approval := public.insert_selection_approval(p_org_id, p_project_id, p_group_id, p_channel, 'sent', v_terms, p_user_id, null);
  end if;

  return to_jsonb(public.confirm_selection_approval(v_approval.id, now(), jsonb_build_object(
    'contact_id', p_contact_id, 'user_id', p_user_id, 'signed_copy_file_id', p_signed_copy_file_id
  )));
end;
$$;

revoke all on function public.approve_selection_terms(uuid, uuid, uuid, text, text, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.approve_selection_terms(uuid, uuid, uuid, text, text, uuid, uuid, uuid) to service_role;

-- The signed envelope approves exactly what it carried. Returns the outcome
-- instead of raising for the ends a retry cannot change (already approved,
-- terms changed, signed late), so the execution job completes.
create or replace function public.approve_selection_approval_from_envelope(
  p_org_id uuid, p_approval_id uuid, p_envelope_id uuid, p_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_approval public.selection_approvals;
  v_signed_at timestamptz;
begin
  select project_id into v_project from public.selection_approvals where id = p_approval_id and org_id = p_org_id;
  if not found then
    raise exception 'Selection approval not found' using errcode = 'P0002';
  end if;
  perform public.lock_project_selections(p_org_id, v_project);
  select * into v_approval from public.selection_approvals where id = p_approval_id and org_id = p_org_id for update;
  if v_approval.channel <> 'esign' or v_approval.envelope_id is distinct from p_envelope_id then
    raise exception 'This signing envelope does not carry that approval' using errcode = '42501';
  end if;
  if v_approval.status = 'approved' then
    return jsonb_build_object('outcome', 'approved', 'idempotent', true, 'project_id', v_approval.project_id, 'group_id', v_approval.group_id);
  end if;
  if v_approval.status <> 'sent' then
    return jsonb_build_object('outcome', v_approval.status, 'project_id', v_approval.project_id, 'group_id', v_approval.group_id);
  end if;
  select max(q.signed_at) into v_signed_at
  from public.document_signing_requests q
  where q.org_id = p_org_id and q.envelope_id = p_envelope_id and q.status = 'signed';
  v_signed_at := coalesce(v_signed_at, now());
  if v_approval.expires_at is not null and v_signed_at > v_approval.expires_at then
    update public.selection_approvals set status = 'expired', expired_at = now() where id = v_approval.id;
    return jsonb_build_object('outcome', 'expired', 'project_id', v_approval.project_id, 'group_id', v_approval.group_id);
  end if;
  if public.selection_terms(p_org_id, v_approval.project_id, v_approval.group_id)->>'terms_hash' is distinct from v_approval.terms_hash then
    update public.selection_approvals
      set status = 'voided', voided_at = now(), void_reason = 'The selections changed after they were sent'
      where id = v_approval.id;
    return jsonb_build_object('outcome', 'voided', 'project_id', v_approval.project_id, 'group_id', v_approval.group_id);
  end if;
  perform public.confirm_selection_approval(v_approval.id, v_signed_at, p_evidence);
  return jsonb_build_object('outcome', 'approved', 'idempotent', false, 'project_id', v_approval.project_id, 'group_id', v_approval.group_id, 'approved_at', v_signed_at);
end;
$$;

revoke all on function public.approve_selection_approval_from_envelope(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.approve_selection_approval_from_envelope(uuid, uuid, uuid, jsonb) to service_role;

create or replace function public.decline_selection_approval(p_org_id uuid, p_approval_id uuid, p_contact_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approval public.selection_approvals;
begin
  update public.selection_approvals
    set status = 'declined', declined_at = now(), declined_by_contact_id = p_contact_id, decline_reason = nullif(btrim(p_reason), '')
    where id = p_approval_id and org_id = p_org_id and status = 'sent' and channel = 'portal'
    returning * into v_approval;
  if not found then
    raise exception 'That request is no longer waiting on you' using errcode = 'P0002';
  end if;
  return to_jsonb(v_approval);
end;
$$;

revoke all on function public.decline_selection_approval(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.decline_selection_approval(uuid, uuid, uuid, text) to service_role;

create or replace function public.void_selection_approval(p_org_id uuid, p_approval_id uuid, p_actor_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approval public.selection_approvals;
begin
  update public.selection_approvals
    set status = 'voided', voided_at = now(), voided_by = p_actor_id, void_reason = coalesce(nullif(btrim(p_reason), ''), 'Withdrawn by the builder')
    where id = p_approval_id and org_id = p_org_id and status = 'sent'
    returning * into v_approval;
  if not found then
    raise exception 'Only a request still waiting on the buyer can be voided' using errcode = 'P0002';
  end if;
  if v_approval.envelope_id is not null and exists (
    select 1 from public.envelopes e where e.id = v_approval.envelope_id and e.status in ('draft', 'sent', 'partially_signed')
  ) then
    perform public.cancel_esign_envelope(p_org_id, v_approval.envelope_id, v_approval.void_reason, null, p_actor_id);
  end if;
  return to_jsonb(v_approval);
end;
$$;

revoke all on function public.void_selection_approval(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.void_selection_approval(uuid, uuid, uuid, text) to service_role;

-- Requests whose deadline passed without an answer. The signing envelope of an
-- e-sign request expires by the same instant in the e-sign sweep.
create or replace function public.expire_selection_approvals(p_limit integer default 500)
returns setof public.selection_approvals
language sql
security definer
set search_path = ''
as $$
  update public.selection_approvals a
    set status = 'expired', expired_at = now()
    where a.id in (
      select id from public.selection_approvals
      where status = 'sent' and expires_at is not null and expires_at <= now()
      order by expires_at
      limit greatest(p_limit, 1)
      for update skip locked
    )
    returning a.*
$$;

revoke all on function public.expire_selection_approvals(integer) from public, anon, authenticated;
grant execute on function public.expire_selection_approvals(integer) to service_role;

-- A change to the selections of a group that is out for approval voids the
-- request -- and its signing envelope -- in the same transaction.
create or replace function public.void_changed_selection_approvals(p_org_id uuid, p_project_id uuid, p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approval public.selection_approvals;
  v_reason constant text := 'The selections changed after they were sent';
begin
  for v_approval in
    select * from public.selection_approvals a
    where a.org_id = p_org_id and a.project_id = p_project_id and a.group_id is not distinct from p_group_id and a.status = 'sent'
    for update
  loop
    if public.selection_terms(p_org_id, p_project_id, p_group_id)->>'terms_hash' is distinct from v_approval.terms_hash then
      update public.selection_approvals set status = 'voided', voided_at = now(), void_reason = v_reason where id = v_approval.id;
      if v_approval.envelope_id is not null and exists (
        select 1 from public.envelopes e where e.id = v_approval.envelope_id and e.status in ('draft', 'sent', 'partially_signed')
      ) then
        perform public.cancel_esign_envelope(p_org_id, v_approval.envelope_id, v_reason, null, null);
      end if;
    end if;
  end loop;
end;
$$;

revoke all on function public.void_changed_selection_approvals(uuid, uuid, uuid) from public, anon, authenticated;

create or replace function public.tg_project_selections_void_sent_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and exists (
    select 1 from public.selection_approvals a where a.org_id = old.org_id and a.project_id = old.project_id and a.status = 'sent'
  ) then
    perform public.void_changed_selection_approvals(old.org_id, old.project_id, old.group_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and exists (
    select 1 from public.selection_approvals a where a.org_id = new.org_id and a.project_id = new.project_id and a.status = 'sent'
  ) and (tg_op = 'INSERT' or (new.org_id, new.project_id, new.group_id) is distinct from (old.org_id, old.project_id, old.group_id)
         or row(new.selected_option_id, new.selected_option_revision, new.package_id, new.selected_package_revision, new.price_cents_snapshot)
            is distinct from row(old.selected_option_id, old.selected_option_revision, old.package_id, old.selected_package_revision, old.price_cents_snapshot)) then
    perform public.void_changed_selection_approvals(new.org_id, new.project_id, new.group_id);
  end if;
  return null;
end;
$$;

revoke all on function public.tg_project_selections_void_sent_approval() from public, anon, authenticated;

-- Owned by EP06-02: later migrations must not drop or replace this trigger.
drop trigger if exists project_selections_void_sent_approval on public.project_selections;
create trigger project_selections_void_sent_approval
  after insert or delete or update of org_id, project_id, group_id, selected_option_id, selected_option_revision, package_id, selected_package_revision, price_cents_snapshot
  on public.project_selections
  for each row execute function public.tg_project_selections_void_sent_approval();

-- An approval's terms are a record; its status moves forward only.
create or replace function public.tg_selection_approval_lifecycle()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    -- The home (or the org) went away and took its approvals with it.
    if pg_trigger_depth() > 1 and (
      not exists (select 1 from public.projects p where p.id = old.project_id)
      or not exists (select 1 from public.orgs o where o.id = old.org_id)
    ) then
      return old;
    end if;
    raise exception 'A selection approval is a record and is never deleted' using errcode = '42501';
  end if;
  if row(new.org_id, new.project_id, new.group_id, new.channel, new.terms_hash, new.total_cents, new.sent_by, new.sent_at, new.expires_at)
     is distinct from row(old.org_id, old.project_id, old.group_id, old.channel, old.terms_hash, old.total_cents, old.sent_by, old.sent_at, old.expires_at) then
    raise exception 'What a buyer was asked to approve never changes; void the request and send the selections again' using errcode = '42501';
  end if;
  if new.status is distinct from old.status
     and not (old.status = 'sent' and new.status in ('approved', 'declined', 'expired', 'voided'))
     and not (old.status = 'approved' and new.status = 'voided') then
    raise exception 'A % selection approval cannot become %', old.status, new.status using errcode = '23514';
  end if;
  if (old.envelope_id is not null and new.envelope_id is distinct from old.envelope_id)
     or (old.document_id is not null and new.document_id is distinct from old.document_id) then
    raise exception 'A selection approval keeps the document it was sent on' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_selection_approval_lifecycle() from public, anon, authenticated;

drop trigger if exists selection_approvals_lifecycle on public.selection_approvals;
create trigger selection_approvals_lifecycle
  before update or delete on public.selection_approvals
  for each row execute function public.tg_selection_approval_lifecycle();

create or replace function public.tg_selection_approval_lines_frozen()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 and (
    not exists (select 1 from public.selection_approvals a where a.id = old.approval_id)
    or not exists (select 1 from public.projects p where p.id = old.project_id)
    or not exists (select 1 from public.orgs o where o.id = old.org_id)
  ) then
    return old;
  end if;
  raise exception 'What a buyer was asked to approve never changes' using errcode = '42501';
end;
$$;

revoke all on function public.tg_selection_approval_lines_frozen() from public, anon, authenticated;

drop trigger if exists selection_approval_lines_frozen on public.selection_approval_lines;
create trigger selection_approval_lines_frozen
  before update or delete on public.selection_approval_lines
  for each row execute function public.tg_selection_approval_lines_frozen();

-- Every status an approval reaches is an event, and the outcomes the people
-- running the home need to hear about are queued for them.
create or replace function public.tg_selection_approval_outcome()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.status = old.status then
    return null;
  end if;
  insert into public.events (org_id, event_type, entity_type, entity_id, payload, channel)
  values (new.org_id, 'selection_approval_' || new.status, 'selection_approval', new.id, jsonb_build_object(
    'project_id', new.project_id, 'group_id', new.group_id, 'channel', new.channel, 'terms_hash', new.terms_hash,
    'total_cents', new.total_cents, 'reason', coalesce(new.decline_reason, new.void_reason)
  ), 'activity');
  if new.status in ('approved', 'declined', 'expired') then
    insert into public.outbox (org_id, job_type, payload, dedupe_key)
    values (new.org_id, 'notify_selection_approval_outcome', jsonb_build_object('approval_id', new.id, 'status', new.status),
      'selection-approval-outcome:' || new.id::text || ':' || new.status)
    on conflict (org_id, dedupe_key) where status = 'pending' and dedupe_key is not null do nothing;
  end if;
  return null;
end;
$$;

revoke all on function public.tg_selection_approval_outcome() from public, anon, authenticated;

drop trigger if exists selection_approvals_outcome on public.selection_approvals;
create trigger selection_approvals_outcome
  after insert or update of status on public.selection_approvals
  for each row execute function public.tg_selection_approval_outcome();

-- A signed-in member writes no approval and no line.
create or replace function public.tg_selection_approvals_member_write_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  raise exception 'Selection approvals are sent and recorded through the selection service' using errcode = '42501';
end;
$$;

revoke all on function public.tg_selection_approvals_member_write_guard() from public, anon, authenticated;

drop trigger if exists selection_approvals_member_write_guard on public.selection_approvals;
create trigger selection_approvals_member_write_guard
  before insert or update or delete on public.selection_approvals
  for each row execute function public.tg_selection_approvals_member_write_guard();
drop trigger if exists selection_approval_lines_member_write_guard on public.selection_approval_lines;
create trigger selection_approval_lines_member_write_guard
  before insert or update or delete on public.selection_approval_lines
  for each row execute function public.tg_selection_approvals_member_write_guard();

alter table public.selection_approvals enable row level security;
alter table public.selection_approval_lines enable row level security;

drop policy if exists selection_approvals_read on public.selection_approvals;
create policy selection_approvals_read on public.selection_approvals
  for select
  to authenticated
  using (public.has_org_permission(org_id, 'selections.read'));

drop policy if exists selection_approvals_division_scope on public.selection_approvals;
create policy selection_approvals_division_scope on public.selection_approvals
  as restrictive
  for all
  to authenticated
  using (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or project_id in (select public.member_reachable_project_ids())
  );

drop policy if exists selection_approval_lines_read on public.selection_approval_lines;
create policy selection_approval_lines_read on public.selection_approval_lines
  for select
  to authenticated
  using (public.has_org_permission(org_id, 'selections.read'));

drop policy if exists selection_approval_lines_division_scope on public.selection_approval_lines;
create policy selection_approval_lines_division_scope on public.selection_approval_lines
  as restrictive
  for all
  to authenticated
  using (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or project_id in (select public.member_reachable_project_ids())
  );

revoke all on table public.selection_approvals from anon, authenticated;
revoke all on table public.selection_approval_lines from anon, authenticated;
grant select on table public.selection_approvals to authenticated;
grant select on table public.selection_approval_lines to authenticated;
grant all on table public.selection_approvals to service_role;
grant all on table public.selection_approval_lines to service_role;

-- ---------------------------------------------------------------------------
-- 5. The signing document an e-sign approval is sent on.
-- ---------------------------------------------------------------------------

alter table public.documents drop constraint if exists documents_source_entity_type_chk;
alter table public.documents add constraint documents_source_entity_type_chk check (
  source_entity_type is null or source_entity_type in (
    'estimate', 'proposal', 'contract', 'change_order', 'lien_waiver', 'selection', 'selection_approval',
    'subcontract', 'subcontract_change_order', 'closeout', 'other'
  )
);
alter table public.envelopes drop constraint if exists envelopes_source_entity_type_check;
alter table public.envelopes add constraint envelopes_source_entity_type_check check (
  source_entity_type is null or source_entity_type in (
    'estimate', 'proposal', 'contract', 'change_order', 'lien_waiver', 'selection', 'selection_approval',
    'subcontract', 'subcontract_change_order', 'closeout', 'other'
  )
);

-- Only the publication below creates a selection approval's document or
-- envelope; a member cannot point a document of their own at an approval.
create or replace function public.tg_selection_approval_signing_source_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
     and (new.source_entity_type = 'selection_approval' or (tg_op = 'UPDATE' and old.source_entity_type = 'selection_approval')) then
    raise exception 'A selection approval''s signing document is generated by the design studio' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_selection_approval_signing_source_guard() from public, anon, authenticated;

drop trigger if exists documents_selection_approval_source_guard on public.documents;
create trigger documents_selection_approval_source_guard
  before insert or update on public.documents
  for each row execute function public.tg_selection_approval_signing_source_guard();
drop trigger if exists envelopes_selection_approval_source_guard on public.envelopes;
create trigger envelopes_selection_approval_source_guard
  before insert or update on public.envelopes
  for each row execute function public.tg_selection_approval_signing_source_guard();

-- Files the generated PDF as the approval's document. Idempotent for a retry
-- with the same file.
create or replace function public.reserve_selection_approval_document(p_org_id uuid, p_approval_id uuid, p_actor_id uuid, p_file_id uuid, p_title text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approval public.selection_approvals;
  v_file public.files;
  v_document uuid;
begin
  select * into v_approval from public.selection_approvals where id = p_approval_id and org_id = p_org_id for update;
  if not found or v_approval.status <> 'sent' or v_approval.channel <> 'esign' then
    raise exception 'Only an e-sign request still waiting on the buyer gets a signing document' using errcode = 'P0002';
  end if;
  if v_approval.document_id is not null then
    if exists (select 1 from public.documents d where d.id = v_approval.document_id and d.source_file_id = p_file_id) then
      return v_approval.document_id;
    end if;
    raise exception 'This request already has its signing document' using errcode = '23505';
  end if;
  select * into v_file from public.files
  where id = p_file_id and org_id = p_org_id and project_id = v_approval.project_id and archived_at is null for share;
  if not found or v_file.mime_type is distinct from 'application/pdf' or v_file.source is distinct from 'generated'
     or v_file.visibility is distinct from 'private' or coalesce(v_file.checksum, '') !~ '^[0-9a-f]{64}$' or coalesce(v_file.size_bytes, 0) <= 0 then
    raise exception 'The signing document must be the generated, private PDF of this request' using errcode = '23514';
  end if;
  insert into public.documents (org_id, project_id, document_type, title, source_file_id, source_entity_type, source_entity_id, created_by, metadata)
  values (p_org_id, v_approval.project_id, 'other', left(coalesce(nullif(btrim(p_title), ''), 'Selections approval'), 200), v_file.id,
    'selection_approval', v_approval.id, p_actor_id,
    jsonb_build_object('selection_approval_id', v_approval.id, 'selection_terms_hash', v_approval.terms_hash))
  returning id into v_document;
  update public.selection_approvals set document_id = v_document where id = v_approval.id;
  return v_document;
end;
$$;

revoke all on function public.reserve_selection_approval_document(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.reserve_selection_approval_document(uuid, uuid, uuid, uuid, text) to service_role;

-- Sends the document to the home's buyer, bound to the approval's terms and
-- expiry.
create or replace function public.publish_selection_approval_document(p_org_id uuid, p_approval_id uuid, p_actor_id uuid, p_source jsonb, p_subject text, p_message text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approval public.selection_approvals;
  v_buyer uuid;
  v_recipient jsonb;
  v_title text;
  v_envelope uuid;
begin
  select * into v_approval from public.selection_approvals where id = p_approval_id and org_id = p_org_id for update;
  if not found or v_approval.status <> 'sent' or v_approval.channel <> 'esign' or v_approval.document_id is null then
    raise exception 'Only an e-sign request still waiting on the buyer can be sent for signature' using errcode = 'P0002';
  end if;
  if v_approval.envelope_id is not null then
    return v_approval.envelope_id;
  end if;
  v_buyer := public.selection_home_buyer(p_org_id, v_approval.project_id);
  select jsonb_build_object('type', 'contact', 'contact_id', c.id, 'user_id', null, 'name', c.full_name, 'email', c.email,
      'role', 'signer', 'signer_role', 'buyer', 'sequence', 1, 'required', true)
    into v_recipient
  from public.contacts c
  where c.id = v_buyer and c.org_id = p_org_id and coalesce(c.email, '') <> '';
  if v_recipient is null then
    raise exception 'The home''s buyer needs an email address before selections can be sent for signature' using errcode = '23514', detail = 'SELECTION_BUYER_EMAIL';
  end if;
  select title into v_title from public.documents where id = v_approval.document_id;
  v_envelope := public.send_esign_document(
    p_org_id, v_approval.document_id, p_actor_id, p_source, jsonb_build_array(v_recipient),
    jsonb_build_object('selection_approval_id', v_approval.id, 'selection_terms_hash', v_approval.terms_hash),
    coalesce(nullif(btrim(p_subject), ''), v_title), p_message, v_approval.expires_at
  );
  update public.selection_approvals set envelope_id = v_envelope where id = v_approval.id;
  return v_envelope;
end;
$$;

revoke all on function public.publish_selection_approval_document(uuid, uuid, uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.publish_selection_approval_document(uuid, uuid, uuid, jsonb, text, text) to service_role;

-- An envelope goes out only for the request whose document it carries.
create or replace function public.tg_envelope_selection_approval_send()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approval public.selection_approvals;
begin
  select * into v_approval from public.selection_approvals where id = new.source_entity_id and org_id = new.org_id;
  if not found or v_approval.status <> 'sent' or v_approval.channel <> 'esign' or v_approval.document_id is distinct from new.document_id then
    raise exception 'This signing document does not carry a request still waiting on the buyer' using errcode = '42501';
  end if;
  new.metadata := coalesce(new.metadata, '{}'::jsonb)
    || jsonb_build_object('selection_approval_id', v_approval.id, 'selection_terms_hash', v_approval.terms_hash);
  return new;
end;
$$;

revoke all on function public.tg_envelope_selection_approval_send() from public, anon, authenticated;

drop trigger if exists envelopes_selection_approval_send on public.envelopes;
create trigger envelopes_selection_approval_send
  before update of status on public.envelopes
  for each row
  when (new.source_entity_type = 'selection_approval' and new.status = 'sent' and old.status = 'draft')
  execute function public.tg_envelope_selection_approval_send();

-- Decline, void and expiry of the envelope reach the approval.
create or replace function public.tg_envelope_selection_approval_outcome()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := nullif(btrim(new.metadata->>'void_reason'), '');
begin
  if new.status = 'expired' then
    update public.selection_approvals set status = 'expired', expired_at = now()
      where id = new.source_entity_id and org_id = new.org_id and envelope_id = new.id and status = 'sent';
  elsif new.metadata->>'declined_by_request_id' is not null then
    update public.selection_approvals set status = 'declined', declined_at = now(), decline_reason = v_reason
      where id = new.source_entity_id and org_id = new.org_id and envelope_id = new.id and status = 'sent';
  else
    update public.selection_approvals set status = 'voided', voided_at = now(), void_reason = coalesce(v_reason, 'The signing request was voided')
      where id = new.source_entity_id and org_id = new.org_id and envelope_id = new.id and status = 'sent';
  end if;
  return null;
end;
$$;

revoke all on function public.tg_envelope_selection_approval_outcome() from public, anon, authenticated;

drop trigger if exists envelopes_selection_approval_outcome on public.envelopes;
create trigger envelopes_selection_approval_outcome
  after update of status on public.envelopes
  for each row
  when (new.source_entity_type = 'selection_approval' and new.status in ('voided', 'expired') and old.status is distinct from new.status)
  execute function public.tg_envelope_selection_approval_outcome();
