alter table public.esign_templates add column if not exists archived_at timestamptz;
create table public.esign_bulk_reservations (
 org_id uuid not null references public.orgs(id),
 batch_id uuid not null,
 recipient_email text not null,
 template_id uuid not null references public.esign_templates(id),
 project_id uuid not null references public.projects(id),
 document_id uuid not null references public.documents(id) on delete restrict,
 created_by uuid references public.app_users(id),
 created_at timestamptz not null default now(),
 primary key(org_id,batch_id,recipient_email)
);
alter table public.esign_bulk_reservations enable row level security;
revoke all on public.esign_bulk_reservations from anon,authenticated;
grant all on public.esign_bulk_reservations to service_role;

create function public.reserve_esign_bulk_document(p_org_id uuid,p_user_id uuid,p_template_id uuid,p_project_id uuid,p_batch_id uuid,p_recipient jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare t public.esign_templates; reservation public.esign_bulk_reservations; d public.documents; email text; roles integer; f jsonb;
begin
 email := lower(btrim(p_recipient->>'email'));
 if email is null or email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Valid recipient email required'; end if;
 if not exists(select 1 from public.projects where id=p_project_id and org_id=p_org_id) then raise exception 'Project not found'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':'||p_batch_id::text||':'||email,0));
 select * into reservation from public.esign_bulk_reservations where org_id=p_org_id and batch_id=p_batch_id and recipient_email=email;
 if found then
   if reservation.template_id<>p_template_id or reservation.project_id<>p_project_id then raise exception 'Bulk batch recipient already belongs to another template or project'; end if;
   select * into d from public.documents where id=reservation.document_id and org_id=p_org_id;
   return to_jsonb(d);
 end if;
 select * into t from public.esign_templates where id=p_template_id and org_id=p_org_id and archived_at is null for share;
 if not found then raise exception 'Active template not found'; end if;
 if t.project_id is not null and t.project_id<>p_project_id then raise exception 'Template belongs to a different project'; end if;
 if not exists(select 1 from public.files where id=t.source_file_id and org_id=p_org_id) then raise exception 'Template source not found'; end if;
 if jsonb_array_length(t.fields)=0 then raise exception 'Template needs signing fields'; end if;
 select count(distinct role) into roles from (
   select coalesce(nullif(btrim(value->>'signer_role'),''),'signer_1') role from jsonb_array_elements(t.fields)
   union all
   select coalesce(nullif(btrim(value->>'signer_role'),''),'signer_1') role from jsonb_array_elements(t.recipients) where coalesce(value->>'role','signer')='signer'
 ) role_list;
 if roles>1 then raise exception 'Bulk sending supports one signer role per template'; end if;
 insert into public.documents(org_id,project_id,document_type,title,source_file_id,status,current_revision,metadata,created_by)
 values(p_org_id,p_project_id,t.document_type,coalesce(nullif(btrim(p_recipient->>'title'),''),t.name),t.source_file_id,'draft',1,
 jsonb_build_object('template_id',t.id,'template_name',t.name,'bulk_send_batch_id',p_batch_id,'bulk_send_recipient_email',email,
 'reminder_settings',t.reminder_settings,'draft_recipients',jsonb_build_array(jsonb_build_object('type','external_email','role','signer','signer_role','signer_1','sequence',1,'required',true,'email',email,'name',coalesce(nullif(btrim(p_recipient->>'name'),''),email)))),p_user_id)
 returning * into d;
 for f in select value from jsonb_array_elements(t.fields) loop
   insert into public.document_fields(org_id,document_id,revision,page_index,field_type,label,required,signer_role,x,y,w,h,sort_order,metadata)
   values(p_org_id,d.id,1,coalesce((f->>'page_index')::int,0),f->>'field_type',f->>'label',coalesce((f->>'required')::boolean,true),'signer_1',
   (f->>'x')::numeric,(f->>'y')::numeric,(f->>'w')::numeric,(f->>'h')::numeric,coalesce((f->>'sort_order')::int,0),coalesce(f->'metadata','{}'::jsonb));
 end loop;
 insert into public.esign_bulk_reservations(org_id,batch_id,recipient_email,template_id,project_id,document_id,created_by)
 values(p_org_id,p_batch_id,email,p_template_id,p_project_id,d.id,p_user_id);
 return to_jsonb(d);
end $$;
revoke all on function public.reserve_esign_bulk_document(uuid,uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_esign_bulk_document(uuid,uuid,uuid,uuid,uuid,jsonb) to service_role;
