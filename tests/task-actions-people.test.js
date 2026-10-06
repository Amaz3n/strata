require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module')
const user='10000000-0000-0000-0000-000000000001',other='10000000-0000-0000-0000-000000000002',task='20000000-0000-0000-0000-000000000001'
let row,assignment,writes,peopleCalls
const db={from(table){let operation='read',payload,selection='';const q={select(value){selection=value;return q},eq(){return q},insert(value){operation='insert';payload=value;return q},update(value){operation='update';payload=value;return q},delete(){operation='delete';return q},single:async()=>run(),then(resolve,reject){return Promise.resolve(run()).then(resolve,reject)}};function run(){if(operation!=='read')writes.push({table,operation,payload});if(table==='tasks'){if(operation==='insert'||operation==='update')row={...row,...payload};return {data:selection==='id'?{id:task}:{...row,assignments:assignment?[{user_id:assignment,user:{id:assignment,full_name:'Sam Builder'}}]:[]},error:null}}if(table==='task_assignments'){if(operation==='delete')assignment=null;if(operation==='insert')assignment=payload.user_id;return {data:[],error:null}}return {data:[],error:null}}return q}}
const original=Module._load
const mocks={
 'next/cache':{revalidatePath:()=>{}},
 '@/lib/services/context':{requireOrgContext:async()=>({supabase:db,orgId:'org',userId:user})},
 '@/lib/services/task-people':{taskPeople:async()=>{peopleCalls++;return [{id:user,user_id:user,full_name:'Sam Builder'}]}},
 '@/lib/services/audit':{recordAudit:async()=>{}}, '@/lib/services/events':{recordEvent:async()=>{}}
}
Module._load=function(name,...args){return mocks[name]??original.call(this,name,...args)}
const {createMyTaskAction:create,updateMyTaskAction:update}=require('../app/(app)/tasks/actions')
test.after(()=>{Module._load=original});test.beforeEach(()=>{row={id:task,title:'Review plans',status:'todo',priority:'normal',metadata:{mentioned_user_ids:[user]},description:'@Sam Builder review',created_at:new Date().toISOString(),updated_at:new Date().toISOString()};assignment=user;writes=[];peopleCalls=0})
test('shared create persists assignment and resolves mentions from authorized text',async()=>{
 const result=await create({title:'Review plans',description:'@Sam Builder review',assignee_id:user,assignee_kind:'user',mentioned_user_ids:[other]})
 assert.equal(result.success,true);assert.equal(assignment,user);assert.deepEqual(row.metadata.mentioned_user_ids,[user])
})
test('shared update actually clears the saved assignee',async()=>{
 const result=await update(task,{clear_assignee:true});assert.equal(result.success,true);assert.equal(assignment,null)
 assert.ok(writes.some(w=>w.table==='task_assignments'&&w.operation==='delete'))
 assert.equal(writes.filter(w=>w.table==='task_assignments'&&w.operation==='insert').length,0)
})
test('inaccessible assignee is rejected before any mutation',async()=>{
 const result=await update(task,{assignee_id:other,assignee_kind:'user'});assert.equal(result.success,false);assert.equal(writes.length,0);assert.equal(assignment,user)
})
test('description removal clears mentions; unrelated completion preserves them',async()=>{
 assert.equal((await update(task,{status:'done'})).success,true);assert.deepEqual(row.metadata.mentioned_user_ids,[user]);assert.equal(peopleCalls,0)
 assert.equal((await update(task,{description:''})).success,true);assert.deepEqual(row.metadata.mentioned_user_ids,[])
})
