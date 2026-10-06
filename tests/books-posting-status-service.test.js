require('../scripts/register-ts-node-test');const test=require('node:test');const assert=require('node:assert/strict');const Module=require('node:module');
test('posting status respects project scope, org-wide overhead access and current receipt evidence',async()=>{
 const id='00000000-0000-4000-8000-000000000001';let denied=false,projectId='project',failure=null,updated='2026-10-01T00:00:00Z';const permissions=[];const queried=[];
 const service={from(table){queried.push(table);const filters=[];const q={select(){return q},eq(k,v){filters.push([k,v]);return q},in(){return q},neq(){return q},order(){return q},limit(){return q},single(){return q},maybeSingle(){return q},then(resolve){assert.ok(filters.some(([k,v])=>k==='org_id'&&v==='org'));let data=null;
 if(table==='invoices'||table==='project_expenses')data={id,project_id:projectId,updated_at:updated};
 if(table==='books_settings')data={workspace_enabled:true,arc_ledger_mode:'official'};
 if(table==='books_projection_receipts')data={source_observed_at:'2026-10-01T00:00:00Z',checked_at:'2026-10-01T01:00:00Z',journal:{status:'posted',entry_date:'2026-09-30'}};
 if(table==='accounting_reconciliation_items')data=failure;
 return Promise.resolve({data,error:null}).then(resolve)}};return q}};
 const original=Module._load;let load;
 try{Module._load=function(name,...args){
 if(name==='server-only')return {};
 if(name==='@/lib/services/context')return {requireOrgContext:async()=>({orgId:'org',userId:'user',supabase:service})};
 if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>service};
 if(name==='@/lib/services/authorization')return {requireAuthorization:async input=>{permissions.push(input);if(denied)throw new Error('Denied')}};
 if(name==='@/lib/services/books/access')return {requireBooksAuthorization:async input=>{permissions.push(input);if(denied)throw new Error('Denied')}};
 return original.call(this,name,...args);
 };load=require('../lib/services/books/posting-status').getBooksPostingStatus;}finally{Module._load=original}
 const input={sourceType:'invoice',sourceId:id};assert.equal((await load(input)).state,'posted');assert.equal(permissions[0].projectId,'project');assert.equal(permissions[0].permission,'invoice.read');
 updated='2026-10-02T00:00:00Z';assert.equal((await load(input)).state,'pending');failure={category:'projection_blocked_by_closed_period'};assert.equal((await load(input)).state,'blocked');
 denied=true;queried.length=0;await assert.rejects(load(input),/Denied/);assert.deepEqual(queried,['invoices']);
 denied=false;await load({sourceType:'expense',sourceId:id});assert.equal(permissions.at(-1).permission,'bill.read');assert.equal(permissions.at(-1).resourceType,'project_expense');
 projectId=null;await load(input);assert.equal(permissions.at(-1).permission,'books.read');
});
