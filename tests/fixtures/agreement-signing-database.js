const { migrationSql } = require("../support/migration-sql")
const fs=require('node:fs')
const {PGlite}=require('@electric-sql/pglite')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const ownership=migrationSql("20261003232615_purchase_agreement_signing_ownership")
async function setup(t,apply=true) {
 const db=new PGlite();t.after(()=>db.close())
 await db.exec(fs.readFileSync('tests/fixtures/esign-schema.sql','utf8'))
 await db.exec(`create table app_users(id uuid primary key,full_name text,email text);
 create table roles(id uuid primary key);create table permissions(key text primary key);
 create table role_permissions(role_id uuid references roles(id),permission_key text references permissions(key),primary key(role_id,permission_key));
 alter table memberships add column role_id uuid references roles(id),add column project_scope text default 'all',add column division_scope text default 'all';
 alter table contacts add column full_name text,add column email text;
 alter table files add column archived_at timestamptz,add column checksum text;
 create table projects(id uuid primary key,org_id uuid references orgs(id),division_id uuid);
 create table project_members(id uuid primary key default gen_random_uuid(),org_id uuid references orgs(id),project_id uuid references projects(id),user_id uuid references app_users(id),role_id uuid references roles(id),status text);
 create table platform_memberships(id uuid primary key default gen_random_uuid(),user_id uuid references app_users(id),role_id uuid references roles(id),status text,expires_at timestamptz);
 create table membership_permission_overrides(membership_id uuid references memberships(id),permission_key text,effect text,primary key(membership_id,permission_key));
 create table membership_divisions(membership_id uuid references memberships(id),division_id uuid,primary key(membership_id,division_id));
 create table contracts(id uuid primary key,org_id uuid,project_id uuid,contract_type text,status text,buyer_contact_id uuid,co_buyer_contact_id uuid,title text,number text,terms text,snapshot jsonb,total_cents bigint,currency text,effective_date date);
 create table audit_log(id bigint generated always as identity primary key,org_id uuid,actor_user_id uuid,action text,entity_type text,entity_id uuid,after_data jsonb,source text);`)
 // Use the authoritative lots DDL rather than inventing column aliases in a fixture.
 for(const table of ['communities','community_phases','divisions','lot_takedowns','house_plans','house_plan_versions','house_plan_elevations'])await db.exec(`create table public.${table}(id uuid primary key)`)
 const lotsDDL=fs.readFileSync('supabase/migrations/20260718161416_lots_and_takedowns.sql','utf8').match(/create table public\.lots \([\s\S]*?\n\);/)[0]
 const lotPlansDDL=fs.readFileSync('supabase/migrations/20260718170333_house_plans.sql','utf8').match(/alter table public\.lots[\s\S]*?;/)[0]
 await db.exec(lotsDDL);await db.exec(lotPlansDDL)
 for(const table of ['prospects','invoices'])await db.exec(`create table public.${table}(id uuid primary key)`)
 const reservationsDDL=fs.readFileSync('supabase/migrations/20260718220318_lot_reservations_incentives.sql','utf8').match(/create table public\.lot_reservations \([\s\S]*?\n\);/)[0]
 await db.exec(reservationsDDL)
 for(const path of ['supabase/migrations/20261003004822_esign_durable_execution_and_evidence.sql','supabase/migrations/20261003231638_esign_send_recipient_binding.sql'])await db.exec(fs.readFileSync(path,'utf8'))
 const org=id(1),home=id(2),actor=id(3),other=id(4),buyer=id(5),co=id(6),contract=id(7),file=id(8),role=id(9),division=id(10)
 await db.query('insert into orgs values($1)',[org]);await db.query("insert into app_users values($1,'Builder','builder@example.test'),($2,'Other','other@example.test')",[actor,other]);await db.query('insert into roles values($1)',[role])
 await db.exec("insert into permissions values('sales.manage'),('project.read'),('project.manage'),('org.admin'),('*'),('platform.org.access')")
 await db.query("insert into role_permissions values($1,'sales.manage'),($1,'project.read')",[role]);await db.query("insert into memberships(org_id,user_id,role_id,status) values($1,$2,$4,'active'),($1,$3,$4,'active')",[org,actor,other,role])
 await db.query('insert into projects values($1,$2,$3)',[home,org,division]);await db.query("insert into contacts values($1,$3,'Buyer','buyer@example.test'),($2,$3,'Co-buyer','co@example.test')",[buyer,co,org])
 await db.query("insert into contracts values($1,$2,$3,'purchase_agreement','draft',$4,$5,'Home agreement','PA-1','Original terms','{\"purchase_agreement\":{\"pricing\":{\"quoteHash\":\"reviewed\"}}}',30000000,'usd','2026-10-03')",[contract,org,home,buyer,co])
 await db.query("insert into files(id,org_id,project_id,file_name,storage_path,mime_type,size_bytes,visibility,source,checksum) values($1,$2,$3,'agreement.pdf','source.pdf','application/pdf',1234,'private','generated',$4)",[file,org,home,'a'.repeat(64)])
 const lot=id(11)
 await db.query('insert into communities values($1)',[id(13)])
 await db.query("insert into lots(id,org_id,community_id,project_id,lot_number,swing,status) values($1,$2,$4,$3,'1','left','assigned')",[lot,org,home,id(13)])
 await db.query("insert into lot_reservations(id,org_id,community_id,contract_id,lot_id,buyer_contact_id,co_buyer_contact_id,status) values($1,$2,$5,$3,$4,$6,$7,'reserved')",[id(12),org,contract,lot,id(13),buyer,co])
 await db.query("update contracts set snapshot=jsonb_set(snapshot,'{purchase_agreement,configuration}',$1)",[JSON.stringify({lot_id:lot,house_plan_id:null,house_plan_version_id:null,elevation_id:null,swing:'left'})])
 if(apply)await db.exec(ownership)
 const expected=(await db.query("select jsonb_build_object('id',id,'org_id',org_id,'project_id',project_id,'title',title,'number',number,'terms',terms,'snapshot',snapshot,'total_cents',total_cents,'currency',currency,'effective_date',effective_date,'buyer_contact_id',buyer_contact_id,'co_buyer_contact_id',co_buyer_contact_id) x from contracts")).rows[0].x
 const recipients=[{type:'contact',contact_id:buyer,user_id:null,name:'Buyer',email:'buyer@example.test',role:'signer',signer_role:'buyer',sequence:1,required:true},{type:'contact',contact_id:co,user_id:null,name:'Co-buyer',email:'co@example.test',role:'signer',signer_role:'co_buyer',sequence:1,required:true},{type:'internal_user',contact_id:null,user_id:actor,name:'Builder',email:'builder@example.test',role:'signer',signer_role:'builder',sequence:2,required:true}]
 const reserve=(patch={})=>db.query('select reserve_purchase_agreement_document($1,$2,$3,$4,$5,$6) document',[patch.org??org,contract,patch.actor??actor,JSON.stringify(patch.expected??expected),patch.probe?null:patch.file??file,patch.probe?null:JSON.stringify(patch.recipients??recipients)])
 const source={file_id:file,sha256:'a'.repeat(64),storage_path:'frozen.pdf',size_bytes:1234}
 const publish=(doc,patch={})=>db.query('select publish_purchase_agreement_document($1,$2,$3,$4) envelope',[org,doc,patch.actor??actor,JSON.stringify(patch.source??source)])
 return {db,org,home,actor,other,buyer,co,contract,file,role,division,expected,recipients,reserve,publish,source}
}

module.exports={setup,id,ownership}
