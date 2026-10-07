-- Where each company's projection run left off, and when it last completed.
--
-- The 10-minute run used the newest accounting fact as its cursor. A fact is
-- written only when money changes, so every document touched without a money
-- change since then was re-read and re-sent to the database on every run; and a
-- write that committed after a newer one had been projected fell behind the
-- cursor until the nightly pass. The run now saves, per source family, the
-- latest updated_at it actually read, plus when its read began. The next run
-- reads strictly after each cursor, reaching back to five minutes before that
-- start only for writes that were still in flight when it read.
--
-- The completion times order the next run: the company least recently completed
-- goes first, so one that the time budget did not reach is first next time.
-- Written only by the service role through complete_books_projection_run.

create table public.books_projection_progress (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  cursors jsonb not null default '{}'::jsonb check (jsonb_typeof(cursors) = 'object'),
  read_started_at timestamptz,
  incremental_completed_at timestamptz,
  full_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.books_projection_progress enable row level security;
revoke all on table public.books_projection_progress from anon, authenticated;
create trigger books_projection_progress_set_updated_at before update on public.books_projection_progress
for each row execute function public.tg_set_updated_at();

-- Cursors only move forward: a slower concurrent run that read less never pulls
-- one back. A full pass also counts as an ordinary run.
create or replace function public.complete_books_projection_run(p_org_id uuid, p_cursors jsonb, p_full boolean, p_read_started_at timestamptz)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if jsonb_typeof(p_cursors) <> 'object' then raise exception 'Projection cursors must be an object'; end if;
  if p_read_started_at is null then raise exception 'Projection read start is required'; end if;
  insert into public.books_projection_progress as progress (org_id, cursors, read_started_at, incremental_completed_at, full_completed_at)
  values (p_org_id, p_cursors, p_read_started_at, clock_timestamp(), case when p_full then clock_timestamp() end)
  on conflict (org_id) do update set
    cursors = (
      select coalesce(jsonb_object_agg(family, to_jsonb(at)), '{}'::jsonb)
      from (
        select family, max(value::timestamptz) at
        from (
          select key family, value #>> '{}' value from jsonb_each(progress.cursors)
          union all
          select key, value #>> '{}' from jsonb_each(excluded.cursors)
        ) both_cursors
        group by family
      ) merged
    ),
    -- The earlier start of two overlapping runs keeps the wider late-commit window.
    read_started_at = case when progress.incremental_completed_at < p_read_started_at then p_read_started_at else least(progress.read_started_at, p_read_started_at) end,
    incremental_completed_at = clock_timestamp(),
    full_completed_at = case when p_full then clock_timestamp() else progress.full_completed_at end;
end;
$$;
revoke all on function public.complete_books_projection_run(uuid, jsonb, boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.complete_books_projection_run(uuid, jsonb, boolean, timestamptz) to service_role;
