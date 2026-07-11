-- Additive support for concurrent consultant reviews. Existing workflows retain
-- their sequential behavior because each row starts in its own review group.
alter table public.submittal_review_steps
  add column if not exists review_group integer;

update public.submittal_review_steps
set review_group = step_order
where review_group is null;

alter table public.submittal_review_steps
  alter column review_group set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'submittal_review_steps_review_group_positive'
      and conrelid = 'public.submittal_review_steps'::regclass
  ) then
    alter table public.submittal_review_steps
      add constraint submittal_review_steps_review_group_positive
      check (review_group > 0) not valid;
  end if;
end $$;

alter table public.submittal_review_steps
  validate constraint submittal_review_steps_review_group_positive;

create index if not exists submittal_review_steps_group_idx
  on public.submittal_review_steps (org_id, submittal_id, review_group, status);

comment on column public.submittal_review_steps.review_group is
  'Steps in the same group activate concurrently; the next group waits until all current-group steps return.';
