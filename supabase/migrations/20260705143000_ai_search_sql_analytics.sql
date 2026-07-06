-- AI search analytics: database-side grouped aggregates for the command-bar org copilot.
--
-- The application used to page source rows into Node and aggregate there. This
-- read-only RPC keeps totals authoritative in Postgres while still constraining
-- callers to an explicit entity/table whitelist.

create or replace function public.ai_search_analytics_aggregate(
  p_org_id uuid,
  p_entity_type text,
  p_group_by text default 'none',
  p_statuses text[] default null::text[],
  p_text_query text default null,
  p_project_id uuid default null,
  p_since timestamptz default null,
  p_limit integer default 50
) returns table(
  label text,
  row_count bigint,
  amount_cents bigint
)
language plpgsql
stable
security invoker
set search_path to 'public'
as $$
declare
  v_table text;
  v_status_field text;
  v_amount_field text;
  v_project_field text;
  v_created_field text;
  v_due_field text;
  v_search_fields text[];
  v_group_by text := coalesce(nullif(trim(p_group_by), ''), 'none');
  v_group_expr text;
  v_join_sql text := '';
  v_order_sql text;
  v_where_parts text[] := array['t.org_id = $1'];
  v_text_condition text;
  v_sql text;
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 120));
  v_search_pattern text := '%' || replace(coalesce(trim(p_text_query), ''), '%', '\%') || '%';
begin
  case p_entity_type
    when 'project' then
      v_table := 'projects';
      v_status_field := 'status';
      v_created_field := 'created_at';
      v_search_fields := array['name', 'description'];
    when 'task' then
      v_table := 'tasks';
      v_status_field := 'status';
      v_project_field := 'project_id';
      v_created_field := 'created_at';
      v_search_fields := array['title', 'description'];
    when 'file' then
      v_table := 'files';
      v_project_field := 'project_id';
      v_created_field := 'created_at';
      v_search_fields := array['file_name', 'description'];
    when 'invoice' then
      v_table := 'invoices';
      v_status_field := 'status';
      v_amount_field := 'total_cents';
      v_project_field := 'project_id';
      v_created_field := 'created_at';
      v_due_field := 'due_date';
      v_search_fields := array['title', 'invoice_number', 'notes'];
    when 'payment' then
      v_table := 'payments';
      v_status_field := 'status';
      v_amount_field := 'amount_cents';
      v_project_field := 'project_id';
      v_created_field := 'created_at';
      v_search_fields := array['reference', 'method'];
    when 'budget' then
      v_table := 'budgets';
      v_status_field := 'status';
      v_amount_field := 'total_cents';
      v_project_field := 'project_id';
      v_created_field := 'created_at';
      v_search_fields := array['status'];
    when 'estimate' then
      v_table := 'estimates';
      v_status_field := 'status';
      v_amount_field := 'total_cents';
      v_project_field := 'project_id';
      v_created_field := 'created_at';
      v_search_fields := array['title', 'status'];
    when 'commitment' then
      v_table := 'commitments';
      v_status_field := 'status';
      v_amount_field := 'total_cents';
      v_project_field := 'project_id';
      v_created_field := 'created_at';
      v_search_fields := array['title', 'external_reference'];
    when 'change_order' then
      v_table := 'change_orders';
      v_status_field := 'status';
      v_amount_field := 'total_cents';
      v_project_field := 'project_id';
      v_created_field := 'created_at';
      v_search_fields := array['title', 'description', 'reason', 'summary'];
    when 'contract' then
      v_table := 'contracts';
      v_status_field := 'status';
      v_amount_field := 'total_cents';
      v_project_field := 'project_id';
      v_created_field := 'created_at';
      v_search_fields := array['title', 'number', 'terms'];
    when 'proposal' then
      v_table := 'proposals';
      v_status_field := 'status';
      v_amount_field := 'total_cents';
      v_project_field := 'project_id';
      v_created_field := 'created_at';
      v_search_fields := array['title', 'number', 'summary', 'terms'];
    when 'rfi' then
      v_table := 'rfis';
      v_status_field := 'status';
      v_project_field := 'project_id';
      v_created_field := 'created_at';
      v_search_fields := array['subject', 'question', 'drawing_reference', 'spec_reference', 'location'];
    when 'submittal' then
      v_table := 'submittals';
      v_status_field := 'status';
      v_project_field := 'project_id';
      v_created_field := 'created_at';
      v_search_fields := array['title', 'description', 'spec_section'];
    when 'drawing_set' then
      v_table := 'drawing_sets';
      v_status_field := 'status';
      v_project_field := 'project_id';
      v_created_field := 'created_at';
      v_search_fields := array['title', 'description'];
    when 'daily_log' then
      v_table := 'daily_logs';
      v_project_field := 'project_id';
      v_created_field := 'created_at';
      v_search_fields := array['summary'];
    when 'punch_item' then
      v_table := 'punch_items';
      v_status_field := 'status';
      v_project_field := 'project_id';
      v_created_field := 'created_at';
      v_search_fields := array['title', 'description', 'location'];
    when 'schedule_item' then
      v_table := 'schedule_items';
      v_status_field := 'status';
      v_project_field := 'project_id';
      v_created_field := 'created_at';
      v_search_fields := array['name', 'phase', 'trade', 'location'];
    when 'photo' then
      v_table := 'photos';
      v_project_field := 'project_id';
      v_created_field := 'created_at';
      v_search_fields := array['tags'];
    else
      raise exception 'Unsupported AI analytics entity_type: %', p_entity_type using errcode = '22023';
  end case;

  if v_group_by = 'aging' and (p_entity_type <> 'invoice' or v_due_field is null) then
    v_group_by := 'none';
  elsif v_group_by = 'status' and v_status_field is null then
    v_group_by := 'none';
  elsif v_group_by = 'project' and v_project_field is null then
    v_group_by := 'none';
  elsif v_group_by = 'month' and v_created_field is null then
    v_group_by := 'none';
  elsif v_group_by not in ('none', 'status', 'project', 'month', 'aging') then
    v_group_by := 'none';
  end if;

  if p_project_id is not null then
    if p_entity_type = 'project' then
      v_where_parts := v_where_parts || 't.id = $2';
    elsif v_project_field is not null then
      v_where_parts := v_where_parts || format('t.%I = $2', v_project_field);
    end if;
  end if;

  if coalesce(array_length(p_statuses, 1), 0) > 0 and v_status_field is not null then
    v_where_parts := v_where_parts || format('t.%I::text = any($3)', v_status_field);
  end if;

  if p_since is not null and v_created_field is not null then
    v_where_parts := v_where_parts || format('t.%I >= $4', v_created_field);
  end if;

  if coalesce(trim(p_text_query), '') <> '' and coalesce(array_length(v_search_fields, 1), 0) > 0 then
    select string_agg(format('coalesce(t.%I::text, '''') ilike $6', field_name), ' or ')
      into v_text_condition
    from unnest(v_search_fields) as field_name;
    if v_text_condition is not null then
      v_where_parts := v_where_parts || ('(' || v_text_condition || ')');
    end if;
  end if;

  if v_group_by = 'status' then
    v_group_expr := format('coalesce(nullif(replace(t.%I::text, ''_'', '' ''), ''''), ''Unknown'')', v_status_field);
    v_order_sql := 'amount_cents desc, row_count desc, label asc';
  elsif v_group_by = 'project' then
    v_join_sql := format(' left join public.projects p on p.id = t.%I and p.org_id = $1', v_project_field);
    v_group_expr := 'coalesce(nullif(p.name, ''''), ''No project'')';
    v_order_sql := 'amount_cents desc, row_count desc, label asc';
  elsif v_group_by = 'month' then
    v_group_expr := format('coalesce(to_char(date_trunc(''month'', t.%I), ''YYYY-MM''), ''Unknown month'')', v_created_field);
    v_order_sql := 'label asc';
  elsif v_group_by = 'aging' then
    v_where_parts := v_where_parts || format(
      'coalesce(lower(t.%I::text), '''') <> all(array[''paid'', ''void'', ''voided'', ''cancelled'', ''canceled'', ''written_off'', ''refunded'', ''closed''])',
      v_status_field
    );
    v_where_parts := v_where_parts || format('t.%I is not null', v_due_field);
    v_group_expr := format(
      'case when t.%1$I >= current_date then ''Current'' when current_date - t.%1$I <= 30 then ''1-30'' when current_date - t.%1$I <= 60 then ''31-60'' when current_date - t.%1$I <= 90 then ''61-90'' else ''90+'' end',
      v_due_field
    );
    v_order_sql := 'case label when ''Current'' then 0 when ''1-30'' then 1 when ''31-60'' then 2 when ''61-90'' then 3 else 4 end';
  else
    v_group_expr := '''Total''';
    v_order_sql := 'label asc';
    v_limit := 1;
  end if;

  v_sql := format(
    'select %1$s::text as label, count(*)::bigint as row_count, %2$s as amount_cents from public.%3$I t%4$s where %5$s group by 1 order by %6$s limit $5',
    v_group_expr,
    case
      when v_amount_field is null then '0::bigint'
      else format('coalesce(sum(t.%I), 0)::bigint', v_amount_field)
    end,
    v_table,
    v_join_sql,
    array_to_string(v_where_parts, ' and '),
    v_order_sql
  );

  return query execute v_sql
    using p_org_id, p_project_id, p_statuses, p_since, v_limit, v_search_pattern;
end;
$$;

grant execute on function public.ai_search_analytics_aggregate(uuid, text, text, text[], text, uuid, timestamptz, integer) to authenticated;
grant execute on function public.ai_search_analytics_aggregate(uuid, text, text, text[], text, uuid, timestamptz, integer) to service_role;
