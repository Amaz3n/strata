require("../scripts/register-ts-node-test")
const assert=require("node:assert/strict"),test=require("node:test")
const { PGlite }=require("@electric-sql/pglite")
const {utcReportDateRange}=require("../lib/reports/date-range")
test("UTC report windows handle leap years and calendar transitions",()=>{
 for(const [start,end,next]of [["2024-02-29","2024-02-29","2024-03-01"],["2026-12-31","2026-12-31","2027-01-01"],["2026-03-08","2026-03-08","2026-03-09"]]){
  assert.deepEqual(utcReportDateRange(start,end),{startInclusive:`${start}T00:00:00.000Z`,endExclusive:`${next}T00:00:00.000Z`})
 }
 for(const date of ["2025-02-29","2026-04-31","2026-00-01","0000-01-01","2026-1-01","garbage"])assert.throws(()=>utcReportDateRange(date,date),/valid calendar dates/)
 assert.throws(()=>utcReportDateRange("2026-02-01","2026-01-31"),/on or before/)
})
test("exclusive report end retains the last PostgreSQL microsecond and excludes the following day",async(t)=>{
 const db=new PGlite();t.after(()=>db.close())
 const range=utcReportDateRange("2026-01-31","2026-01-31")
 const result=await db.query("select label from (values ('before', '2026-01-30T23:59:59.999999Z'::timestamptz),('first','2026-01-31T00:00:00Z'::timestamptz),('last','2026-01-31T23:59:59.999999Z'::timestamptz),('next','2026-02-01T00:00:00Z'::timestamptz)) v(label,approved_at) where approved_at >= $1::timestamptz and approved_at < $2::timestamptz order by approved_at",[range.startInclusive,range.endExclusive])
 assert.deepEqual(result.rows.map(row=>row.label),["first","last"])
})
