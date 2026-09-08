-- Certificate, invoice and delivery job commit together. Existing snapshots remain readable.
alter table public.portal_access_tokens add column if not exists can_certify_pay_applications boolean not null default false;

-- Carry forward changed prior-period facts without discarding entered period deltas.
create or replace function public.rebase_pay_application_drafts(p_org_id uuid, p_contract_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if exists (
    select 1 from public.pay_application_lines l join public.pay_applications a on a.id=l.pay_application_id
      join public.prime_sov_lines s on s.id=l.prime_sov_line_id
    where a.org_id=p_org_id and a.contract_id=p_contract_id and a.status='draft'
      and s.stored_materials_cents+l.stored_materials_cents-coalesce((l.metadata->>'previous_stored_materials_cents')::bigint,0)<0
  ) then raise exception 'Later draft uses stored materials from this application. Adjust its materials before returning'; end if;
  update public.pay_application_lines l set
    previous_billed_cents=s.previous_billed_cents,
    stored_materials_cents=s.stored_materials_cents+l.stored_materials_cents-coalesce((l.metadata->>'previous_stored_materials_cents')::bigint,0),
    percent_complete=case when s.scheduled_value_cents>0 then round((s.previous_billed_cents+l.this_period_cents)*100.0/s.scheduled_value_cents,2) else 0 end,
    balance_to_finish_cents=s.scheduled_value_cents-s.previous_billed_cents-l.this_period_cents-s.stored_materials_cents-l.stored_materials_cents+coalesce((l.metadata->>'previous_stored_materials_cents')::bigint,0),
    metadata=l.metadata || jsonb_build_object('previous_stored_materials_cents',s.stored_materials_cents,'carry_forward_updated_at',now())
  from public.pay_applications a, public.prime_sov_lines s
  where a.id=l.pay_application_id and s.id=l.prime_sov_line_id and a.org_id=p_org_id
    and s.org_id=p_org_id and l.org_id=p_org_id and a.contract_id=p_contract_id and a.status='draft';
end; $$;
revoke all on function public.rebase_pay_application_drafts(uuid,uuid) from public, anon, authenticated;
grant execute on function public.rebase_pay_application_drafts(uuid,uuid) to service_role;

create or replace function public.post_pay_application(
  p_org_id uuid,
  p_pay_application_id uuid,
  p_invoice_id uuid,
  p_summary jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app record;
begin
  perform 1 from public.contracts where id = (select contract_id from public.pay_applications where id = p_pay_application_id and org_id = p_org_id) and org_id = p_org_id for update;
  select * into v_app
  from public.pay_applications
  where id = p_pay_application_id and org_id = p_org_id
  for update;

  if not found then
    raise exception 'Pay application not found';
  end if;
  if v_app.status <> 'draft' then
    raise exception 'Pay application has already been submitted';
  end if;

  if p_summary->'expected_lines' is null or exists (
    select 1 from jsonb_array_elements(p_summary->'expected_lines') x
    left join public.pay_application_lines l on l.id=(x->>'id')::uuid and l.org_id=p_org_id and l.pay_application_id=p_pay_application_id
    where l.id is null or not (to_jsonb(l) @> x)
  ) then raise exception 'Application changed during submission. Refresh and try again'; end if;
  if exists (select 1 from public.pay_applications where org_id = p_org_id and contract_id = v_app.contract_id and application_number < v_app.application_number and status = 'draft') then
    raise exception 'Submit the earlier returned application before this period';
  end if;
  if exists (select 1 from public.pay_applications where org_id = p_org_id and contract_id = v_app.contract_id
    and application_number < v_app.application_number and status in ('submitted', 'invoiced')) then
    raise exception 'Certify the earlier application before submitting this period';
  end if;
  if exists (
    select 1 from public.prime_sov_lines s full join
      (select * from public.pay_application_lines where org_id = p_org_id and pay_application_id = p_pay_application_id) l
      on l.prime_sov_line_id = s.id
    where (s.org_id = p_org_id and s.contract_id = v_app.contract_id) or l.id is not null
    group by s.id, l.id, s.scheduled_value_cents, l.scheduled_value_cents, s.previous_billed_cents, l.previous_billed_cents, s.stored_materials_cents, l.metadata
    having s.id is null or l.id is null or s.scheduled_value_cents <> l.scheduled_value_cents
      or s.previous_billed_cents <> l.previous_billed_cents
      or s.stored_materials_cents <> coalesce((l.metadata->>'previous_stored_materials_cents')::bigint,0)
  ) then raise exception 'Schedule of values changed. Reconcile this draft before submitting'; end if;
  if (select coalesce(sum(scheduled_value_cents),0) from public.pay_application_lines where org_id=p_org_id and pay_application_id=p_pay_application_id)
    <> (p_summary->>'contract_sum_to_date_cents')::bigint then
    raise exception 'Application scheduled values do not equal the contract sum';
  end if;
  if not exists (select 1 from public.invoices where id=p_invoice_id and org_id=p_org_id and project_id=v_app.project_id
    and source_pay_application_id=p_pay_application_id and status='draft'
    and total_cents=(p_summary->>'current_payment_due_cents')::bigint) then
    raise exception 'Application invoice does not reconcile to amount due';
  end if;
  update public.prime_sov_lines s
  set previous_billed_cents = s.previous_billed_cents + l.this_period_cents,
      stored_materials_cents = l.stored_materials_cents,
      retainage_held_cents = s.retainage_held_cents + l.retainage_cents
  from public.pay_application_lines l
  where l.pay_application_id = p_pay_application_id
    and l.org_id = p_org_id
    and s.id = l.prime_sov_line_id
    and s.org_id = p_org_id;

  update public.pay_applications
  set status = 'invoiced',
      invoice_id = p_invoice_id,
      submitted_at = now(),
      original_contract_sum_cents = coalesce((p_summary->>'original_contract_sum_cents')::bigint, 0),
      change_order_sum_cents = coalesce((p_summary->>'change_order_sum_cents')::bigint, 0),
      contract_sum_to_date_cents = coalesce((p_summary->>'contract_sum_to_date_cents')::bigint, 0),
      total_completed_stored_cents = coalesce((p_summary->>'total_completed_stored_cents')::bigint, 0),
      retainage_cents = coalesce((p_summary->>'retainage_cents')::bigint, 0),
      total_earned_less_retainage_cents = coalesce((p_summary->>'total_earned_less_retainage_cents')::bigint, 0),
      previous_certificates_cents = coalesce((p_summary->>'previous_certificates_cents')::bigint, 0),
      current_payment_due_cents = coalesce((p_summary->>'current_payment_due_cents')::bigint, 0),
      balance_to_finish_cents = coalesce((p_summary->>'balance_to_finish_cents')::bigint, 0),
      metadata = coalesce(v_app.metadata, '{}'::jsonb) || coalesce(p_summary->'metadata', '{}'::jsonb)
  where id = p_pay_application_id and org_id = p_org_id;

  perform public.rebase_pay_application_drafts(p_org_id, v_app.contract_id);
  return jsonb_build_object('pay_application_id', p_pay_application_id, 'invoice_id', p_invoice_id);
end;
$$;

revoke all on function public.post_pay_application(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.post_pay_application(uuid,uuid,uuid,jsonb) to service_role;

create or replace function public.void_pay_application(
  p_org_id uuid,
  p_pay_application_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app record;
  v_newer integer;
  v_invoice_status text;
  v_release_remaining integer;
  v_release_take integer;
  v_line record;
begin
  perform 1 from public.contracts where id = (select contract_id from public.pay_applications where id=p_pay_application_id and org_id=p_org_id) and org_id=p_org_id for update;
  select * into v_app
  from public.pay_applications
  where id = p_pay_application_id and org_id = p_org_id
  for update;

  if not found then
    raise exception 'Pay application not found';
  end if;

  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
    and not exists (
      select 1
      from public.memberships m
      where m.org_id = p_org_id
        and m.user_id = (select auth.uid())
        and m.status = 'active'
        and (
          exists (
            select 1 from public.membership_permission_overrides mpo
            where mpo.membership_id = m.id
              and mpo.permission_key = 'payapp.write'
              and mpo.effect = 'grant'
          )
          or exists (
            select 1 from public.role_permissions rp
            where rp.role_id = m.role_id
              and rp.permission_key = 'payapp.write'
          )
        )
        and not exists (
          select 1 from public.membership_permission_overrides mpo
          where mpo.membership_id = m.id
            and mpo.permission_key = 'payapp.write'
            and mpo.effect = 'deny'
        )
        and (
          coalesce(m.project_scope::text, 'all') <> 'assigned'
          or exists (
            select 1 from public.project_members pm
            where pm.org_id = p_org_id
              and pm.project_id = v_app.project_id
              and pm.user_id = (select auth.uid())
              and pm.status = 'active'
          )
        )
    ) then
    raise exception 'Missing permission: payapp.write' using errcode = '42501';
  end if;
  if v_app.status = 'void' then
    return jsonb_build_object('pay_application_id', p_pay_application_id, 'already_void', true);
  end if;
  if v_app.status not in ('submitted', 'approved', 'invoiced') then
    raise exception 'Only submitted pay applications can be voided; delete drafts instead';
  end if;

  select count(*) into v_newer
  from public.pay_applications
  where org_id = p_org_id
    and contract_id = v_app.contract_id
    and application_number > v_app.application_number
    and status not in ('void','draft');
  if v_newer > 0 then
    raise exception 'Only the latest pay application can be voided';
  end if;

  if v_app.invoice_id is not null then
    select status into v_invoice_status
    from public.invoices
    where id = v_app.invoice_id and org_id = p_org_id;
    if v_invoice_status in ('paid', 'partial') then
      raise exception 'The pay application invoice has payments and cannot be voided';
    end if;
  end if;

  if coalesce(v_app.metadata ->> 'type', '') = 'retainage_release' then
    v_release_remaining := coalesce((v_app.metadata ->> 'release_amount_cents')::integer, 0);
    if v_release_remaining <= 0 then
      raise exception 'Retainage release application is missing its release amount';
    end if;

    -- Releases allocate oldest SOV lines first. Because only the latest
    -- application may be voided, reversing newest allocations first restores
    -- the exact cumulative state that preceded this release.
    for v_line in
      select id, retainage_released_cents
      from public.prime_sov_lines
      where org_id = p_org_id
        and contract_id = v_app.contract_id
        and retainage_released_cents > 0
      order by line_number desc
      for update
    loop
      exit when v_release_remaining <= 0;
      v_release_take := least(v_release_remaining, v_line.retainage_released_cents);
      update public.prime_sov_lines
      set retainage_released_cents = retainage_released_cents - v_release_take
      where id = v_line.id and org_id = p_org_id;
      v_release_remaining := v_release_remaining - v_release_take;
    end loop;

    if v_release_remaining <> 0 then
      raise exception 'Retainage release allocation is inconsistent (% cents missing)', v_release_remaining;
    end if;
  else
    update public.prime_sov_lines s
    set previous_billed_cents = s.previous_billed_cents - l.this_period_cents,
        stored_materials_cents = coalesce((l.metadata->>'previous_stored_materials_cents')::integer, s.stored_materials_cents),
        retainage_held_cents = s.retainage_held_cents - l.retainage_cents
    from public.pay_application_lines l
    where l.pay_application_id = p_pay_application_id
      and l.org_id = p_org_id
      and s.id = l.prime_sov_line_id
      and s.org_id = p_org_id;
  end if;

  update public.pay_applications
  set status = 'void'
  where id = p_pay_application_id and org_id = p_org_id;

  perform public.rebase_pay_application_drafts(p_org_id, v_app.contract_id);
  return jsonb_build_object(
    'pay_application_id', p_pay_application_id,
    'invoice_id', v_app.invoice_id,
    'retainage_release_reversed', coalesce(v_app.metadata ->> 'type', '') = 'retainage_release'
  );
end;
$$;

revoke all on function public.void_pay_application(uuid, uuid) from public, anon, authenticated;
grant execute on function public.void_pay_application(uuid, uuid) to authenticated, service_role;


create or replace function public.return_pay_application_atomic(p_org_id uuid,p_pay_application_id uuid,p_actor_id uuid,p_return jsonb,p_revision integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare a public.pay_applications%rowtype; history jsonb;
begin
  perform 1 from public.contracts where id=(select contract_id from public.pay_applications where id=p_pay_application_id and org_id=p_org_id) and org_id=p_org_id for update;
  select * into a from public.pay_applications where id=p_pay_application_id and org_id=p_org_id for update;
  if a.id is null then raise exception 'Application not found'; end if;
  if a.status not in ('submitted','invoiced','approved') or coalesce((a.metadata->>'revision')::integer,0)<>p_revision then
    raise exception 'Application changed. Refresh before returning'; end if;
  if a.metadata->>'type'='retainage_release' then raise exception 'Void a retainage release instead'; end if;
  if length(trim(coalesce(p_return->>'reason','')))<3 then raise exception 'A return reason is required'; end if;
  -- Preserve every submitted revision, its document and original line facts.
  history=coalesce(a.metadata->'revision_history','[]'::jsonb)||jsonb_build_array(jsonb_build_object(
    'revision',p_revision,'invoice_id',a.invoice_id,'pdf_file_id',a.pdf_file_id,'report_snapshot',a.metadata->'report_snapshot',
    'certification',a.metadata->'certification','returned',p_return,
    'lines',(select jsonb_agg(to_jsonb(l)) from public.pay_application_lines l where l.pay_application_id=a.id and l.org_id=p_org_id)));
  perform public.void_pay_application(p_org_id,a.id);
  if a.invoice_id is not null then perform public.void_invoice_atomic(p_org_id,a.invoice_id,p_actor_id); end if;
  update public.invoice_lien_waivers set status='void' where org_id=p_org_id and invoice_id=a.invoice_id and status='pending_payment';
  update public.pay_applications set status='draft',invoice_id=null,submitted_at=null,approved_at=null,paid_at=null,pdf_file_id=null,
    metadata=(a.metadata-'certification'-'sent_to_owner'-'report_snapshot'-'overbilling_confirmed')||jsonb_build_object(
      'revision',p_revision+1,'returns',coalesce(a.metadata->'returns','[]'::jsonb)||jsonb_build_array(p_return),
      'revision_history',history,'previous_invoice_id',a.invoice_id,'current_retainage_cents',0)
    where id=a.id and org_id=p_org_id;
  return jsonb_build_object('pay_application_id',a.id,'revision',p_revision+1);
end; $$;
revoke all on function public.return_pay_application_atomic(uuid,uuid,uuid,jsonb,integer) from public,anon,authenticated;
grant execute on function public.return_pay_application_atomic(uuid,uuid,uuid,jsonb,integer) to service_role;

create or replace function public.certify_pay_application_atomic(p_org_id uuid,p_pay_application_id uuid,p_actor_id uuid,p_certification jsonb,p_recipients text[],p_revision integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  a public.pay_applications%rowtype;
  i public.invoices%rowtype;
  stamp timestamptz=now();
  requested bigint;
  deferred bigint;
  certified bigint;
  invoice_lines jsonb;
begin
  perform 1 from public.contracts where id=(select contract_id from public.pay_applications where id=p_pay_application_id and org_id=p_org_id) and org_id=p_org_id for update;
  select * into a from public.pay_applications where id=p_pay_application_id and org_id=p_org_id for update;
  if a.id is null then raise exception 'Application not found'; end if;
  if coalesce((a.metadata->>'revision')::integer,0)<>p_revision then raise exception 'Application revision changed'; end if;
  if a.status='approved' and a.metadata->'certification'=p_certification then return jsonb_build_object('invoice_id',a.invoice_id); end if;
  if a.status not in ('invoiced','submitted') then raise exception 'Application is not awaiting certification'; end if;
  requested := coalesce((p_certification->>'requested_amount_cents')::bigint, -1);
  deferred := coalesce((p_certification->>'deferred_amount_cents')::bigint, 0);
  certified := coalesce((p_certification->>'certified_amount_cents')::bigint, -1);
  if requested <> a.current_payment_due_cents or deferred < 0 or certified <= 0 or certified <> requested - deferred then
    raise exception 'Certificate does not reconcile to the application request'; end if;
  if jsonb_typeof(coalesce(p_certification->'deferrals','[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_certification->'deferrals','[]'::jsonb)) > 500 then
    raise exception 'Invalid certificate deferrals'; end if;
  if deferred <> coalesce((select sum((d->>'deferred_cents')::bigint)
      from jsonb_array_elements(coalesce(p_certification->'deferrals','[]'::jsonb)) d), 0) then
    raise exception 'Certificate deferrals do not reconcile'; end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_certification->'deferrals','[]'::jsonb)) d
    left join public.pay_application_lines l on l.pay_application_id=a.id and l.org_id=p_org_id
      and l.prime_sov_line_id=(d->>'prime_sov_line_id')::uuid
    where l.id is null or length(trim(coalesce(d->>'reason',''))) < 3
      or (d->>'deferred_cents')::bigint <= 0
      or (d->>'deferred_cents')::bigint > greatest(0,
        l.this_period_cents + l.stored_materials_cents
        - coalesce((l.metadata->>'previous_stored_materials_cents')::bigint,0)
        - l.retainage_cents + coalesce((l.metadata->>'previous_deferred_cents')::bigint,0))
  ) then raise exception 'Invalid line deferral'; end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_certification->'deferrals','[]'::jsonb)) d
    group by d->>'prime_sov_line_id' having count(*) > 1) then
    raise exception 'Enter one deferral per SOV line'; end if;
  if coalesce(cardinality(p_recipients),0)=0 then raise exception 'Owner email required'; end if;
  select * into i from public.invoices where id=a.invoice_id and org_id=p_org_id for update;
  if i.id is null or i.status<>'draft' then raise exception 'Application invoice must be draft'; end if;
  if i.total_cents<>a.current_payment_due_cents then raise exception 'Invoice does not reconcile to application'; end if;
  insert into public.invoice_lines(org_id,invoice_id,description,quantity,unit,unit_price_cents,sort_order,metadata)
  select p_org_id,i.id,'Deferred from certificate — '||coalesce(s.description,'SOV line'),1,'deferral',
    -(d->>'deferred_cents')::integer,(10000+row_number() over(order by s.line_number))::integer,
    jsonb_build_object('system_generated',true,'type','pay_application_deferral','prime_sov_line_id',d->>'prime_sov_line_id','reason',d->>'reason')
  from jsonb_array_elements(coalesce(p_certification->'deferrals','[]'::jsonb)) d
  join public.prime_sov_lines s on s.id=(d->>'prime_sov_line_id')::uuid and s.org_id=p_org_id;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id',l.id,'description',l.description,'quantity',l.quantity,'unit',l.unit,
      'unit_price_cents',l.unit_price_cents,'cost_code_id',l.cost_code_id,
      'budget_line_id',l.budget_line_id,'metadata',l.metadata) order by l.sort_order,l.id),'[]'::jsonb)
    into invoice_lines from public.invoice_lines l where l.org_id=p_org_id and l.invoice_id=i.id;
  update public.pay_applications set status='approved',approved_at=stamp,
    metadata=metadata||jsonb_build_object('certification',p_certification,'certification_recorded_by',p_actor_id)
    where id=a.id and org_id=p_org_id;
  update public.invoices set approval_status='approved',status='sent',client_visible=true,
    token=coalesce(i.token,gen_random_uuid()::text),sent_at=stamp,sent_to_emails=p_recipients,delivery_status='queued',
    subtotal_cents=certified,tax_cents=0,total_cents=certified,balance_due_cents=certified,
    issued_snapshot=jsonb_build_object('schema_version',1,'issued_at',stamp,'product_posture',i.product_posture,
      'invoice_number',i.invoice_number,'title',i.title,'issue_date',i.issue_date,'due_date',i.due_date,
      'customer_id',i.metadata->'customer_id','customer_name',i.metadata->'customer_name','recipients',to_jsonb(p_recipients),
      'source_type',i.source_type,'lines',invoice_lines,
      'totals',jsonb_build_object('subtotal_cents',certified,'tax_cents',0,'total_cents',certified,'balance_due_cents',certified))
    where id=i.id and org_id=p_org_id;
  insert into public.outbox(org_id,job_type,payload,run_at,dedupe_key)
    values(p_org_id,'finish_pay_application_certification',jsonb_build_object('pay_application_id',a.id),stamp+interval '2 minutes',
      'finish_pay_application_certification:'||a.id::text||':'||p_revision::text);
  return jsonb_build_object('pay_application_id',a.id,'invoice_id',i.id);
end; $$;
revoke all on function public.certify_pay_application_atomic(uuid,uuid,uuid,jsonb,text[],integer) from public,anon,authenticated;
grant execute on function public.certify_pay_application_atomic(uuid,uuid,uuid,jsonb,text[],integer) to service_role;

create or replace function public.save_pay_application_lines_atomic(p_org_id uuid,p_pay_application_id uuid,p_updates jsonb,p_expected_updated_at timestamptz,p_allow_overbilling boolean)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare a public.pay_applications%rowtype; entry jsonb; held bigint; overbilled boolean;
begin
  perform 1 from public.contracts where id=(select contract_id from public.pay_applications where id=p_pay_application_id and org_id=p_org_id) and org_id=p_org_id for update;
  select * into a from public.pay_applications where id=p_pay_application_id and org_id=p_org_id for update;
  if a.id is null or a.status<>'draft' then raise exception 'Only draft applications can be edited'; end if;
  if a.updated_at is distinct from p_expected_updated_at then raise exception 'Application changed. Refresh before saving'; end if;
  for entry in select * from jsonb_array_elements(p_updates) loop
    update public.pay_application_lines set this_period_cents=(entry->'values'->>'this_period_cents')::bigint,
      stored_materials_cents=(entry->'values'->>'stored_materials_cents')::bigint,
      percent_complete=(entry->'values'->>'percent_complete')::numeric,
      balance_to_finish_cents=(entry->'values'->>'balance_to_finish_cents')::bigint,
      retainage_cents=(entry->'values'->>'retainage_cents')::bigint,metadata=entry->'values'->'metadata'
      where id=(entry->>'lineId')::uuid and org_id=p_org_id and pay_application_id=p_pay_application_id;
    if not found then raise exception 'Application line not found'; end if;
  end loop;
  select coalesce(sum(retainage_cents),0),coalesce(bool_or(previous_billed_cents+this_period_cents+stored_materials_cents>scheduled_value_cents),false)
    into held,overbilled from public.pay_application_lines where org_id=p_org_id and pay_application_id=p_pay_application_id;
  if overbilled and not p_allow_overbilling then raise exception 'Confirm overbilling before saving'; end if;
  update public.pay_applications set updated_at=now(),metadata=metadata||jsonb_build_object('current_retainage_cents',held,'overbilled',overbilled,'overbilling_confirmed',overbilled and p_allow_overbilling)
    where id=p_pay_application_id and org_id=p_org_id;
  return jsonb_build_object('current_retainage_cents',held);
end; $$;
revoke all on function public.save_pay_application_lines_atomic(uuid,uuid,jsonb,timestamptz,boolean) from public,anon,authenticated;
grant execute on function public.save_pay_application_lines_atomic(uuid,uuid,jsonb,timestamptz,boolean) to service_role;
