-- Independent, read-only Arc Books review role.
--
-- This intentionally grants no export or mutation permissions: exports can
-- contain tax identifiers and supporting documents, while independent review
-- only requires the ledger and reporting surfaces.

set lock_timeout = '5s';
set statement_timeout = '30s';

begin;

insert into public.roles (key, label, scope, description) values (
  'org_books_reviewer',
  'Books reviewer',
  'org',
  'Independently reviews Arc Books ledgers and financial reports without changing or exporting accounting data.'
)
on conflict (key) do update set
  label = excluded.label,
  scope = excluded.scope,
  description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array['books.read', 'report.read']) p(permission_key)
where r.key = 'org_books_reviewer'
on conflict (role_id, permission_key) do nothing;

-- Keep the role least-privileged if a previous local iteration granted more.
delete from public.role_permissions rp
using public.roles r
where rp.role_id = r.id
  and r.key = 'org_books_reviewer'
  and rp.permission_key not in ('books.read', 'report.read');

commit;
