-- Bounded private history for one proven payroll import. Frozen evidence stays
-- available after withdrawal; callers must authorize the project relationship.
create index books_payroll_payment_workspace_page_idx on public.books_payroll_payment_reviews(org_id,payroll_import_id,prepared_at desc,id desc);
create function public.read_books_payroll_payment_workspace(
 p_org_id uuid,p_import_id uuid,p_review_id uuid default null,
 p_before_time timestamptz default null,p_before_id uuid default null,p_limit integer default 50
) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_rows jsonb;v_next jsonb;
begin
 if p_org_id is null or p_import_id is null or p_limit is null or p_limit not between 1 and 50
 or (p_before_time is null)<>(p_before_id is null) or (p_review_id is not null and p_before_time is not null) then
  raise exception 'Invalid payroll attribution scope or pagination';
 end if;
 if not exists(select 1 from public.books_payroll_imports where org_id=p_org_id and id=p_import_id) then raise exception 'Payroll import is unavailable in organization';end if;
 with page as (
  select r.* from public.books_payroll_payment_reviews r where r.org_id=p_org_id and r.payroll_import_id=p_import_id
  and (p_review_id is null or r.id=p_review_id)
  and (p_before_time is null or (r.prepared_at,r.id)<(p_before_time,p_before_id))
  order by r.prepared_at desc,r.id desc limit p_limit+1
 ) select coalesce(jsonb_agg(to_jsonb(page) order by prepared_at desc,id desc),'[]') into v_rows from page;
 if p_review_id is not null and jsonb_array_length(v_rows)<>1 then raise exception 'Payroll attribution is unavailable for this import';end if;
 if jsonb_array_length(v_rows)>p_limit then
  v_rows:=v_rows-p_limit;v_next:=jsonb_build_object('preparedAt',v_rows->(p_limit-1)->'prepared_at','id',v_rows->(p_limit-1)->'id');
 end if;
 return jsonb_build_object('orgId',p_org_id,'importId',p_import_id,'reviews',v_rows,'nextCursor',v_next,
 'activeReviewId',(select id from public.books_payroll_payment_reviews where org_id=p_org_id and payroll_import_id=p_import_id and status<>'withdrawn'),
 'posted',exists(select 1 from public.books_payroll_postings where org_id=p_org_id and payroll_import_id=p_import_id));
end $$;
revoke all on function public.read_books_payroll_payment_workspace(uuid,uuid,uuid,timestamptz,uuid,integer) from public,anon,authenticated;
grant execute on function public.read_books_payroll_payment_workspace(uuid,uuid,uuid,timestamptz,uuid,integer) to service_role;
