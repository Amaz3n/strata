-- Install with the authorized import completion code, before relying on Q04
-- recovery candidates. Q02/Q03 app mutation revocations stay in force.
-- The defaulted expectation argument has ONE guarded signature; no unguarded
-- older overload is installed. Financial row/child import semantics and posted facts are unchanged. Old app
-- rollback cannot complete new imports; never restore broad app grants to fix it.
set lock_timeout = '5s';
set statement_timeout = '120s';

create function public.complete_qbo_import_identity(p_org_id uuid,p_connection_id uuid,p_realm_id text,
  p_claim_token uuid,p_import_type text,p_external_id text,p_entity_type text,p_entity_id uuid,
  p_sync_token text,p_pushable boolean,p_metadata jsonb,p_expected_payment jsonb default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare namespace text; target text; mapping public.accounting_sync_records; valid boolean; key text; cash public.payments;
begin
  if p_claim_token is null or p_entity_id is null or p_pushable is null or jsonb_typeof(p_metadata) is distinct from 'object'
    or length(p_sync_token)>255 or pg_column_size(p_metadata)>4096 then raise exception 'Invalid import completion'; end if;
  perform 1 from public.accounting_connections where id=p_connection_id and org_id=p_org_id and provider='qbo'
    and status='active' and external_account_id=p_realm_id for update;
  if not found then raise exception 'Import company scope mismatch'; end if;
  perform 1 from public.accounting_import_claims where org_id=p_org_id and connection_id=p_connection_id and provider='qbo'
    and claim_token=p_claim_token and external_entity_type=p_import_type and external_id=p_external_id
    and status='processing' and lease_expires_at>clock_timestamp() for update;
  if not found then raise exception 'Import completion claim is no longer owned'; end if;
  namespace := case p_import_type when 'invoice' then 'Invoice' when 'expense' then 'Purchase' when 'expense_credit' then 'Purchase'
    when 'bill' then 'Bill' when 'vendor_credit' then 'VendorCredit' when 'payment' then 'Payment' when 'bill_payment' then 'BillPayment'
    when 'journal_entry' then 'JournalEntry' when 'client_deposit' then 'JournalEntry' end;
  target := case p_entity_type when 'invoice' then 'invoices' when 'project_expense' then 'project_expenses'
    when 'bill' then 'vendor_bills' when 'vendor_credit' then 'vendor_bills' when 'payment' then 'payments' when 'bill_payment' then 'payments' end;
  if namespace is null or target is null then raise exception 'Unsupported import completion identity'; end if;
  select * into mapping from public.accounting_sync_records s where s.org_id=p_org_id and s.connection_id=p_connection_id and s.provider='qbo'
    and s.entity_type=p_entity_type and s.entity_id=p_entity_id and s.external_id=p_external_id for update;
  if not found or coalesce(mapping.metadata->>'external_entity_type',case when mapping.metadata->>'source' in ('journal_entry','client_deposit') then 'JournalEntry'
    else case mapping.entity_type when 'invoice' then 'Invoice' when 'project_expense' then 'Purchase' when 'bill' then 'Bill' when 'vendor_credit' then 'VendorCredit' when 'payment' then 'Payment' when 'bill_payment' then 'BillPayment' end end) is distinct from namespace then raise exception 'Owned import mapping mismatch'; end if;
  execute format('select exists(select 1 from public.%I d where d.id=$1 and d.org_id=$2 and (d.project_id is null or exists(select 1 from public.projects p where p.id=d.project_id and p.org_id=$2)))',target)
    into valid using p_entity_id,p_org_id;
  if not valid then raise exception 'Import local target/project scope mismatch'; end if;
  if p_import_type in ('payment','bill_payment') and p_expected_payment is null then raise exception 'An expected payment identity is required'; end if;
  if p_expected_payment is not null then
    if target<>'payments' or jsonb_typeof(p_expected_payment) is distinct from 'object'
      or pg_column_size(p_expected_payment)>2048 or exists(select 1 from jsonb_object_keys(p_expected_payment) k where k not in ('provider_payment_id','amount_cents','invoice_id','bill_id'))
      or jsonb_typeof(p_expected_payment->'provider_payment_id') is distinct from 'string'
      or length(p_expected_payment->>'provider_payment_id')>512
      or jsonb_typeof(p_expected_payment->'amount_cents') is distinct from 'number'
      or coalesce(p_expected_payment->>'amount_cents','') !~ '^[0-9]+$' then raise exception 'Invalid expected import payment'; end if;
    if (p_expected_payment ? 'invoice_id' and jsonb_typeof(p_expected_payment->'invoice_id') is distinct from 'string')
      or (p_expected_payment ? 'bill_id' and jsonb_typeof(p_expected_payment->'bill_id') is distinct from 'string')
      or (p_import_type='payment' and (not (p_expected_payment ? 'invoice_id') or p_expected_payment ? 'bill_id'))
      or (p_import_type='bill_payment' and (not (p_expected_payment ? 'bill_id') or p_expected_payment ? 'invoice_id')) then raise exception 'Invalid expected payment target'; end if;
    select * into cash from public.payments where id=p_entity_id and org_id=p_org_id and provider='qbo' for update;
    if not found or cash.provider_payment_id is distinct from p_expected_payment->>'provider_payment_id'
      or cash.amount_cents is distinct from (p_expected_payment->>'amount_cents')::bigint
      or cash.invoice_id is distinct from (p_expected_payment->>'invoice_id')::uuid
      or cash.bill_id is distinct from (p_expected_payment->>'bill_id')::uuid then raise exception 'Existing payment amount or allocation changed'; end if;
    if (p_import_type='payment' and (cash.invoice_id is null or not exists(select 1 from public.invoices where id=cash.invoice_id and org_id=p_org_id)))
      or (p_import_type='bill_payment' and (cash.bill_id is null or not exists(select 1 from public.vendor_bills where id=cash.bill_id and org_id=p_org_id))) then raise exception 'Import payment target scope mismatch'; end if;
  end if;
  for key in select jsonb_object_keys(p_metadata) loop
    if key not in ('origin','ownership','source','qbo_purchase_line_id','qbo_je_line_id','qbo_payment_line_id')
      or jsonb_typeof(p_metadata->key) is distinct from 'string' or length(p_metadata->>key)>255
      or (mapping.metadata ? key and mapping.metadata->key is distinct from p_metadata->key) then raise exception 'Conflicting import metadata'; end if;
  end loop;
  if (p_metadata ? 'origin' and p_metadata->>'origin'<>'qbo_import') or (p_metadata ? 'ownership' and p_metadata->>'ownership'<>'inbound') then raise exception 'Invalid import ownership metadata'; end if;
  update public.accounting_sync_records set external_version=coalesce(p_sync_token,external_version),last_synced_at=clock_timestamp(),
    sync_direction='inbound',status='synced',error_message=null,pushable=p_pushable,
    metadata=coalesce(metadata,'{}')||p_metadata||jsonb_build_object('import_complete',true)
    where id=mapping.id and org_id=p_org_id and connection_id=p_connection_id;
  return true;
end $$;

create function public.resolve_qbo_import_events(p_org_id uuid,p_connection_id uuid,p_realm_id text,
  p_claim_token uuid,p_import_type text,p_external_id text,p_snapshot_timestamp text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare namespace text; mapping record; count integer:=0; target text; valid boolean; stamp text;
begin
  if p_claim_token is null then raise exception 'An owned import completion is required'; end if;
  perform 1 from public.accounting_connections where id=p_connection_id and org_id=p_org_id and provider='qbo'
    and status='active' and external_account_id=p_realm_id for update;
  if not found then raise exception 'Import company scope mismatch'; end if;
  perform 1 from public.accounting_import_claims where org_id=p_org_id and connection_id=p_connection_id and provider='qbo'
    and claim_token=p_claim_token and external_entity_type=p_import_type and external_id=p_external_id
    and status='processing' and lease_expires_at>clock_timestamp() for update;
  if not found then raise exception 'Import completion claim is no longer owned'; end if;
  namespace := case p_import_type when 'invoice' then 'Invoice' when 'expense' then 'Purchase' when 'expense_credit' then 'Purchase'
    when 'bill' then 'Bill' when 'vendor_credit' then 'VendorCredit' when 'payment' then 'Payment' when 'bill_payment' then 'BillPayment'
    when 'journal_entry' then 'JournalEntry' when 'client_deposit' then 'JournalEntry' end;
  if namespace is null then raise exception 'Unsupported import completion namespace'; end if;
  for mapping in select s.* from public.accounting_sync_records s where s.org_id=p_org_id and s.connection_id=p_connection_id and s.provider='qbo' and s.external_id=p_external_id
    and coalesce(s.metadata->>'external_entity_type',case when s.metadata->>'source' in ('journal_entry','client_deposit') then 'JournalEntry'
      else case s.entity_type when 'invoice' then 'Invoice' when 'project_expense' then 'Purchase' when 'bill' then 'Bill' when 'vendor_credit' then 'VendorCredit' when 'payment' then 'Payment' when 'bill_payment' then 'BillPayment' end end)=namespace for update loop
    count:=count+1;
    target := case mapping.entity_type when 'invoice' then 'invoices' when 'project_expense' then 'project_expenses'
      when 'bill' then 'vendor_bills' when 'vendor_credit' then 'vendor_bills' when 'payment' then 'payments' when 'bill_payment' then 'payments' end;
    if target is null or mapping.metadata->>'import_complete' is distinct from 'true' or mapping.status<>'synced' then raise exception 'Import has incomplete or unsupported mappings'; end if;
    execute format('select exists(select 1 from public.%I d where d.id=$1 and d.org_id=$2 and (d.project_id is null or exists(select 1 from public.projects p where p.id=d.project_id and p.org_id=$2)))',target)
      into valid using mapping.entity_id,p_org_id;
    if not valid then raise exception 'Import local target/project scope mismatch'; end if;
  end loop;
  if count=0 then raise exception 'Import has no completed identity'; end if;
  -- Snapshot absence/invalidity/equality cannot prove an event was consumed.
  -- Canonical UTC IDs preserve finer precision than the queue's millisecond time.
  if p_snapshot_timestamp is null or p_snapshot_timestamp !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3,}Z$' then return true; end if;
  begin
    if p_snapshot_timestamp::timestamptz>clock_timestamp()+interval '5 minutes' then return true; end if;
  exception when others then return true; end;
  update public.qbo_webhook_events e set process_status='reconciled',process_error=null,processed_at=clock_timestamp()
    where e.realm_id=p_realm_id and e.entity_name=namespace and e.entity_qbo_id=p_external_id and e.process_status in ('ignored','pending','error')
      and substring(e.event_id from '([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3,}Z)$') is not null
      and (left(substring(e.event_id from '([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3,}Z)$'),19)<left(p_snapshot_timestamp,19)
        or (left(substring(e.event_id from '([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3,}Z)$'),19)=left(p_snapshot_timestamp,19)
          and ('0.'||substring(e.event_id from '\.([0-9]+)Z$'))::numeric<('0.'||substring(p_snapshot_timestamp from '\.([0-9]+)Z$'))::numeric));
  return true;
end $$;
revoke all on function public.complete_qbo_import_identity(uuid,uuid,text,uuid,text,text,text,uuid,text,boolean,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.resolve_qbo_import_events(uuid,uuid,text,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.complete_qbo_import_identity(uuid,uuid,text,uuid,text,text,text,uuid,text,boolean,jsonb,jsonb),
  public.resolve_qbo_import_events(uuid,uuid,text,uuid,text,text,text) to service_role;
