-- RBAC Phase 5 (Wave 2): tighten RLS on indirect project-scoped tables
-- that inherit project scope via parent records.

begin;

drop policy if exists change_order_lines_access on public.change_order_lines;
create policy change_order_lines_access
on public.change_order_lines
for all
using (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.change_orders co
      where co.id = change_order_lines.change_order_id
        and co.org_id = change_order_lines.org_id
        and (
          co.project_id is null
          or is_project_member(co.project_id)
          or is_org_admin_member(change_order_lines.org_id)
        )
    )
  )
)
with check (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.change_orders co
      where co.id = change_order_lines.change_order_id
        and co.org_id = change_order_lines.org_id
        and (
          co.project_id is null
          or is_project_member(co.project_id)
          or is_org_admin_member(change_order_lines.org_id)
        )
    )
  )
);

drop policy if exists commitment_lines_access on public.commitment_lines;
create policy commitment_lines_access
on public.commitment_lines
for all
using (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.commitments c
      where c.id = commitment_lines.commitment_id
        and c.org_id = commitment_lines.org_id
        and (
          c.project_id is null
          or is_project_member(c.project_id)
          or is_org_admin_member(commitment_lines.org_id)
        )
    )
  )
)
with check (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.commitments c
      where c.id = commitment_lines.commitment_id
        and c.org_id = commitment_lines.org_id
        and (
          c.project_id is null
          or is_project_member(c.project_id)
          or is_org_admin_member(commitment_lines.org_id)
        )
    )
  )
);

drop policy if exists bill_lines_access on public.bill_lines;
create policy bill_lines_access
on public.bill_lines
for all
using (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.vendor_bills vb
      where vb.id = bill_lines.bill_id
        and vb.org_id = bill_lines.org_id
        and (
          vb.project_id is null
          or is_project_member(vb.project_id)
          or is_org_admin_member(bill_lines.org_id)
        )
    )
  )
)
with check (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.vendor_bills vb
      where vb.id = bill_lines.bill_id
        and vb.org_id = bill_lines.org_id
        and (
          vb.project_id is null
          or is_project_member(vb.project_id)
          or is_org_admin_member(bill_lines.org_id)
        )
    )
  )
);

drop policy if exists invoice_lines_access on public.invoice_lines;
create policy invoice_lines_access
on public.invoice_lines
for all
using (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.invoices i
      where i.id = invoice_lines.invoice_id
        and i.org_id = invoice_lines.org_id
        and (
          i.project_id is null
          or is_project_member(i.project_id)
          or is_org_admin_member(invoice_lines.org_id)
        )
    )
  )
)
with check (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.invoices i
      where i.id = invoice_lines.invoice_id
        and i.org_id = invoice_lines.org_id
        and (
          i.project_id is null
          or is_project_member(i.project_id)
          or is_org_admin_member(invoice_lines.org_id)
        )
    )
  )
);

drop policy if exists task_assignments_access on public.task_assignments;
create policy task_assignments_access
on public.task_assignments
for all
using (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.tasks t
      where t.id = task_assignments.task_id
        and t.org_id = task_assignments.org_id
        and (
          t.project_id is null
          or is_project_member(t.project_id)
          or is_org_admin_member(task_assignments.org_id)
        )
    )
  )
)
with check (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.tasks t
      where t.id = task_assignments.task_id
        and t.org_id = task_assignments.org_id
        and (
          t.project_id is null
          or is_project_member(t.project_id)
          or is_org_admin_member(task_assignments.org_id)
        )
    )
  )
);

drop policy if exists messages_access on public.messages;
create policy messages_access
on public.messages
for all
using (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.conversations c
      where c.id = messages.conversation_id
        and c.org_id = messages.org_id
        and (
          c.project_id is null
          or is_project_member(c.project_id)
          or is_org_admin_member(messages.org_id)
        )
    )
  )
)
with check (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.conversations c
      where c.id = messages.conversation_id
        and c.org_id = messages.org_id
        and (
          c.project_id is null
          or is_project_member(c.project_id)
          or is_org_admin_member(messages.org_id)
        )
    )
  )
);

drop policy if exists mentions_access on public.mentions;
create policy mentions_access
on public.mentions
for all
using (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where m.id = mentions.message_id
        and m.org_id = mentions.org_id
        and c.org_id = mentions.org_id
        and (
          c.project_id is null
          or is_project_member(c.project_id)
          or is_org_admin_member(mentions.org_id)
        )
    )
  )
)
with check (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where m.id = mentions.message_id
        and m.org_id = mentions.org_id
        and c.org_id = mentions.org_id
        and (
          c.project_id is null
          or is_project_member(c.project_id)
          or is_org_admin_member(mentions.org_id)
        )
    )
  )
);

drop policy if exists receipts_access on public.receipts;
create policy receipts_access
on public.receipts
for all
using (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.payments p
      where p.id = receipts.payment_id
        and p.org_id = receipts.org_id
        and (
          p.project_id is null
          or is_project_member(p.project_id)
          or is_org_admin_member(receipts.org_id)
        )
    )
  )
)
with check (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.payments p
      where p.id = receipts.payment_id
        and p.org_id = receipts.org_id
        and (
          p.project_id is null
          or is_project_member(p.project_id)
          or is_org_admin_member(receipts.org_id)
        )
    )
  )
);

drop policy if exists rfi_responses_access on public.rfi_responses;
create policy rfi_responses_access
on public.rfi_responses
for all
using (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.rfis r
      where r.id = rfi_responses.rfi_id
        and r.org_id = rfi_responses.org_id
        and (
          r.project_id is null
          or is_project_member(r.project_id)
          or is_org_admin_member(rfi_responses.org_id)
        )
    )
  )
)
with check (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.rfis r
      where r.id = rfi_responses.rfi_id
        and r.org_id = rfi_responses.org_id
        and (
          r.project_id is null
          or is_project_member(r.project_id)
          or is_org_admin_member(rfi_responses.org_id)
        )
    )
  )
);

commit;
