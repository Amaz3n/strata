-- Arc Books: the journal balance guard could never fire on `journal_entries`.
--
-- `books_assert_journal_balanced` is shared by two constraint triggers —
-- `journal_entries_balanced` and `journal_lines_balanced` — and picked the entry
-- id with a CASE *expression*:
--
--   target_entry_id := case
--     when tg_table_name = 'journal_entries' then coalesce(new.id, old.id)
--     else coalesce(new.entry_id, old.entry_id)
--   end;
--
-- SQL CASE short-circuits when it runs, but PL/pgSQL prepares the whole
-- expression as one statement first, and every field reference in it has to
-- resolve against the actual row type. A `journal_entries` row has no
-- `entry_id`, so firing the trigger raised
--
--   record "new" has no field "entry_id"
--
-- before the balance check ever executed. Because the trigger is DEFERRABLE
-- INITIALLY DEFERRED it failed at COMMIT, taking the whole transaction with it.
--
-- The effect: **no journal entry could ever be posted.** It went unnoticed
-- because `journal_entries` has been empty in every organization since the table
-- was created — no org had `books_settings.workspace_enabled`, so the projector
-- never reached the posting RPC. The first real projection run surfaced it as 11
-- identical failures, one per fact.
--
-- The fix is control flow instead of an expression, so the branch for the other
-- table is never prepared. This is exactly what the sibling function
-- `books_guard_posted_journal` already does, thirty lines above the defect, and
-- what `books_validate_child_org` does across its eight tables. `TG_OP` is tested
-- explicitly rather than leaning on `coalesce(new, old)`: `journal_entries_balanced`
-- fires on INSERT and UPDATE only (so NEW is always assigned), while
-- `journal_lines_balanced` also fires on DELETE, where NEW is not.
--
-- Additive and idempotent: replaces one function body and rebuilds nothing else.
-- No data is touched; the triggers keep their names, timing, and deferrability.

create or replace function public.books_assert_journal_balanced()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  target_entry_id uuid;
  target_status text;
  debit_total bigint;
  credit_total bigint;
  line_count bigint;
begin
  -- Control flow, not a CASE expression: PL/pgSQL only prepares the branch it
  -- takes, so `new.entry_id` is never resolved against a `journal_entries` row.
  if tg_table_name = 'journal_entries' then
    target_entry_id := new.id;
  elsif tg_op = 'DELETE' then
    target_entry_id := old.entry_id;
  else
    target_entry_id := new.entry_id;
  end if;

  select status into target_status from public.journal_entries where id = target_entry_id;
  if target_status is distinct from 'posted' then
    return null;
  end if;

  select coalesce(sum(debit_cents), 0), coalesce(sum(credit_cents), 0), count(*)
  into debit_total, credit_total, line_count
  from public.journal_lines
  where entry_id = target_entry_id;

  if line_count < 2 or debit_total <= 0 or debit_total <> credit_total then
    raise exception 'Posted journal entry % is not balanced', target_entry_id;
  end if;
  return null;
end;
$$;
