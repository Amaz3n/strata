require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict')
const { resolveTaskMentions } = require('../lib/tasks/mentions')
const { taskInputSchema, taskUpdateSchema } = require('../lib/validation/tasks')
const people = [{id:'10000000-0000-0000-0000-000000000001',name:'Sam Builder'},{id:'10000000-0000-0000-0000-000000000002',name:'Alex (PM)'}]
test('mentions match daily-log full names, punctuation and @all without matching email addresses',()=>{
 assert.deepEqual(resolveTaskMentions('@Sam Builder, review this with @Alex (PM)!',people),people.map(p=>p.id))
 assert.deepEqual(resolveTaskMentions('@ALL please review @Sam Builder',people),people.map(p=>p.id))
 assert.deepEqual(resolveTaskMentions('email@Sam Builder or @Sam Builderton',people),[])
 assert.deepEqual(resolveTaskMentions('@Sam Builder @Sam Builder',people),[people[0].id])
 assert.deepEqual(resolveTaskMentions('@Former User',people),[])
})
test('assignment can be cleared and conflicting assignment requests are rejected',()=>{
 assert.equal(taskUpdateSchema.safeParse({clear_assignee:true}).success,true)
 assert.equal(taskUpdateSchema.safeParse({clear_assignee:true,assignee_id:people[0].id,assignee_kind:'user'}).success,false)
 assert.equal(taskInputSchema.safeParse({title:'Review plans',assignee_id:people[0].id}).success,false)
 assert.equal(taskInputSchema.safeParse({title:'Review plans',mentioned_user_ids:['not-an-id']}).success,false)
})
