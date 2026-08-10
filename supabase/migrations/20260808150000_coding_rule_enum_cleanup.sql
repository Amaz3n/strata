-- B1 directive 8: retire the coding-rule enum members nothing ever wrote.
--
-- `card_scope` and `email_sender` were declared with the table and never
-- implemented. No code path creates a rule with either kind, and
-- `suggestCodingForService` filtered them out of selection anyway, so a row
-- carrying one could never have been applied to a payable.
--
-- `import` and `seed` are provenance for rule sources that do not exist: there
-- is no rule seeder, and the accounting importer does not learn rules.
-- `learnCodingRule` writes `created_from` once, at insert, and always as
-- `user_correction`, because a user correction is the only thing that creates a
-- coding rule.
--
-- Narrowing the constraints rather than leaving the slots open is what stops a
-- future reader from inferring a feature that was never built. If sender-based
-- coding earns its place later it returns as a real feature with its own
-- migration, plumbing the sender through `suggestCoding` — which is the work
-- this constraint slot was standing in for.
--
-- SAFETY: `public.coding_rules` holds zero rows in production at the time of
-- this migration, so there is nothing to backfill and nothing that can violate
-- the tightened checks. The guards below make that a precondition rather than
-- an assumption: if any row has since appeared using a retired value, this
-- migration aborts instead of failing halfway.

do $$
declare
  offending_kinds integer;
  offending_provenance integer;
begin
  select count(*) into offending_kinds
  from public.coding_rules
  where match_kind not in ('vendor', 'vendor_memo');

  select count(*) into offending_provenance
  from public.coding_rules
  where created_from <> 'user_correction';

  if offending_kinds > 0 then
    raise exception
      'coding_rules holds % row(s) with a retired match_kind; migrate them to vendor/vendor_memo before narrowing the constraint',
      offending_kinds;
  end if;

  if offending_provenance > 0 then
    raise exception
      'coding_rules holds % row(s) with a retired created_from; migrate them to user_correction before narrowing the constraint',
      offending_provenance;
  end if;
end
$$;

alter table public.coding_rules
  drop constraint if exists coding_rules_match_kind_check;

alter table public.coding_rules
  add constraint coding_rules_match_kind_check
  check (match_kind in ('vendor', 'vendor_memo'));

alter table public.coding_rules
  drop constraint if exists coding_rules_created_from_check;

alter table public.coding_rules
  add constraint coding_rules_created_from_check
  check (created_from = 'user_correction');
