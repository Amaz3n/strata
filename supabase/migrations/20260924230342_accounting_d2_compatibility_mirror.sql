-- Temporary compatibility maintenance. Neutral coding remains authoritative.
-- These D2 helpers are inert after the legacy columns are removed.
create function public.accounting_d2_mirror_coding() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare old_row jsonb:=to_jsonb(old); new_row jsonb:=to_jsonb(new); patch jsonb:='{}'; key text; field text; legacy_key text; coding_path text[]; previous text; current_value text; namespace_count integer;
begin
  if new.accounting_coding is not distinct from old.accounting_coding then return new; end if;
  select count(distinct connection_id) into namespace_count from accounting_sync_records
  where org_id=new.org_id and entity_id=new.id and provider='qbo'
    and entity_type=case when tg_table_name='project_expenses' then 'project_expense' when new_row#>>'{metadata,source}'='vendor_credit' then 'vendor_credit' else 'bill' end;
  if namespace_count<>1 then return new; end if;
  foreach key in array array['expense_account','payment_account','ap_account','vendor','class','transaction_type'] loop
    coding_path:=case key when 'vendor' then array['counterparty'] when 'class' then array['dimensions','class'] else array[key] end;
    foreach field in array (case when key='transaction_type' then array[''] else array['id','name'] end) loop
      legacy_key:='qbo_'||key||case when field='' then '' else '_'||field end;
      previous:=old.accounting_coding #>> (coding_path || case when field='' then array[]::text[] else array[field] end);
      current_value:=new.accounting_coding #>> (coding_path || case when field='' then array[]::text[] else array[field] end);
      if previous is distinct from current_value and new_row ? legacy_key then
        if field in ('id','') and nullif(old_row->>legacy_key,'') is not null and (old_row->>legacy_key) is distinct from previous then
          raise exception 'Existing compatibility disagreement requires reviewed repair';
        end if;
        patch:=patch || jsonb_build_object(legacy_key,current_value);
      end if;
    end loop;
  end loop;
  new:=jsonb_populate_record(new,patch);
  return new;
end $$;
revoke all on function public.accounting_d2_mirror_coding() from public,anon,authenticated;
create trigger accounting_d2_mirror_coding before update of accounting_coding on public.project_expenses for each row execute function public.accounting_d2_mirror_coding();
create trigger accounting_d2_mirror_coding before update of accounting_coding on public.vendor_bills for each row execute function public.accounting_d2_mirror_coding();

create function public.accounting_d2_refresh_archive() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare payload jsonb; previous jsonb;
begin
  if to_regclass('public.accounting_d2_legacy_archive') is null then return new; end if;
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into payload from jsonb_each(to_jsonb(new)) where key like 'qbo_%' and value<>'null'::jsonb;
  if payload='{}'::jsonb then return new; end if;
  select legacy_data into previous from accounting_d2_legacy_archive where org_id=new.org_id and source_table=tg_table_name and entity_id=new.id;
  if previous is not distinct from payload then return new; end if;
  insert into audit_log(org_id,action,entity_type,entity_id,before_data,after_data,source)
  values(new.org_id,'update','accounting_d2_legacy_archive',new.id,previous,payload,'accounting_d2_archive');
  insert into accounting_d2_legacy_archive(org_id,source_table,entity_id,legacy_data)
  values(new.org_id,tg_table_name,new.id,payload)
  on conflict(org_id,source_table,entity_id) do update set legacy_data=excluded.legacy_data,captured_at=now();
  return new;
end $$;
revoke all on function public.accounting_d2_refresh_archive() from public,anon,authenticated;
create trigger accounting_d2_refresh_archive after insert or update on public.invoices for each row execute function public.accounting_d2_refresh_archive();
create trigger accounting_d2_refresh_archive after insert or update on public.project_expenses for each row execute function public.accounting_d2_refresh_archive();
create trigger accounting_d2_refresh_archive after insert or update on public.vendor_bills for each row execute function public.accounting_d2_refresh_archive();
create trigger accounting_d2_refresh_archive after insert or update on public.projects for each row execute function public.accounting_d2_refresh_archive();
create trigger accounting_d2_refresh_archive after insert or update on public.companies for each row execute function public.accounting_d2_refresh_archive();
