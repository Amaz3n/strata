-- Freeze the complete submitted intent and retain exact independent review receipts.
begin;
create function public.books_validate_proposal_receipt(p public.books_journal_proposals)
returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare j public.journal_entries; r public.journal_entries; saved jsonb;
begin
 if p.status='pending' then
  if p.reviewed_by is not null or p.reviewed_at is not null or p.review_note is not null or p.journal_entry_id is not null or p.reversal_entry_id is not null then raise exception 'Pending proposal has review evidence';end if;
  return;
 end if;
 if p.reviewed_by is null or p.reviewed_by=p.proposed_by or p.reviewed_at is null then raise exception 'Independent review evidence is required';end if;
 if p.status='rejected' then
  if length(btrim(coalesce(p.review_note,'')))<4 or p.journal_entry_id is not null or p.reversal_entry_id is not null then raise exception 'Invalid rejection receipt';end if;
  return;
 end if;
 select * into j from public.journal_entries where org_id=p.org_id and id=p.journal_entry_id;
 select coalesce(jsonb_agg(to_jsonb(l)),'[]') into saved from public.journal_lines l where org_id=p.org_id and entry_id=p.journal_entry_id;
 if j.id is null or j.status not in('posted','reversed') or j.entry_kind<>'adjusting' or j.entry_date is distinct from p.entry_date or j.memo is distinct from p.memo or j.posting_key is distinct from p.posting_key or j.policy_version is distinct from p.policy_version or j.projection_version<>1 or j.created_by is distinct from p.proposed_by or j.fact_id is not null or j.source_type is not null or j.source_id is not null or j.reversal_of_entry_id is not null or public.books_reversal_line_signature(saved,false,true) is distinct from public.books_reversal_line_signature(p.lines,false,true) then raise exception 'Proposal approval differs from retained journal';end if;
 if p.reversing_on is null then
  if p.reversal_entry_id is not null then raise exception 'Unscheduled proposal has a scheduled reversal receipt';end if;
 else
  select * into r from public.journal_entries where org_id=p.org_id and id=p.reversal_entry_id;
  select coalesce(jsonb_agg(to_jsonb(l)),'[]') into saved from public.journal_lines l where org_id=p.org_id and entry_id=p.reversal_entry_id;
  if r.id is null or r.status not in('posted','reversed') or r.entry_kind<>'reversal' or r.reversal_of_entry_id is distinct from j.id or r.entry_date is distinct from p.reversing_on or r.memo is distinct from 'Automatic reversal: '||p.memo or r.posting_key is distinct from 'scheduled_reversal:'||j.id::text||':'||p.reversing_on::text or r.created_by is distinct from p.proposed_by or r.policy_version is distinct from p.policy_version or r.projection_version<>1 or r.fact_id is not null or r.source_id is not null or public.books_reversal_line_signature(saved,false,true) is distinct from public.books_reversal_line_signature(p.lines,true,true) then raise exception 'Proposal approval differs from retained reversal';end if;
 end if;
end;
$$;
-- Validate history; corruption aborts the upgrade rather than inventing review evidence.
do $$ declare p public.books_journal_proposals;begin for p in select * from public.books_journal_proposals loop perform public.books_validate_proposal_receipt(p);end loop;end $$;
alter table public.books_journal_proposals
 add constraint books_proposal_journal_owner foreign key(org_id,journal_entry_id) references public.journal_entries(org_id,id),
 add constraint books_proposal_reversal_owner foreign key(org_id,reversal_entry_id) references public.journal_entries(org_id,id);
create or replace function public.books_guard_journal_proposal()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if tg_op='DELETE' then raise exception 'Journal proposals cannot be deleted';end if;
 if tg_op='INSERT' then
  if new.status<>'pending' or (new.reversing_on is not null and new.reversing_on<new.entry_date) then raise exception 'A new proposal must be pending with a valid reversal date';end if;
  perform 1 from public.memberships where org_id=new.org_id and user_id=new.proposed_by and status='active' for share;
  if not found then raise exception 'Active maker membership is required';end if;
 else
  if old.status<>'pending' then raise exception 'Reviewed journal proposals are immutable';end if;
  if (to_jsonb(new)-array['status','reviewed_by','reviewed_at','review_note','journal_entry_id','reversal_entry_id']) is distinct from (to_jsonb(old)-array['status','reviewed_by','reviewed_at','review_note','journal_entry_id','reversal_entry_id']) then raise exception 'Journal proposal intent is immutable';end if;
  if new.status not in('posted','rejected') then raise exception 'A pending proposal may only transition through review';end if;
  perform 1 from public.memberships where org_id=new.org_id and user_id=new.reviewed_by and status='active' for share;
  if not found then raise exception 'Active reviewer membership is required';end if;
 end if;
 perform public.books_validate_proposal_receipt(new);
 return new;
end;
$$;
drop trigger books_journal_proposals_guard on public.books_journal_proposals;
create trigger books_journal_proposals_guard before insert or update or delete on public.books_journal_proposals for each row execute function public.books_guard_journal_proposal();
create or replace function public.review_books_journal_proposal_atomic(p_org_id uuid,p_proposal_id uuid,p_reviewer_id uuid,p_decision text,p_note text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare p public.books_journal_proposals; j uuid; r uuid; created boolean:=false; note text:=nullif(btrim(coalesce(p_note,'')),'');
begin
 if p_decision is null or p_decision not in('approve','reject') or length(coalesce(note,''))>1000 then raise exception 'Invalid review decision or note';end if;
 perform 1 from public.memberships where org_id=p_org_id and user_id=p_reviewer_id and status='active' for share;
 if not found then raise exception 'Active reviewer membership is required';end if;
 select * into p from public.books_journal_proposals where org_id=p_org_id and id=p_proposal_id for update;
 if not found then raise exception 'Journal proposal not found';end if;
 if p.proposed_by=p_reviewer_id then raise exception 'The proposal maker cannot review their own entry';end if;
 if p.status<>'pending' then
  if p.status is distinct from (case when p_decision='approve' then 'posted' else 'rejected' end) or p.reviewed_by is distinct from p_reviewer_id or nullif(btrim(coalesce(p.review_note,'')),'') is distinct from note then raise exception 'Review retry differs from retained approval or rejection';end if;
  perform public.books_validate_proposal_receipt(p);
 else
  if p_decision='reject' then
   if length(coalesce(note,''))<4 then raise exception 'A rejection note is required';end if;
  else
   perform 1 from public.memberships where org_id=p_org_id and user_id=p.proposed_by and status='active' for share;
   if not found then raise exception 'Active maker membership is required for new approval';end if;
   perform 1 from public.gl_accounts a where org_id=p_org_id and a.id in(select l.account_id from jsonb_to_recordset(p.lines) l(account_id uuid)) for share;
   if exists(select 1 from jsonb_to_recordset(p.lines) l(account_id uuid) where not exists(select 1 from public.gl_accounts a where a.org_id=p_org_id and a.id=l.account_id and a.active)) then raise exception 'New approval accounts must be active and scoped';end if;
   if exists(select 1 from public.journal_entries where org_id=p_org_id and posting_key=p.posting_key) then raise exception 'Pending proposal posting key is already occupied; reviewed recovery is required';end if;
   j:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p.entry_date,'entry_kind','adjusting','memo',p.memo,'posting_key',p.posting_key,'projection_version',1,'policy_version',p.policy_version,'created_by',p.proposed_by),p.lines);
   if p.reversing_on is not null then
    r:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p.reversing_on,'entry_kind','reversal','memo','Automatic reversal: '||p.memo,'posting_key','scheduled_reversal:'||j::text||':'||p.reversing_on::text,'projection_version',1,'policy_version',p.policy_version,'reversal_of_entry_id',j,'created_by',p.proposed_by),(select jsonb_agg(item||jsonb_build_object('debit_cents',item->'credit_cents','credit_cents',item->'debit_cents') order by(item->>'line_no')::integer) from jsonb_array_elements(p.lines) item));
   end if;
  end if;
  update public.books_journal_proposals set status=case when p_decision='approve' then 'posted' else 'rejected' end,reviewed_by=p_reviewer_id,reviewed_at=now(),review_note=note,journal_entry_id=j,reversal_entry_id=r where id=p.id returning * into p;
  created:=true;
 end if;
 return jsonb_build_object('orgId',p.org_id,'proposalId',p.id,'reviewerId',p.reviewed_by,'status',p.status,'journal_entry_id',p.journal_entry_id,'reversal_entry_id',p.reversal_entry_id,'created',created);
end;
$$;
revoke all on function public.books_validate_proposal_receipt(public.books_journal_proposals),public.books_guard_journal_proposal(),public.review_books_journal_proposal_atomic(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.books_validate_proposal_receipt(public.books_journal_proposals),public.books_guard_journal_proposal(),public.review_books_journal_proposal_atomic(uuid,uuid,uuid,text,text) to service_role;
commit;
