-- Issued scopes and pricing decisions are durable commercial records.
alter table public.bid_packages add column if not exists scope_revision integer not null default 1;
alter table public.bid_submissions add column if not exists scope_revision integer not null default 1;
create table public.bid_scope_revisions (
 id uuid primary key default gen_random_uuid(), org_id uuid not null,
 bid_package_id uuid not null, revision integer not null, snapshot jsonb not null,
 reason text not null, created_at timestamptz not null default now(),
 unique (bid_package_id, revision),
 foreign key (org_id, bid_package_id) references public.bid_packages(org_id,id)
);
create table public.bid_pricing_decisions (
 id uuid primary key default gen_random_uuid(), org_id uuid not null,
 bid_package_id uuid not null, bid_submission_id uuid not null,
 submission_version integer not null, scope_revision integer not null,
 vendor_total_cents bigint not null check (vendor_total_cents >= 0),
 normalized_total_cents bigint not null check (normalized_total_cents >= 0),
 accepted_alternate_ids uuid[] not null default '{}', gaps jsonb not null default '[]',
 rationale text not null, snapshot jsonb not null,
 selected_by uuid, selected_at timestamptz not null default now(), superseded_at timestamptz,
 foreign key (org_id,bid_package_id) references public.bid_packages(org_id,id),
 foreign key (org_id,bid_submission_id) references public.bid_submissions(org_id,id)
);
create unique index bid_pricing_decisions_current on public.bid_pricing_decisions(bid_package_id) where superseded_at is null;
alter table public.bid_scope_revisions enable row level security;
alter table public.bid_pricing_decisions enable row level security;
revoke all on public.bid_scope_revisions, public.bid_pricing_decisions from anon, authenticated;
-- Reads and writes go through project-scoped application authorization.
grant all on public.bid_scope_revisions, public.bid_pricing_decisions to service_role;



create function public.guard_issued_bid_scope() returns trigger language plpgsql set search_path=public as $$
declare p public.bid_packages;
begin
 select * into p from public.bid_packages where id=coalesce(new.bid_package_id,old.bid_package_id) for update;
 if p.status <> 'draft' then raise exception 'Issued scope is immutable. Start a scope revision before editing.'; end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger bid_scope_issued_guard before insert or update or delete on public.bid_scope_items for each row execute function public.guard_issued_bid_scope();

create function public.stamp_bid_scope_revision() returns trigger language plpgsql set search_path=public as $$
begin
 select p.scope_revision into new.scope_revision from public.bid_invites i join public.bid_packages p on p.id=i.bid_package_id where i.id=new.bid_invite_id;
 return new;
end $$;
create trigger bid_submission_revision before insert on public.bid_submissions for each row execute function public.stamp_bid_scope_revision();

create function public.begin_bid_scope_revision(p_org_id uuid,p_package_id uuid,p_reason text) returns integer language plpgsql set search_path=public as $$
declare p public.bid_packages; n integer;
begin
 select * into p from public.bid_packages where org_id=p_org_id and id=p_package_id for update;
 if not found or p.status in ('draft','awarded','cancelled') then raise exception 'Only an issued unawarded package can be revised'; end if;
 if length(trim(p_reason))=0 then raise exception 'A revision reason is required'; end if;
 insert into public.bid_scope_revisions(org_id,bid_package_id,revision,snapshot,reason)
 values(p_org_id,p.id,p.scope_revision,jsonb_build_object('package',to_jsonb(p),'scope',coalesce((select jsonb_agg(s) from public.bid_scope_items s where s.bid_package_id=p.id),'[]'::jsonb)),p_reason);
 n:=p.scope_revision+1;
 update public.bid_packages set scope_revision=n,status='draft',updated_at=now() where id=p.id;
 update public.bid_pricing_decisions set superseded_at=now() where bid_package_id=p.id and superseded_at is null;
 return n;
end $$;
revoke all on function public.begin_bid_scope_revision(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.begin_bid_scope_revision(uuid,uuid,text) to service_role;

create function public.save_bid_pricing_decision(p_org_id uuid,p_submission_id uuid,p_user_id uuid,p_data jsonb) returns uuid language plpgsql set search_path=public as $$
declare s public.bid_submissions; p public.bid_packages; result uuid;
begin
 select * into s from public.bid_submissions where org_id=p_org_id and id=p_submission_id for update;
 select bp.* into p from public.bid_packages bp join public.bid_invites i on i.bid_package_id=bp.id where i.id=s.bid_invite_id and bp.org_id=p_org_id for update of bp;
 if s.id is null or p.id is null or not s.is_current or s.status not in ('submitted','revised') or s.total_cents is null or (s.valid_until is not null and s.valid_until::date<current_date) or s.scope_revision<>p.scope_revision then raise exception 'The quote is no longer eligible. Refresh and request reconfirmation.'; end if;
 if p.status in ('draft','cancelled','awarded') then raise exception 'Issue the package before selecting a pricing decision'; end if;
 if (p_data->>'vendor_total_cents')::bigint <> s.total_cents + coalesce((select sum(i.amount_cents) from public.bid_submission_items i join public.bid_scope_items si on si.id=i.bid_scope_item_id where i.bid_submission_id=s.id and i.response='priced' and si.item_type='alternate' and si.id in (select jsonb_array_elements_text(p_data->'accepted_alternate_ids')::uuid)),0) then raise exception 'Quote pricing changed. Refresh before selecting.'; end if;
 update public.bid_pricing_decisions set superseded_at=now() where bid_package_id=p.id and superseded_at is null;
 insert into public.bid_pricing_decisions(org_id,bid_package_id,bid_submission_id,submission_version,scope_revision,vendor_total_cents,normalized_total_cents,accepted_alternate_ids,gaps,rationale,snapshot,selected_by)
 values(p_org_id,p.id,s.id,s.version,p.scope_revision,(p_data->>'vendor_total_cents')::bigint,(p_data->>'normalized_total_cents')::bigint,array(select jsonb_array_elements_text(p_data->'accepted_alternate_ids'))::uuid[],p_data->'gaps',p_data->>'rationale',jsonb_build_object('submission',to_jsonb(s),'package',to_jsonb(p),'scope',coalesce((select jsonb_agg(si) from public.bid_scope_items si where si.bid_package_id=p.id),'[]'::jsonb),'items',coalesce((select jsonb_agg(bi) from public.bid_submission_items bi where bi.bid_submission_id=s.id),'[]'::jsonb)),p_user_id) returning id into result;
 return result;
end $$;
revoke all on function public.save_bid_pricing_decision(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.save_bid_pricing_decision(uuid,uuid,uuid,jsonb) to service_role;

-- Enforce eligibility even for internal conversion callers and preserve agreed scope.
create function public.guard_bid_award_readiness() returns trigger language plpgsql set search_path=public as $$
declare s public.bid_submissions; p public.bid_packages;
begin
 select * into s from public.bid_submissions where id=new.awarded_submission_id for update;
 select * into p from public.bid_packages where id=new.bid_package_id for update;
 if not s.is_current or s.status not in ('submitted','revised') or (s.valid_until is not null and s.valid_until::date<current_date) or s.scope_revision<>p.scope_revision then raise exception 'This quote must be refreshed or reconfirmed before award'; end if;
 if exists(select 1 from public.bid_addenda a where a.bid_package_id=p.id and not exists(select 1 from public.bid_addendum_acknowledgements ack where ack.bid_addendum_id=a.id and ack.bid_invite_id=s.bid_invite_id)) then raise exception 'The vendor must acknowledge all addenda before award'; end if;
 if exists(select 1 from public.projects pr where pr.id=p.project_id and pr.phase='precon') and not exists(select 1 from public.project_precon_handoffs h join public.contracts c on c.id=h.contract_id and c.org_id=h.org_id where h.org_id=p.org_id and h.project_id=p.project_id and c.status='active' and h.status in ('awarded','baseline_approved','accepted','released')) then raise exception 'Record the signed owner contract and commercial award before committing subcontract costs'; end if;
 if new.awarded_commitment_id is not null then
 update public.commitments set scope=concat_ws(E'\n\n',p.scope,'Vendor exclusions: '||s.exclusions,'Vendor clarifications: '||s.clarifications), metadata=coalesce(metadata,'{}')||jsonb_build_object('bid_scope_revision',s.scope_revision,'bid_submission_version',s.version,'bid_valid_until',s.valid_until,'bid_lead_time_days',s.lead_time_days,'bid_duration_days',s.duration_days,'bid_start_available_on',s.start_available_on,'subcontract_review_required',true) where id=new.awarded_commitment_id;
 end if;
 return new;
end $$;
create trigger bid_award_readiness before insert on public.bid_awards for each row execute function public.guard_bid_award_readiness();

create function public.run_reviewed_bid_award(p_org_id uuid,p_bid_submission_id uuid,p_awarded_by uuid,p_notes text,p_accepted_alternate_ids uuid[],p_reviewed_scope text,p_reviewed_terms text,p_readiness_exception text default null) returns jsonb language plpgsql set search_path=public as $$
declare result jsonb;
begin
 if nullif(trim(p_reviewed_scope),'') is null or nullif(trim(p_reviewed_terms),'') is null then raise exception 'Review scope and commercial terms before preparing an award'; end if;
 result:=public.run_bid_award_conversion(p_org_id,p_bid_submission_id,p_awarded_by,p_notes,p_accepted_alternate_ids);
 update public.commitments set scope=p_reviewed_scope,terms=p_reviewed_terms,metadata=coalesce(metadata,'{}')||jsonb_build_object('subcontract_review_required',false,'subcontract_reviewed_by',p_awarded_by,'subcontract_reviewed_at',now(),'readiness_exception',p_readiness_exception) where id=(result->>'commitment_id')::uuid and org_id=p_org_id;
 return result;
end $$;
revoke all on function public.run_reviewed_bid_award(uuid,uuid,uuid,text,uuid[],text,text,text) from public,anon,authenticated;
grant execute on function public.run_reviewed_bid_award(uuid,uuid,uuid,text,uuid[],text,text,text) to service_role;

create function public.revise_bid_for_addendum() returns trigger language plpgsql set search_path=public as $$
declare p public.bid_packages;
begin
 select * into p from public.bid_packages where id=new.bid_package_id for update;
 if p.status in ('awarded','cancelled') then raise exception 'Reopen the package before issuing addenda'; end if;
 insert into public.bid_scope_revisions(org_id,bid_package_id,revision,snapshot,reason)
 values(p.org_id,p.id,p.scope_revision,jsonb_build_object('package',to_jsonb(p),'scope',coalesce((select jsonb_agg(s) from public.bid_scope_items s where s.bid_package_id=p.id),'[]'::jsonb)),'Addendum '||new.number);
 update public.bid_packages set scope_revision=scope_revision+1,updated_at=now() where id=p.id;
 update public.bid_pricing_decisions set superseded_at=now() where bid_package_id=p.id and superseded_at is null;
 return new;
end $$;
create trigger bid_addendum_reconfirmation after insert on public.bid_addenda for each row execute function public.revise_bid_for_addendum();

create function public.retire_obsolete_bid_pricing() returns trigger language plpgsql set search_path=public as $$
begin
 if new.is_current=false or new.status not in ('submitted','revised') then
 update public.bid_pricing_decisions set superseded_at=now() where bid_submission_id=new.id and superseded_at is null;
 end if;
 return new;
end $$;
create trigger bid_pricing_quote_retired after update of is_current,status on public.bid_submissions for each row execute function public.retire_obsolete_bid_pricing();

create function public.guard_issued_bid_description() returns trigger language plpgsql set search_path=public as $$
begin
 if old.status<>'draft' and (new.scope is distinct from old.scope or new.instructions is distinct from old.instructions or new.mode is distinct from old.mode) then raise exception 'Start a scope revision before editing issued instructions'; end if;
 return new;
end $$;
create trigger bid_package_issued_description before update on public.bid_packages for each row execute function public.guard_issued_bid_description();

-- Lock the issued revision while accepting a quote. A stale browser must never
-- silently attest to instructions that changed after its form was loaded.
alter function public.create_bid_submission_version(uuid,uuid,jsonb,jsonb,text,uuid) rename to create_bid_submission_version_unchecked;
create function public.create_bid_submission_version(p_org_id uuid,p_bid_invite_id uuid,p_payload jsonb,p_items jsonb default '[]',p_source text default 'portal',p_entered_by uuid default null) returns jsonb language plpgsql set search_path=public as $$
declare i public.bid_invites; p public.bid_packages;
begin
 select * into i from public.bid_invites where id=p_bid_invite_id and org_id=p_org_id for update;
 select * into p from public.bid_packages where id=i.bid_package_id and org_id=p_org_id for update;
 if p.id is null then raise exception 'Bid package not found'; end if;
 if p.status in ('awarded','cancelled') or (p_source='portal' and p.status in ('draft','closed')) then raise exception 'Bidding is not open'; end if;
 if p_source='portal' and (p_payload->>'scope_revision' is null or (p_payload->>'scope_revision')::integer<>p.scope_revision) then raise exception 'The scope changed while this form was open. Reload and review before resubmitting.'; end if;
 if p_source='portal' and i.status in ('withdrawn','declined') then raise exception 'This invitation is inactive'; end if;
 return public.create_bid_submission_version_unchecked(p_org_id,p_bid_invite_id,p_payload,p_items,p_source,p_entered_by);
end $$;
revoke all on function public.create_bid_submission_version(uuid,uuid,jsonb,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function public.create_bid_submission_version(uuid,uuid,jsonb,jsonb,text,uuid) to service_role;
