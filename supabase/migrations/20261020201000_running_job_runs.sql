-- Durable running-job monitoring (EP13-05).
--
-- job_runs used to receive one row when a job finished. A runtime that died
-- mid-run (a function timeout, a crash inside `after()`) left nothing behind, so
-- a job that was accepted and died looked exactly like a job that never fired.
--
-- `withCronRun` now writes a `running` row with a deadline when the job starts
-- (its function limit plus grace) and closes that same row with the outcome.
-- A `running` row past its deadline is reconciled to `timed_out` by the next run
-- of the same job and by the hourly watchdog, so the record says which happened:
--
--   no row in the window   -> the scheduler never started it (not started)
--   timed_out               -> it started and its runtime died (accepted, never completed)
--   failed                  -> it ran and reported failure
--
-- `correlation_id` is the run's unit-of-work id (`cron:<job>:<uuid>`), the same
-- value the run's own audit rows and events carry.

alter table public.job_runs drop constraint if exists job_runs_status_check;
alter table public.job_runs
  add constraint job_runs_status_check check (status in ('running', 'success', 'failed', 'timed_out'));

alter table public.job_runs
  add column if not exists deadline_at timestamptz,
  add column if not exists correlation_id text;

alter table public.job_runs drop constraint if exists job_runs_running_has_deadline;
alter table public.job_runs
  add constraint job_runs_running_has_deadline check (status <> 'running' or deadline_at is not null);

create index if not exists job_runs_running_deadline_idx
  on public.job_runs (deadline_at)
  where status = 'running';

comment on column public.job_runs.deadline_at is
  'When a running row stops being believable: the job''s function limit plus grace. A running row past it is reconciled to timed_out.';
comment on column public.job_runs.correlation_id is
  'The run''s unit-of-work id (cron:<job>:<uuid>), shared with the audit rows and events the run wrote.';

-- Service-role only, as before (RLS on, no policies); the grants are made
-- explicit so a browser role cannot even attempt a write.
revoke all on public.job_runs from anon, authenticated;
