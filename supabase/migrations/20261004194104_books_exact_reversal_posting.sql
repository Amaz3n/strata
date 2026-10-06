begin;
create function public.books_reversal_line_signature(p_lines jsonb,p_swap boolean default false,p_descriptions boolean default false)
returns jsonb language sql immutable security invoker set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(value order by value::text),'[]'::jsonb) from (
  select jsonb_build_object('account_id',l.account_id,'project_id',l.project_id,'company_id',l.company_id,
   'debit_cents',coalesce(case when p_swap then l.credit_cents else l.debit_cents end,0),
   -- books_account_classification is derived by the posting trigger from the original (or
   -- marked legacy_unknown when the original predates capture), never caller intent.
   'credit_cents',coalesce(case when p_swap then l.debit_cents else l.credit_cents end,0),'dimensions',coalesce(l.dimensions,'{}'::jsonb)-'books_account_classification')
   ||case when p_descriptions then jsonb_build_object('description',nullif(l.description,'')) else '{}'::jsonb end value
  from jsonb_to_recordset(p_lines) l(account_id uuid,project_id uuid,company_id uuid,debit_cents bigint,credit_cents bigint,dimensions jsonb,description text)
 ) normalized;
$$;
-- Validate existing committed chains without rewriting any historical money.
do $$
begin
 if exists(select 1 from public.journal_entries r left join public.journal_entries p on p.org_id=r.org_id and p.id=r.reversal_of_entry_id
  where r.status in('posted','reversed') and (r.entry_kind='reversal' or r.reversal_of_entry_id is not null)
  and (p.id is null or p.id=r.id or p.status<>'reversed' or r.entry_kind<>'reversal' or r.entry_date<p.entry_date
   or public.books_reversal_line_signature((select coalesce(jsonb_agg(to_jsonb(l)),'[]') from public.journal_lines l where l.org_id=r.org_id and l.entry_id=r.id))
    is distinct from public.books_reversal_line_signature((select coalesce(jsonb_agg(to_jsonb(l)),'[]') from public.journal_lines l where l.org_id=p.org_id and l.entry_id=p.id),true)))
  or exists(select 1 from public.journal_entries p where p.status='reversed' and (select count(*) from public.journal_entries r where r.org_id=p.org_id and r.reversal_of_entry_id=p.id and r.status in('posted','reversed'))<>1)
 then raise exception 'Existing reversal history requires reviewed correction before upgrade';end if;
end $$;
create unique index journal_entries_one_committed_reversal_idx on public.journal_entries(org_id,reversal_of_entry_id) where reversal_of_entry_id is not null and status in('posted','reversed');

create function public.books_guard_exact_reversal() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare parent public.journal_entries; actual jsonb; expected jsonb;
begin
 if new.status<>'posted' or (tg_op='UPDATE' and old.status='posted') then return new;end if;
 if new.entry_kind<>'reversal' and new.reversal_of_entry_id is null then return new;end if;
 if new.entry_kind<>'reversal' or new.reversal_of_entry_id is null or new.reversal_of_entry_id=new.id then raise exception 'Reversal must identify its original journal';end if;
 select * into parent from public.journal_entries where org_id=new.org_id and id=new.reversal_of_entry_id for update;
 if parent.id is null or parent.status<>'posted' or new.entry_date<parent.entry_date then raise exception 'Reversal requires a posted original and a date on or after its accounting date';end if;
 select public.books_reversal_line_signature(coalesce(jsonb_agg(to_jsonb(l)),'[]')) into actual from public.journal_lines l where l.org_id=new.org_id and l.entry_id=new.id;
 select public.books_reversal_line_signature(coalesce(jsonb_agg(to_jsonb(l)),'[]'),true) into expected from public.journal_lines l where l.org_id=parent.org_id and l.entry_id=parent.id;
 if jsonb_array_length(actual)<2 or actual is distinct from expected then raise exception 'Reversal must exactly mirror original accounts, amounts and dimensions';end if;
 return new;
end $$;
create trigger journal_entries_exact_reversal_guard before insert or update of status on public.journal_entries for each row execute function public.books_guard_exact_reversal();
create function public.books_complete_exact_reversal() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if new.status='posted' and new.reversal_of_entry_id is not null and (tg_op='INSERT' or old.status<>'posted') then
  update public.journal_entries set status='reversed' where org_id=new.org_id and id=new.reversal_of_entry_id and status='posted';
 end if;
 return new;
end $$;
create trigger journal_entries_exact_reversal_complete after insert or update of status on public.journal_entries for each row execute function public.books_complete_exact_reversal();
create or replace function public.reverse_books_journal_entry(p_org_id uuid,p_original_entry_id uuid,p_entry jsonb,p_lines jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare original public.journal_entries; reversal public.journal_entries; reversal_id uuid; saved_lines jsonb;
begin
 if jsonb_typeof(p_entry) is distinct from 'object' or jsonb_typeof(p_lines) is distinct from 'array' then raise exception 'Reversal requires entry and lines';end if;
 select * into original from public.journal_entries where org_id=p_org_id and id=p_original_entry_id for update;
 if original.id is null then raise exception 'Original journal entry not found';end if;
 if p_entry->>'entry_kind' is distinct from 'reversal' or nullif(p_entry->>'reversal_of_entry_id','')::uuid is distinct from original.id then raise exception 'Reversal payload does not identify original';end if;
 select * into reversal from public.journal_entries where org_id=p_org_id and reversal_of_entry_id=original.id and status in('posted','reversed');
 if reversal.id is not null then
  select coalesce(jsonb_agg(to_jsonb(l)),'[]') into saved_lines from public.journal_lines l where l.org_id=p_org_id and l.entry_id=reversal.id;
  if original.status<>'reversed' or reversal.entry_date is distinct from (p_entry->>'entry_date')::date
   or reversal.memo is distinct from p_entry->>'memo' or reversal.posting_key is distinct from p_entry->>'posting_key'
   or reversal.projection_version is distinct from coalesce((p_entry->>'projection_version')::integer,1)
   or reversal.policy_version is distinct from (p_entry->>'policy_version')::integer
   or reversal.fact_id is distinct from nullif(p_entry->>'fact_id','')::uuid
   or reversal.source_type is distinct from nullif(p_entry->>'source_type','')
   or reversal.source_id is distinct from nullif(p_entry->>'source_id','')::uuid
   or reversal.created_by is distinct from nullif(p_entry->>'created_by','')::uuid
   or public.books_reversal_line_signature(saved_lines,false,true) is distinct from public.books_reversal_line_signature(p_lines,false,true)
  then raise exception 'Reversal retry differs from committed intent';end if;
  return jsonb_build_object('id',reversal.id,'created',false);
 end if;
 if original.status<>'posted' then raise exception 'Only a posted journal entry can be reversed';end if;
 reversal_id:=public.post_books_journal_entry(p_org_id,p_entry,p_lines);
 return jsonb_build_object('id',reversal_id,'created',true);
end $$;
revoke all on function public.books_reversal_line_signature(jsonb,boolean,boolean),public.books_guard_exact_reversal(),public.books_complete_exact_reversal(),public.reverse_books_journal_entry(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.books_reversal_line_signature(jsonb,boolean,boolean),public.books_guard_exact_reversal(),public.books_complete_exact_reversal(),public.reverse_books_journal_entry(uuid,uuid,jsonb,jsonb) to service_role;
commit;
