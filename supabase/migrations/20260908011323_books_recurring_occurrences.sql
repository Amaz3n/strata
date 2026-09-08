-- A completed schedule retains its next calculated date for audit even past its end.
do $$ declare constraint_name text; begin
  for constraint_name in select conname from pg_constraint where conrelid='public.recurring_posting_templates'::regclass and contype='c' and pg_get_constraintdef(oid) like '%end_on%' and pg_get_constraintdef(oid) like '%next_run_on%' loop
    execute format('alter table public.recurring_posting_templates drop constraint %I',constraint_name);
  end loop;
end $$;
alter table public.recurring_posting_templates add constraint recurring_end_date_check check(status='completed' or end_on is null or end_on>=next_run_on);
-- A scheduled occurrence is a durable proposal (or a posted journal), not a notification.
alter table public.recurring_posting_templates add column if not exists anchor_day smallint check(anchor_day between 1 and 31);
alter table public.books_journal_proposals add column if not exists recurring_template_id uuid references public.recurring_posting_templates(id) on delete restrict;
create unique index if not exists books_recurring_proposal_date_idx on public.books_journal_proposals(org_id,recurring_template_id,entry_date) where recurring_template_id is not null;

create or replace function public.generate_books_recurring_occurrence(p_org_id uuid,p_template_id uuid,p_as_of date)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  template public.recurring_posting_templates%rowtype;
  policy integer;
  lines jsonb;
  key text;
  occurrence_id uuid;
  next_date date;
  next_month date;
  anchor integer;
  outcome text;
begin
  select * into template from public.recurring_posting_templates where org_id=p_org_id and id=p_template_id for update;
  if not found then raise exception 'Recurring template not found'; end if;
  if template.status<>'active' or template.next_run_on>p_as_of then return jsonb_build_object('status','not_due'); end if;
  if template.end_on is not null and template.next_run_on>template.end_on then
    update public.recurring_posting_templates set status='completed' where org_id=p_org_id and id=template.id;
    return jsonb_build_object('status','completed');
  end if;
  select active_policy_version into policy from public.books_settings where org_id=p_org_id and workspace_enabled and arc_ledger_mode<>'disabled';
  if not found then return jsonb_build_object('status','disabled'); end if;
  select jsonb_agg(jsonb_build_object('line_no',l.line_no,'account_id',l.account_id,'project_id',l.project_id,
    'company_id',l.company_id,'description',l.description,'debit_cents',l.debit_cents,'credit_cents',l.credit_cents,'dimensions','{}'::jsonb) order by l.line_no)
    into lines from public.recurring_posting_lines l where l.org_id=p_org_id and l.template_id=template.id;
  if lines is null or jsonb_array_length(lines)<2 then raise exception 'Recurring template requires balanced lines'; end if;
  if (select sum((l->>'debit_cents')::bigint-(l->>'credit_cents')::bigint) from jsonb_array_elements(lines) l)<>0 then raise exception 'Recurring template is unbalanced'; end if;
  key:='recurring:'||template.id||':'||template.next_run_on;
  if not template.auto_post or template.requires_approval then
    if template.created_by is null then raise exception 'Recurring template needs a maker before approval can be requested'; end if;
    insert into public.books_journal_proposals(org_id,entry_date,memo,posting_key,policy_version,lines,proposed_by,recurring_template_id)
      values(p_org_id,template.next_run_on,template.memo,key,policy,lines,template.created_by,template.id)
      on conflict(org_id,posting_key) do nothing returning id into occurrence_id;
    if occurrence_id is null then select id into occurrence_id from public.books_journal_proposals where org_id=p_org_id and posting_key=key; end if;
    outcome:='awaiting_approval';
  else
    occurrence_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',template.next_run_on,
      'entry_kind','adjusting','memo',template.memo,'posting_key',key,'projection_version',1,'policy_version',policy,
      'source_type','recurring_posting_template','source_id',template.id,'created_by',template.created_by),lines);
    outcome:='posted';
  end if;
  anchor:=coalesce(template.anchor_day,extract(day from template.next_run_on)::integer);
  if template.frequency='weekly' then next_date:=template.next_run_on+7;
  else
    next_month:=(date_trunc('month',template.next_run_on)+case template.frequency when 'monthly' then interval '1 month' when 'quarterly' then interval '3 months' when 'annually' then interval '1 year' end)::date;
    next_date:=next_month+least(anchor,extract(day from next_month+interval '1 month'-interval '1 day')::integer)-1;
  end if;
  update public.recurring_posting_templates set next_run_on=next_date,anchor_day=anchor,last_notified_on=template.next_run_on,
    status=case when template.end_on is not null and next_date>template.end_on then 'completed' else 'active' end
    where org_id=p_org_id and id=template.id;
  return jsonb_build_object('status',outcome,'id',occurrence_id,'due_on',template.next_run_on,'next_run_on',next_date);
end;
$$;
revoke all on function public.generate_books_recurring_occurrence(uuid,uuid,date) from public,anon,authenticated;
grant execute on function public.generate_books_recurring_occurrence(uuid,uuid,date) to service_role;
