-- Local migration only. Apply after review together with commercial pay-app hardening.
alter table public.contracts add column if not exists sov_revision bigint not null default 0;

create or replace function public.bump_prime_sov_revision()
returns trigger language plpgsql security invoker set search_path = public, pg_catalog as $$
begin
  update public.contracts set sov_revision = sov_revision + 1
  where id = case when TG_OP = 'DELETE' then OLD.contract_id else NEW.contract_id end;
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end;
$$;
drop trigger if exists prime_sov_revision on public.prime_sov_lines;
create trigger prime_sov_revision after insert or update or delete on public.prime_sov_lines
for each row execute function public.bump_prime_sov_revision();

create or replace function public.save_prime_sov_lines(
  p_org_id uuid, p_project_id uuid, p_contract_id uuid, p_expected_revision bigint, p_lines jsonb
) returns void language plpgsql security invoker set search_path = public, pg_catalog as $$
declare
  v_revision bigint;
  v_line jsonb;
  v_id uuid;
  v_ids uuid[];
  v_index integer := 0;
  v_old public.prime_sov_lines%rowtype;
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' and
    not public.has_org_permission(p_org_id, 'sov.write') then
    raise exception 'Insufficient permission to edit schedule of values';
  end if;
  select sov_revision into v_revision from public.contracts
  where id = p_contract_id and org_id = p_org_id and project_id = p_project_id for update;
  if not found then raise exception 'Billing contract not found'; end if;
  if p_expected_revision is null or p_expected_revision <> v_revision then
    raise exception 'The schedule of values changed. Reload before saving.';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 500 then
    raise exception 'Invalid schedule of values';
  end if;
  if exists (select 1 from public.pay_applications where contract_id = p_contract_id
    and org_id = p_org_id and status in ('draft', 'submitted')) then
    raise exception 'Finish or void the open pay application before changing its schedule of values';
  end if;
  select coalesce(array_agg((item->>'id')::uuid), '{}'::uuid[]) into v_ids
  from jsonb_array_elements(p_lines) item where item->>'id' is not null;
  if cardinality(v_ids) <> (select count(distinct id) from unnest(v_ids) id) then
    raise exception 'Duplicate SOV line';
  end if;
  if exists (select 1 from unnest(v_ids) as incoming(id) where not exists
    (select 1 from public.prime_sov_lines s where s.id = incoming.id and s.contract_id = p_contract_id and s.org_id = p_org_id)) then
    raise exception 'SOV line does not belong to this contract';
  end if;
  if exists (select 1 from public.prime_sov_lines where contract_id = p_contract_id and org_id = p_org_id
    and not (id = any(v_ids)) and (previous_billed_cents <> 0 or stored_materials_cents <> 0 or retainage_held_cents <> 0
      or exists (select 1 from public.pay_application_lines l where l.prime_sov_line_id = prime_sov_lines.id))) then
    raise exception 'An application references a removed line. Adjust it through a change order instead.';
  end if;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    if length(trim(coalesce(v_line->>'description', ''))) not between 1 and 500 then raise exception 'Description is required'; end if;
    if v_line->>'scheduled_value_cents' is null then raise exception 'Scheduled value is required'; end if;
    perform (v_line->>'scheduled_value_cents')::bigint;
    if v_line->>'budget_line_id' is not null and not exists (
      select 1 from public.budget_lines l join public.budgets b on b.id = l.budget_id
      where l.id = (v_line->>'budget_line_id')::uuid and l.org_id = p_org_id
        and b.org_id = p_org_id and b.project_id = p_project_id
    ) then raise exception 'Budget line does not belong to this project'; end if;
    if v_line->>'cost_code_id' is not null and not exists (
      select 1 from public.cost_codes where id = (v_line->>'cost_code_id')::uuid and org_id = p_org_id
    ) then raise exception 'Cost code does not belong to this organization'; end if;
    if v_line->>'id' is not null then
      select * into v_old from public.prime_sov_lines where id = (v_line->>'id')::uuid and org_id = p_org_id;
      if (v_old.previous_billed_cents <> 0 or v_old.stored_materials_cents <> 0 or v_old.retainage_held_cents <> 0)
        and v_old.scheduled_value_cents <> (v_line->>'scheduled_value_cents')::bigint then
        raise exception 'Billed scheduled values can only change through a change order';
      end if;
    end if;
  end loop;
  delete from public.prime_sov_lines where contract_id = p_contract_id and org_id = p_org_id and not (id = any(v_ids));
  -- Park lines on unique negative ordinals inside this transaction only.
  with parked as (select id, row_number() over(order by id) ordinal from public.prime_sov_lines
    where contract_id = p_contract_id and org_id = p_org_id)
  update public.prime_sov_lines s set line_number = -parked.ordinal from parked where s.id = parked.id;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_index := v_index + 1;
    v_id := coalesce((v_line->>'id')::uuid, gen_random_uuid());
    insert into public.prime_sov_lines
      (id, org_id, project_id, contract_id, description, cost_code_id, budget_line_id, scheduled_value_cents, retainage_percent_override, line_number, sort_order)
    values (v_id, p_org_id, p_project_id, p_contract_id, trim(v_line->>'description'), (v_line->>'cost_code_id')::uuid,
      (v_line->>'budget_line_id')::uuid, (v_line->>'scheduled_value_cents')::bigint,
      (v_line->>'retainage_percent_override')::numeric, v_index, v_index - 1)
    on conflict (id) do update set description = excluded.description, cost_code_id = excluded.cost_code_id,
      budget_line_id = excluded.budget_line_id, scheduled_value_cents = excluded.scheduled_value_cents,
      retainage_percent_override = excluded.retainage_percent_override, line_number = excluded.line_number, sort_order = excluded.sort_order;
  end loop;
end;
$$;
revoke all on function public.save_prime_sov_lines(uuid, uuid, uuid, bigint, jsonb) from public, anon;
grant execute on function public.save_prime_sov_lines(uuid, uuid, uuid, bigint, jsonb) to authenticated, service_role;
