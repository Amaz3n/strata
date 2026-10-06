const fs=require('node:fs')
const {setup,id}=require('./agreement-signing-database')
const {installCatalogRevision}=require('./agreement-catalog-database')
async function database(t,{withPrices=false,margin=!withPrices}={}){
 const f=await setup(t,false),db=f.db
 await db.exec('alter table communities add column org_id uuid,add column division_id uuid')
 await db.query('update communities set org_id=$1,division_id=$2',[f.org,f.division])
 await db.exec('create table selection_categories(id uuid primary key,org_id uuid,community_id uuid,parent_category_id uuid,is_archived boolean default false);create table selection_options(id uuid primary key,org_id uuid,category_id uuid references selection_categories(id),community_id uuid,is_archived boolean default false,is_available boolean default true)')
 const ddl=fs.readFileSync('supabase/migrations/20260718182717_option_catalog_design_studio.sql','utf8')
 for(const table of ['selection_packages','selection_package_items',...(withPrices ? ['selection_catalog_prices'] : [])])await db.exec(ddl.match(new RegExp(`create table public\\.${table} \\([\\s\\S]*?\\n\\);`))[0])
 for(let n=0;n<3;n++){
  await db.query('insert into selection_categories(id,org_id) values($1,$2)',[id(40+n),f.org])
  await db.query('insert into selection_options(id,org_id,category_id) values($1,$2,$3)',[id(50+n),f.org,id(40+n)])
 }
 await db.exec("insert into permissions(key) values('selections.catalog.manage')")
 await db.query("insert into role_permissions values($1,'selections.catalog.manage')",[f.role])
 if(margin){await db.exec("insert into permissions(key) values('financials.margin.read') on conflict do nothing");await db.query("insert into role_permissions values($1,'financials.margin.read')",[f.role])}
 if(withPrices){
  for(const name of ['selection_catalog_prices_option_key','selection_catalog_prices_package_key'])await db.exec(ddl.match(new RegExp(`create unique index ${name}[\\s\\S]*?;`))[0])
 }
 await installCatalogRevision(db)
 await db.exec(fs.readFileSync('supabase/migrations/20261004012839_catalog_package_publication.sql','utf8'))
 const request={id:null,communityId:null,name:'Kitchen package',description:null,imageUrl:null,priceCents:12345,costCents:5000,isAvailable:true,sortOrder:0,optionIds:[id(50),id(51)]}
 const publish=(patch={})=>db.query('select publish_catalog_package_contents($1,$2,$3,$4) receipt',[patch.org??f.org,patch.actor??f.actor,patch.key??id(90),JSON.stringify(patch.request??request)])
 const count=async table=>(await db.query(`select count(*)::int n from ${table}`)).rows[0].n
 const revision=async()=>(await db.query('select revision::text revision from agreement_catalog_revisions where org_id=$1',[f.org])).rows[0].revision
 return {...f,request,publish,count,revision}
}
module.exports={database,id}
