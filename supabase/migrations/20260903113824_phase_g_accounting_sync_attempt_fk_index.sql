-- Phase G follow-up: cover the accounting attempt foreign key for deletes and joins.
set lock_timeout = '5s';
set statement_timeout = '120s';

create index if not exists accounting_sync_records_last_attempt_idx
  on public.accounting_sync_records (last_attempt_id)
  where last_attempt_id is not null;
