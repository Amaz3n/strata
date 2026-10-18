-- EP11-07 follow-up: what is already restored is everything posted for the request, whatever date it
-- carries. A recovery entry is dated the day the sweep ran; reversing an approval on an earlier date used to
-- read "restored as of that date", miss the later-dated entry and leave the recovery standing.

create or replace function public.reconcile_books_warranty_recovery(p_org_id uuid,p_request_id uuid,p_date date)
returns uuid language plpgsql security definer set search_path='' as $$
declare project uuid; reserve uuid; expense uuid; covered bigint; covered_on date; credited bigint; credited_on date; restored bigint; delta bigint; revision integer; policy integer; result_id uuid; dimensions jsonb; effective date;
begin
 select project_id into project from public.warranty_requests where org_id=p_org_id and id=p_request_id for update;
 if not found then raise exception 'Warranty request not found'; end if;
 perform 1 from public.project_financial_settings where org_id=p_org_id and project_id=project for update;
 select id into reserve from public.gl_accounts where org_id=p_org_id and code='2260' and active;
 select id into expense from public.gl_accounts where org_id=p_org_id and code='5050' and active;
 select coalesce(sum(books_reserve_consumed_cents),0), max(books_cost_date) into covered, covered_on from public.warranty_service_visits where org_id=p_org_id and request_id=p_request_id and books_cost_approved_at is not null and books_cost_date<=p_date;
 select c.credited_cents, c.credited_on into credited, credited_on from public.books_warranty_recovery_credited(p_org_id,p_request_id,p_date) c;
 select coalesce(sum(l.credit_cents-l.debit_cents),0) into restored from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id where l.org_id=p_org_id and l.account_id=reserve and l.dimensions->>'warranty_recovery_request_id'=p_request_id::text and e.status in('posted','reversed');
 delta:=least(covered,credited)-restored;
 if delta=0 then return null; end if;
 if reserve is null or expense is null then raise exception 'Warranty recovery accounts are missing'; end if;
 -- A recovery takes effect when the later of its cost approval and its credit did; taking one back, today.
 effective:=case when delta>0 then least(p_date,greatest(coalesce(covered_on,p_date),coalesce(credited_on,p_date))) else p_date end;
 select active_policy_version into policy from public.books_settings where org_id=p_org_id;
 select count(*)+1 into revision from public.journal_entries where org_id=p_org_id and source_type='warranty_reserve_recovery' and source_id=p_request_id;
 dimensions:=jsonb_build_object('warranty_reserve_adjustment',true,'warranty_recovery_request_id',p_request_id,'covered_cents',covered,'posted_recovery_cents',credited,'effective_on',effective);
 result_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p_date,'entry_kind','adjusting','memo','Reconcile reserve-backed warranty recovery','posting_key','warranty_recovery:'||p_request_id||':'||revision,'projection_version',1,'policy_version',policy,'source_type','warranty_reserve_recovery','source_id',p_request_id),
 jsonb_build_array(jsonb_build_object('line_no',1,'account_id',expense,'project_id',project,'debit_cents',greatest(delta,0),'credit_cents',greatest(-delta,0),'dimensions',dimensions),jsonb_build_object('line_no',2,'account_id',reserve,'project_id',project,'debit_cents',greatest(-delta,0),'credit_cents',greatest(delta,0),'dimensions',dimensions)));
 return result_id;
end;
$$;
revoke all on function public.reconcile_books_warranty_recovery(uuid,uuid,date) from public,anon,authenticated;
grant execute on function public.reconcile_books_warranty_recovery(uuid,uuid,date) to service_role;
