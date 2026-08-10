-- Builder-initiated vendor payment invitations.
--
-- `vendor_payment_relationships.status` has always allowed 'invited', but
-- `vendor_company_claim_id` and `vendor_entity_id` were NOT NULL — and both only
-- come into existence when the vendor claims the company from their portal.
-- That made 'invited' unreachable: a builder had no way to record having asked a
-- vendor to set up electronic payment, and therefore no way to see which of
-- their vendors are payable. This makes those two columns nullable for that one
-- pre-claim state and keeps them mandatory for every state that follows.

alter table public.vendor_payment_relationships
  alter column vendor_company_claim_id drop not null,
  alter column vendor_entity_id drop not null;

alter table public.vendor_payment_relationships
  add constraint vendor_payment_relationships_claim_required_chk
  check (
    status = 'invited'
    or (vendor_company_claim_id is not null and vendor_entity_id is not null)
  );

-- An unclaimed invitation has no claim to validate against, and must never
-- carry a vendor entity or a payout destination. Every state past 'invited' is
-- validated exactly as before.
create or replace function public.enforce_vendor_payment_relationship_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  claim_org uuid;
  claim_company uuid;
  claim_entity uuid;
  recipient_entity uuid;
begin
  if new.vendor_company_claim_id is null then
    if new.vendor_entity_id is not null or new.recipient_account_id is not null then
      raise exception 'An unclaimed payment invitation cannot carry a vendor entity or payout account';
    end if;
    return new;
  end if;

  select org_id, company_id, vendor_entity_id
    into claim_org, claim_company, claim_entity
  from public.vendor_company_claims where id = new.vendor_company_claim_id;

  if claim_org is distinct from new.org_id
     or claim_company is distinct from new.company_id
     or claim_entity is distinct from new.vendor_entity_id then
    raise exception 'Payment relationship must match its verified vendor claim';
  end if;

  if new.recipient_account_id is not null then
    select vendor_entity_id into recipient_entity
    from public.payment_recipient_accounts where id = new.recipient_account_id;
    if recipient_entity is distinct from new.vendor_entity_id then
      raise exception 'Recipient account must belong to the relationship vendor entity';
    end if;
  end if;
  return new;
end;
$$;

-- Readiness is read per company on the directory and the payables nudge.
create index if not exists vendor_payment_relationships_org_company_status_idx
  on public.vendor_payment_relationships (org_id, company_id, status);
