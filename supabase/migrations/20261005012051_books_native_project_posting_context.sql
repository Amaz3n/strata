-- Pending: one statement snapshot for actual project roots and native routing.
-- This is a posting plan input, never an activation or a journal write.
begin;
create function public.read_books_native_project_posting_context(p_org uuid,p_project uuid,p_source_type text,p_source_id uuid,p_actor uuid,p_entry_date date,p_operation text default 'prepare')
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare source jsonb;owner public.books_project_entity_reviews;proposal public.books_project_entity_proposals;profile public.books_legal_entity_profiles;chart public.books_entity_chart_versions;period public.books_entity_fiscal_periods;calendar public.books_entity_calendar_years;accounts jsonb;controls jsonb;
begin
 if p_entry_date is null or p_entry_date<date '1900-01-01' or p_entry_date>current_date then raise exception 'A valid nonfuture native posting date is required';end if;
 if p_source_type='invoice' then select to_jsonb(r) into source from public.invoices r where org_id=p_org and id=p_source_id and project_id=p_project;
 elsif p_source_type='vendor_bill' then select to_jsonb(r) into source from public.vendor_bills r where org_id=p_org and id=p_source_id and project_id=p_project;
 elsif p_source_type='expense' then select to_jsonb(r) into source from public.project_expenses r where org_id=p_org and id=p_source_id and project_id=p_project;
 else raise exception 'Native posting context does not support this source family';end if;
 if source is null or not exists(select 1 from public.projects where org_id=p_org and id=p_project) then raise exception 'Actual native posting source is missing or outside project';end if;
 select * into owner from public.books_project_entity_reviews where org_id=p_org and project_id=p_project;
 if owner.id is null or p_operation not in('prepare','review') or not public.books_entity_has_access(p_org,owner.legal_entity_id,p_actor,p_operation) then raise exception 'Reviewed owner and current entity % access are required',case p_operation when 'review' then 'review' else 'preparation' end;end if;
 select * into proposal from public.books_project_entity_proposals where org_id=p_org and legal_entity_id=owner.legal_entity_id and project_id=p_project and id=owner.proposal_id;
 if proposal.id is null or proposal.effective_on>p_entry_date then raise exception 'Project ownership is not effective on posting date';end if;
 select p.* into profile from public.books_legal_entity_profiles p join public.books_legal_entity_profile_reviews r on r.org_id=p.org_id and r.legal_entity_id=p.legal_entity_id and r.profile_id=p.id where p.org_id=p_org and p.legal_entity_id=owner.legal_entity_id and p.effective_on<=p_entry_date order by p.revision desc limit 1;
 if profile.id is null or profile.functional_currency<>'USD' then raise exception 'Reviewed native USD identity is required';end if;
 select c.* into chart from public.books_entity_chart_versions c join public.books_entity_chart_reviews r on r.org_id=c.org_id and r.legal_entity_id=c.legal_entity_id and r.chart_id=c.id where c.org_id=p_org and c.legal_entity_id=owner.legal_entity_id and c.effective_on<=p_entry_date order by c.effective_on desc limit 1;
 if chart.id is null then raise exception 'Applicable independently reviewed entity chart is required';end if;
 perform public.books_assert_entity_chart_receipt(chart.id);
 select p.* into period from public.books_entity_fiscal_periods p join public.books_entity_calendar_reviews r on r.org_id=p.org_id and r.legal_entity_id=p.legal_entity_id and r.calendar_year_id=p.calendar_year_id where p.org_id=p_org and p.legal_entity_id=owner.legal_entity_id and p_entry_date between p.starts_on and p.ends_on;
 if period.id is null then raise exception 'Applicable independently reviewed entity fiscal period is required';end if;
 select * into calendar from public.books_entity_calendar_years where org_id=p_org and legal_entity_id=owner.legal_entity_id and id=period.calendar_year_id;
 select jsonb_agg(jsonb_build_object('id',a.id,'code',a.code,'definition',to_jsonb(d)) order by a.code) into accounts from public.books_entity_accounts a join public.books_entity_account_definitions d on d.org_id=a.org_id and d.legal_entity_id=a.legal_entity_id and d.account_id=a.id where a.org_id=p_org and a.legal_entity_id=owner.legal_entity_id and d.chart_id=chart.id;
 select jsonb_agg(to_jsonb(c) order by c.role) into controls from public.books_entity_control_accounts c where c.org_id=p_org and c.legal_entity_id=owner.legal_entity_id and c.chart_id=chart.id;
 return jsonb_build_object('orgId',p_org,'projectId',p_project,'actorId',p_actor,'sourceType',p_source_type,'sourceId',p_source_id,'entryDate',p_entry_date,'source',source,'owner',to_jsonb(owner),'ownershipProposal',to_jsonb(proposal),'profile',to_jsonb(profile),'profileReview',(select to_jsonb(r) from public.books_legal_entity_profile_reviews r where r.org_id=p_org and r.legal_entity_id=owner.legal_entity_id and r.profile_id=profile.id),'chart',to_jsonb(chart),'chartReview',(select to_jsonb(r) from public.books_entity_chart_reviews r where r.org_id=p_org and r.legal_entity_id=owner.legal_entity_id and r.chart_id=chart.id),'period',to_jsonb(period),'calendar',to_jsonb(calendar),'calendarReview',(select to_jsonb(r) from public.books_entity_calendar_reviews r where r.org_id=p_org and r.legal_entity_id=owner.legal_entity_id and r.calendar_year_id=calendar.id),'accounts',accounts,'controls',controls,'capturedAt',statement_timestamp(),'databaseSnapshot',pg_current_snapshot()::text,'ledgerActivated',false);
end $$;
revoke all on function public.read_books_native_project_posting_context(uuid,uuid,text,uuid,uuid,date,text) from public,anon,authenticated;
grant execute on function public.read_books_native_project_posting_context(uuid,uuid,text,uuid,uuid,date,text) to service_role;
commit;
