require("../scripts/register-ts-node-test")
const test=require("node:test")
const assert=require("node:assert/strict")
const {sortReportRows}=require("../lib/reports/sort")
const {arAgingSummary}=require("../lib/reports/ar-aging-result")
test("sorting respects statement sections, totals, child rows and numeric values",()=>{
 const rows=[{key:"section",emphasis:"group",cells:{amount:0}},{key:"a",cells:{amount:2},children:[{key:"a1",cells:{amount:1}},{key:"a2",cells:{amount:10}}]},{key:"b",cells:{amount:100}},{key:"subtotal",emphasis:"subtotal",cells:{amount:102}},{key:"c",cells:{amount:5}},{key:"net",emphasis:"total",cells:{amount:107}}];
 const sorted=sortReportRows(rows,"amount",true);
 assert.deepEqual(sorted.map(r=>r.key),["section","b","a","subtotal","c","net"]);
 assert.deepEqual(sorted[2].children.map(r=>r.key),["a2","a1"]);
 assert.deepEqual(rows.map(r=>r.key),["section","a","b","subtotal","c","net"]);
})
test("sort uses displayed labels and keeps missing values last",()=>{
 const rows=[{key:"a",cells:{name:{value:"1",label:"Zebra"}}},{key:"b",cells:{name:{value:"2",label:"Alpha"}}},{key:"c",cells:{name:null}}];
 assert.deepEqual(sortReportRows(rows,"name").map(r=>r.key),["b","a","c"]);
 assert.deepEqual(sortReportRows(rows,"name",true).map(r=>r.key),["a","b","c"]);
})
const invoice=(id,customer,bucket,amount,extra={})=>({invoice_id:id,customer_id:customer,customer_name:"Same name",project_id:"p",project_name:"Project",invoice_number:id,bucket,open_balance_cents:amount,...extra});
test("AR client summary keeps same-name clients distinct and reconciles every bucket",()=>{
 const result=arAgingSummary({as_of:"2026-09-20",rows:[invoice("1","a","current",100),invoice("2","a","1_30",200),invoice("3","b","no_due_date",300),invoice("4","a","paid",0)]});
 const table=result.tables[0];assert.equal(table.rows.length,2);
 const a=table.rows.find(r=>r.key==="a");assert.equal(a.cells.total,300);assert.equal(a.cells.current,100);assert.equal(a.cells["1_30"],200);assert.equal(a.children.length,2);assert.equal(a.children[0].href,"/invoices/1");
 assert.equal(table.totals.total,600);assert.equal(table.totals.no_due_date,300);
 assert.equal(table.columns.filter(c=>c.aggregation==="sum").length,7);
})
test("AR project view includes unassigned balances and excludes settled invoices",()=>{
 const result=arAgingSummary({as_of:"2026-09-20",rows:[invoice("1","a","90_plus",100),invoice("2","b","31_60",50,{project_id:null,project_name:null}),invoice("3","a","paid",0)]},"project");
 assert.equal(result.tables[0].rows.length,2);assert.equal(result.tables[0].totals.total,150);assert.equal(result.tables[0].rows.find(r=>r.key==="unassigned").cells.total,50);
})
