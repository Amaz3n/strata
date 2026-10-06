-- Learned bank rules may suggest the Arc vendor selected during a successful
-- single-line post. Existing rules remain valid and simply have no vendor.
alter table public.bank_rules
  add column if not exists vendor_id uuid references public.companies(id) on delete set null;

create index if not exists bank_rules_vendor_idx
  on public.bank_rules (org_id, vendor_id)
  where vendor_id is not null;

-- The existing atomic posting function writes the learned category before it
-- updates the detail row. Finish that same rule with the selected vendor inside
-- the same transaction; if this fails, the post rolls back too.
create or replace function public.learn_books_bank_rule_vendor()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  txn public.bank_transactions%rowtype;
begin
  if new.entry_id is not null
    and old.entry_id is null
    and coalesce((new.coding->>'learn')::boolean, false)
    and jsonb_array_length(new.coding->'lines') = 1
    and nullif(new.coding->>'vendorId', '') is not null
  then
    select * into txn
      from public.bank_transactions
      where id = new.transaction_id and org_id = new.org_id;
    if nullif(trim(txn.merchant_name), '') is not null then
      update public.bank_rules
        set vendor_id = (new.coding->>'vendorId')::uuid,
            updated_by = new.updated_by
        where org_id = new.org_id
          and match_kind = 'merchant_exact'
          and match_value = lower(regexp_replace(trim(txn.merchant_name), '\s+', ' ', 'g'))
          and bank_account_id = txn.bank_account_id
          and direction = txn.direction;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.learn_books_bank_rule_vendor() from public, anon, authenticated;
grant execute on function public.learn_books_bank_rule_vendor() to service_role;

create trigger bank_transaction_details_learn_vendor
  before update of entry_id on public.bank_transaction_details
  for each row execute function public.learn_books_bank_rule_vendor();
