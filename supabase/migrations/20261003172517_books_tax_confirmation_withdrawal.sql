-- Explicit no-adjustment confirmations and audited draft withdrawal.
alter table public.books_tax_adjustment_workpapers add column preparation_notes text not null default '';
alter table public.books_tax_adjustment_workpapers drop constraint books_tax_adjustment_workpapers_lines_check;
alter table public.books_tax_adjustment_workpapers add constraint books_tax_workpaper_lines_check check(jsonb_typeof(lines)='array' and jsonb_array_length(lines) between 0 and 500);
alter table public.books_tax_adjustment_workpapers add constraint books_tax_workpaper_confirmation_check check(length(preparation_notes)<=2000 and (jsonb_array_length(lines)>0 or length(trim(preparation_notes))>=10));
create or replace function public.guard_books_tax_workpaper() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item jsonb; seen uuid[]:='{}'; line_id uuid; amount numeric;
begin
 if tg_op='DELETE' then raise exception 'Tax workpaper history cannot be deleted'; end if;
 if new.status='approved' and (coalesce(length(trim(new.review_notes)),0)<10 or new.reviewed_by is null or new.reviewed_by=new.prepared_by or not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.reviewed_by and status='active')) then raise exception 'Tax approval requires substantive notes and a separate active reviewer'; end if;
 if new.status in('withdrawn','superseded') and (coalesce(length(trim(new.close_reason)),0)<10 or not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.closed_by and status='active')) then raise exception 'Tax workpaper closure requires substantive notes and active organization actor'; end if;
 if tg_op='INSERT' or new.status='approved' then
  if public.books_tax_source_revision(public.capture_books_export_snapshot(new.org_id),new.period_end) is distinct from new.base_snapshot->>'source_revision' then raise exception 'Cash source revision changed before workpaper transition'; end if;
 end if;
 if tg_op='UPDATE' then
  if to_jsonb(new)-array['status','reviewed_by','reviewed_at','review_notes','closed_by','closed_at','close_reason'] is distinct from to_jsonb(old)-array['status','reviewed_by','reviewed_at','review_notes','closed_by','closed_at','close_reason'] then raise exception 'Tax workpaper evidence is immutable'; end if;
  if not ((old.status='draft' and new.status='approved') or (old.status='draft' and new.status='withdrawn') or (old.status='approved' and new.status='superseded' and new.reviewed_by=old.reviewed_by and new.reviewed_at=old.reviewed_at and new.review_notes=old.review_notes)) then raise exception 'Invalid tax workpaper transition'; end if;
 else
  if new.status<>'draft' then raise exception 'Tax workpapers must start as drafts'; end if;
  if not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.prepared_by and status='active') then raise exception 'Tax preparer must be an active organization member'; end if;
  if new.base_snapshot->>'basis' is distinct from 'cash' or new.base_snapshot->>'version' is distinct from '1' or new.base_snapshot->>'start_date' is distinct from new.period_start::text or new.base_snapshot->>'end_date' is distinct from new.period_end::text or coalesce(new.base_snapshot->>'source_revision','') !~ '^[a-f0-9]{64}$' then raise exception 'Tax workpaper requires exact dated cash basis and source revision'; end if;
  if coalesce(jsonb_typeof(new.base_snapshot->'net_income_cents'),'')<>'number' or abs((new.base_snapshot->>'net_income_cents')::numeric)>9007199254740991 or (new.base_snapshot->>'net_income_cents')::numeric<>trunc((new.base_snapshot->>'net_income_cents')::numeric) then raise exception 'Tax base requires exact safe integer cents'; end if;
  for item in select value from jsonb_array_elements(new.lines) loop
   line_id:=(item->>'id')::uuid;
   if line_id is null or line_id=any(seen) then raise exception 'Missing or duplicate tax adjustment identity'; end if;
   seen:=array_append(seen,line_id);
   amount:=(item->>'amount_cents')::numeric;
   if jsonb_typeof(item->'amount_cents') is distinct from 'number' or amount is null or amount=0 or amount<>trunc(amount) or abs(amount)>9007199254740991 or coalesce(item->>'kind','') not in('permanent','timing') or coalesce(length(trim(item->>'description')),0)<10 or coalesce(length(trim(item->>'evidence_reference')),0)<3 then raise exception 'Tax adjustments require signed exact cents, classification, explanation and evidence'; end if;
   if item->>'project_id' is not null and not exists(select 1 from public.projects where id=(item->>'project_id')::uuid and org_id=new.org_id) then raise exception 'Tax adjustment project is outside organization'; end if;
   if item->>'evidence_file_id' is not null and not exists(select 1 from public.files where id=(item->>'evidence_file_id')::uuid and org_id=new.org_id) then raise exception 'Tax adjustment evidence file is outside organization'; end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(new.lines) group by value->>'kind' having abs(sum((value->>'amount_cents')::numeric))>9007199254740991) then raise exception 'Tax adjustment category exceeds exact safe cents'; end if;
  if abs((select coalesce(sum((value->>'amount_cents')::numeric),0) from jsonb_array_elements(new.lines)))>9007199254740991 or abs((new.base_snapshot->>'net_income_cents')::numeric+(select coalesce(sum((value->>'amount_cents')::numeric),0) from jsonb_array_elements(new.lines)))>9007199254740991 then raise exception 'Tax workpaper aggregate exceeds exact safe cents'; end if;
 end if;
 return new;
end $$;
drop function public.prepare_books_tax_workpaper(uuid,uuid,date,date,text,jsonb,jsonb,text,uuid);
create function public.prepare_books_tax_workpaper(p_org_id uuid,p_actor_id uuid,p_period_start date,p_period_end date,p_base_digest text,p_base_snapshot jsonb,p_lines jsonb,p_idempotency_key text,p_supersedes_id uuid default null,p_preparation_notes text default '')
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare existing public.books_tax_adjustment_workpapers; result uuid;
begin
 if not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active') then raise exception 'Tax preparer must be an active organization member'; end if;
 if p_org_id is null or p_actor_id is null or coalesce(length(trim(p_idempotency_key)),0)<10 then raise exception 'Tax workpaper scope, actor and retry key are required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('tax-workpaper:'||p_org_id::text,0));
 select * into existing from public.books_tax_adjustment_workpapers where org_id=p_org_id and idempotency_key=p_idempotency_key;
 if found then
  if existing.prepared_by<>p_actor_id or existing.period_start<>p_period_start or existing.period_end<>p_period_end or existing.base_digest<>p_base_digest or existing.base_snapshot<>p_base_snapshot or existing.lines<>p_lines or existing.supersedes_id is distinct from p_supersedes_id or existing.preparation_notes is distinct from p_preparation_notes then raise exception 'Tax workpaper retry key has different evidence'; end if;
  return existing.id;
 end if;
 if public.books_tax_source_revision(public.capture_books_export_snapshot(p_org_id),p_period_end) is distinct from p_base_snapshot->>'source_revision' then raise exception 'Cash source revision changed before preparation'; end if;
 if p_supersedes_id is not null and not exists(select 1 from public.books_tax_adjustment_workpapers where org_id=p_org_id and id=p_supersedes_id and status='approved' and period_start=p_period_start and period_end=p_period_end) then raise exception 'Replacement requires an approved workpaper for the same exact period'; end if;
 insert into public.books_tax_adjustment_workpapers(org_id,period_start,period_end,base_digest,base_snapshot,lines,prepared_by,idempotency_key,supersedes_id,preparation_notes) values(p_org_id,p_period_start,p_period_end,p_base_digest,p_base_snapshot,p_lines,p_actor_id,p_idempotency_key,p_supersedes_id,p_preparation_notes) returning id into result;
 return result;
end $$;
revoke all on function public.prepare_books_tax_workpaper(uuid,uuid,date,date,text,jsonb,jsonb,text,uuid,text) from public,anon,authenticated;
grant execute on function public.prepare_books_tax_workpaper(uuid,uuid,date,date,text,jsonb,jsonb,text,uuid,text) to service_role;


create function public.withdraw_books_tax_workpaper(p_org_id uuid,p_id uuid,p_actor_id uuid,p_reason text)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item public.books_tax_adjustment_workpapers;
begin
 if not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active') then raise exception 'Tax withdrawal requires active organization actor'; end if;
 if coalesce(length(trim(p_reason)),0)<10 or length(p_reason)>2000 then raise exception 'Substantive tax withdrawal reason required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('tax-workpaper:'||p_org_id::text,0));
 select * into item from public.books_tax_adjustment_workpapers where org_id=p_org_id and id=p_id for update;
 if not found then raise exception 'Tax workpaper not found in organization'; end if;
 if item.status='withdrawn' and item.closed_by=p_actor_id and item.close_reason=p_reason then return item.id; end if;
 if item.status<>'draft' then raise exception 'Only draft tax workpapers can be withdrawn'; end if;
 update public.books_tax_adjustment_workpapers set status='withdrawn',closed_by=p_actor_id,closed_at=now(),close_reason=p_reason where id=item.id;
 return item.id;
end $$;
revoke all on function public.withdraw_books_tax_workpaper(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.withdraw_books_tax_workpaper(uuid,uuid,uuid,text) to service_role;
