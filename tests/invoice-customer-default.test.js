require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {resolveInvoiceInitialCustomer:resolve}=require('../lib/invoices/composer-customer')
const contacts=[{id:'project',full_name:'Project client',email:'client@example.test'},{id:'chosen',full_name:'Explicit customer'}]
test('new invoices inherit the project customer including billing details',()=>assert.equal(resolve(contacts,{hasSeed:false,projectCustomerId:'project'}),contacts[0]))
test('an explicit billing target takes precedence over the project default',()=>assert.equal(resolve(contacts,{hasSeed:false,explicitId:'chosen',projectCustomerId:'project'}),contacts[1]))
test('existing drafts and duplicates never have their billing party replaced',()=>assert.equal(resolve(contacts,{hasSeed:true,projectCustomerId:'project'}),null))
test('unconfigured or missing project customers leave the searchable picker available',()=>{assert.equal(resolve(contacts,{hasSeed:false}),null);assert.equal(resolve(contacts,{hasSeed:false,projectCustomerId:'missing'}),null)})
