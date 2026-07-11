-- Atomic reject/void transitions. Voiding an approved transfer removes its
-- posted revision from adjusted-budget rollups without deleting audit history.
create or replace function public.close_budget_transfer(
  p_transfer_id uuid,
  p_actor_id uuid,
  p_status text,
  p_reason text
) returns void
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_transfer public.budget_transfers%rowtype;
begin
  select * into v_transfer from public.budget_transfers where id = p_transfer_id for update;
  if not found then raise exception 'Budget transfer not found'; end if;
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then
    if p_actor_id is distinct from (select auth.uid()) then raise exception 'Actor identity mismatch'; end if;
    if not public.has_org_permission(v_transfer.org_id, 'budget.approve') then raise exception 'Insufficient permission'; end if;
  end if;
  if p_status = 'rejected' and v_transfer.status <> 'pending_approval' then
    raise exception 'Only pending transfers can be rejected';
  end if;
  if p_status = 'void' and v_transfer.status not in ('pending_approval', 'approved') then
    raise exception 'Only pending or approved transfers can be voided';
  end if;
  if p_status not in ('rejected', 'void') then raise exception 'Invalid transfer status'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'A reason is required'; end if;

  if p_status = 'void' and v_transfer.budget_revision_id is not null then
    update public.budget_revisions set status = 'voided'
    where id = v_transfer.budget_revision_id and org_id = v_transfer.org_id;
  end if;
  update public.budget_transfers
  set status = p_status,
      metadata = metadata || jsonb_build_object(
        p_status || '_reason', trim(p_reason),
        p_status || '_by', p_actor_id,
        p_status || '_at', now()
      )
  where id = p_transfer_id;
end;
$$;

revoke all on function public.close_budget_transfer(uuid, uuid, text, text) from public, anon;
grant execute on function public.close_budget_transfer(uuid, uuid, text, text) to authenticated, service_role;

create or replace function public.post_budget_transfer(p_transfer_id uuid, p_actor_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_transfer public.budget_transfers%rowtype;
  v_revision_id uuid;
  v_line_count integer;
  v_line_total bigint;
begin
  select * into v_transfer from public.budget_transfers where id = p_transfer_id for update;
  if not found then raise exception 'Budget transfer not found'; end if;
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then
    if p_actor_id is distinct from (select auth.uid()) then raise exception 'Actor identity mismatch'; end if;
    if not public.has_org_permission(v_transfer.org_id, 'budget.approve') then raise exception 'Insufficient permission'; end if;
  end if;
  if v_transfer.status <> 'pending_approval' then raise exception 'Only pending budget transfers can be approved'; end if;
  if v_transfer.requested_by = p_actor_id then raise exception 'The requester cannot approve their own budget transfer'; end if;
  select count(*), coalesce(sum(amount_cents), 0) into v_line_count, v_line_total
  from public.budget_transfer_lines where transfer_id = p_transfer_id and org_id = v_transfer.org_id;
  if v_line_count < 2 or v_line_total <> 0 then raise exception 'Budget transfer lines must contain at least two lines and net to zero'; end if;
  insert into public.budget_revisions
    (org_id, project_id, revision_type, status, title, total_cents, posted_by, posted_at, metadata)
  values (v_transfer.org_id, v_transfer.project_id, 'transfer', 'posted',
    'Budget transfer #' || v_transfer.transfer_number || ': ' || v_transfer.reason,
    0, p_actor_id, now(), jsonb_build_object('budget_transfer_id', v_transfer.id))
  returning id into v_revision_id;
  insert into public.budget_revision_lines
    (org_id, budget_revision_id, cost_code_id, budget_line_id, description, amount_cents, sort_order, metadata)
  select v_transfer.org_id, v_revision_id, bl.cost_code_id, tl.budget_line_id,
    bl.description, tl.amount_cents, row_number() over (order by tl.id)::integer - 1,
    jsonb_build_object('budget_transfer_id', v_transfer.id)
  from public.budget_transfer_lines tl
  join public.budget_lines bl on bl.id = tl.budget_line_id and bl.org_id = v_transfer.org_id
  where tl.transfer_id = v_transfer.id and tl.org_id = v_transfer.org_id;
  update public.budget_transfers set status = 'approved', approved_by = p_actor_id,
    approved_at = now(), budget_revision_id = v_revision_id where id = v_transfer.id;
  return v_revision_id;
end;
$$;

revoke all on function public.post_budget_transfer(uuid, uuid) from public, anon;
grant execute on function public.post_budget_transfer(uuid, uuid) to authenticated, service_role;
