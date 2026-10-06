create role anon; create role authenticated; create role service_role bypassrls;
create function public.is_org_member(uuid) returns boolean language sql as $$select false$$;
create table bid_packages(id uuid primary key,org_id uuid not null,project_id uuid,status text,scope text,instructions text,mode text,updated_at timestamptz,unique(org_id,id));
create table bid_invites(id uuid primary key,org_id uuid,bid_package_id uuid,status text);
create table bid_scope_items(id uuid primary key,org_id uuid,bid_package_id uuid,item_type text,description text,quantity numeric);
create table bid_submissions(id uuid primary key default gen_random_uuid(),org_id uuid,bid_invite_id uuid,is_current boolean,status text,total_cents bigint,version integer,valid_until date,exclusions text,clarifications text,lead_time_days integer,duration_days integer,start_available_on date,unique(org_id,id));
create table bid_submission_items(id uuid primary key default gen_random_uuid(),bid_submission_id uuid,bid_scope_item_id uuid,response text,amount_cents bigint);
create table bid_addenda(id uuid primary key default gen_random_uuid(),org_id uuid,bid_package_id uuid,number integer);
create table bid_addendum_acknowledgements(bid_addendum_id uuid,bid_invite_id uuid);
create table commitments(id uuid primary key default gen_random_uuid(),org_id uuid,scope text,terms text,metadata jsonb);
create table bid_awards(id uuid primary key default gen_random_uuid(),org_id uuid,bid_package_id uuid,awarded_submission_id uuid,awarded_commitment_id uuid);
create function run_bid_award_conversion(p_org_id uuid,p_bid_submission_id uuid,p_awarded_by uuid,p_notes text,p_accepted_alternate_ids uuid[]) returns jsonb language plpgsql as $$
declare c uuid; p uuid;
begin
 select i.bid_package_id into p from bid_invites i join bid_submissions s on s.bid_invite_id=i.id where s.id=p_bid_submission_id;
 insert into commitments(org_id) values(p_org_id) returning id into c;
 insert into bid_awards(org_id,bid_package_id,awarded_submission_id,awarded_commitment_id) values(p_org_id,p,p_bid_submission_id,c);
 return jsonb_build_object('commitment_id',c);
end $$;
create function create_bid_submission_version(p_org_id uuid,p_bid_invite_id uuid,p_payload jsonb,p_items jsonb default '[]',p_source text default 'portal',p_entered_by uuid default null) returns jsonb language plpgsql as $$
declare s uuid;
begin
 update bid_submissions set is_current=false where bid_invite_id=p_bid_invite_id;
 insert into bid_submissions(org_id,bid_invite_id,is_current,status,total_cents,version,valid_until) values(p_org_id,p_bid_invite_id,true,'submitted',(p_payload->>'total_cents')::bigint,1,(p_payload->>'valid_until')::date) returning id into s;
 return jsonb_build_object('submission_id',s);
end $$;

create table projects(id uuid primary key,phase text);
create table contracts(id uuid primary key,org_id uuid,status text);
create table project_precon_handoffs(org_id uuid,project_id uuid,contract_id uuid,status text);
