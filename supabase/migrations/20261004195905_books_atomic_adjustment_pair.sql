-- One direct manual intent; existing IDs/posting keys survive legacy recovery.
begin;
create function public.post_books_adjustment_pair(p_org uuid,p_actor uuid,p_date date,p_memo text,p_key text,p_policy integer,p_lines jsonb,p_reversing_on date default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare original public.journal_entries; child public.journal_entries; saved jsonb; reversal_lines jsonb; result jsonb; created boolean:=false; recovered boolean:=false; reversal_created boolean:=false; reversal_id uuid;
begin
 if p_actor is null or p_date is null or length(btrim(coalesce(p_memo,'')))<4 or p_key is null or p_key!~'^adjustment:[a-f0-9]{64}$' or p_policy is null or p_policy<1 or jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines)<2 or(p_reversing_on is not null and p_reversing_on<p_date) then raise exception 'Invalid manual adjustment intent';end if;
 perform 1 from public.memberships where org_id=p_org and user_id=p_actor and status='active' for share;
 if not found then raise exception 'Active organization membership is required';end if;
 perform pg_advisory_xact_lock(hashtextextended('books-manual-adjustment:'||p_org::text||':'||p_key,0));
 select * into original from public.journal_entries where org_id=p_org and posting_key=p_key for update;
 if original.id is not null then
  select coalesce(jsonb_agg(to_jsonb(l)),'[]') into saved from public.journal_lines l where l.org_id=p_org and l.entry_id=original.id;
  if original.status not in('posted','reversed') or original.entry_kind<>'adjusting' or original.entry_date is distinct from p_date or original.memo is distinct from btrim(p_memo) or original.policy_version is distinct from p_policy or original.projection_version<>1 or original.created_by is distinct from p_actor or original.fact_id is not null or original.source_id is not null or original.reversal_of_entry_id is not null or coalesce(original.source_type,'') not in('','manual_adjustment','manual_adjustment_pair') or public.books_reversal_line_signature(saved,false,true) is distinct from public.books_reversal_line_signature(p_lines,false,true) then raise exception 'Manual adjustment retry differs from retained original';end if;
  select * into child from public.journal_entries where org_id=p_org and reversal_of_entry_id=original.id and status in('posted','reversed');
  if original.source_type='manual_adjustment' and p_reversing_on is not null then raise exception 'Manual adjustment retry changes its reversal schedule';end if;
  if original.source_type='manual_adjustment_pair' and p_reversing_on is null then raise exception 'Manual adjustment retry changes its reversal schedule';end if;
  if p_reversing_on is null and original.source_type is distinct from 'manual_adjustment' and child.posting_key like 'scheduled_reversal:'||original.id::text||':%' then raise exception 'Manual adjustment retry omits retained reversal schedule';end if;
  if p_reversing_on is not null and child.id is null then
   if original.source_type is not null or original.status<>'posted' then raise exception 'Retained scheduled pair is incomplete; reviewed recovery is required';end if;
   recovered:=true;
  end if;
 else
  -- Original account deactivation cannot prevent a committed retry, but a new
  -- adjustment must still use currently active scoped accounts.
  perform 1 from public.gl_accounts a where a.org_id=p_org and a.id in(select l.account_id from jsonb_to_recordset(p_lines) l(account_id uuid)) for share;
  if exists(select 1 from jsonb_to_recordset(p_lines) l(account_id uuid) where not exists(select 1 from public.gl_accounts a where a.org_id=p_org and a.id=l.account_id and a.active)) then raise exception 'New adjustment accounts must be active and scoped';end if;
  original.id:=public.post_books_journal_entry(p_org,jsonb_build_object('entry_date',p_date,'entry_kind','adjusting','memo',btrim(p_memo),'posting_key',p_key,'projection_version',1,'policy_version',p_policy,'source_type',case when p_reversing_on is null then 'manual_adjustment' else 'manual_adjustment_pair' end,'created_by',p_actor),p_lines);
  created:=true;
 end if;
 if p_reversing_on is not null then
  select jsonb_agg(item||jsonb_build_object('debit_cents',coalesce(item->'credit_cents','0'::jsonb),'credit_cents',coalesce(item->'debit_cents','0'::jsonb)) order by(item->>'line_no')::integer) into reversal_lines from jsonb_array_elements(p_lines) item;
  result:=public.reverse_books_journal_entry(p_org,original.id,jsonb_build_object('entry_date',p_reversing_on,'entry_kind','reversal','memo','Automatic reversal: '||btrim(p_memo),'posting_key','scheduled_reversal:'||original.id::text||':'||p_reversing_on::text,'projection_version',1,'policy_version',p_policy,'created_by',p_actor,'reversal_of_entry_id',original.id),reversal_lines);
  reversal_id:=(result->>'id')::uuid;reversal_created:=(result->>'created')::boolean;
 end if;
 return jsonb_build_object('orgId',p_org,'actorId',p_actor,'postingKey',p_key,'id',original.id,'reversalId',reversal_id,'created',created,'reversalCreated',reversal_created,'legacyRecovered',recovered);
end $$;
revoke all on function public.post_books_adjustment_pair(uuid,uuid,date,text,text,integer,jsonb,date) from public,anon,authenticated;
grant execute on function public.post_books_adjustment_pair(uuid,uuid,date,text,text,integer,jsonb,date) to service_role;
commit;
