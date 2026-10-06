require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const { customizeReport, parseLayout, tableLayoutSchema } = require("../lib/reports/builder")
const { reportToCsv } = require("../lib/reports/export-csv")
const { parseReportParams, periodRange } = require("../lib/reports/params")
const { statementResult } = require("../lib/reports/statement-result")
const source = { stats: [{ key: "total", label: "Total", value: "$300" }], tables: [{ key: "invoices", columns: [{ key: "name", header: "Customer" }, { key: "amount", header: "Amount", type: "money", aggregation: "sum" }, { key: "cost", header: "Cost", type: "money", aggregation: "sum" }, { key: "days", header: "Days late", type: "number" }], rows: [{ key: "a", cells: { name: "Acme", amount: 10000, cost: 5000, days: 4 } }, { key: "b", cells: { name: "Acme", amount: 20000, cost: 15000, days: 10 } }, { key: "c", cells: { name: "Beta", amount: 0, cost: 0, days: 1 } }], totals: { amount: 30000, cost: 20000 } }] }
const layout = table => ({ version: 1, tables: { invoices: tableLayoutSchema.parse(table) }, notes: "" })
test("grouping sums only declared measures and recomputes ratios", () => {
  const result = customizeReport(source, layout({ groupBy: "name", calculations: [{ key: "calc_ratio", label: "Ratio", left: "cost", right: "amount", operation: "ratio" }] }))
  assert.equal(result.tables[0].rows.length, 2)
  assert.equal(result.tables[0].rows[0].cells.amount, 30000)
  assert.equal(result.tables[0].rows[0].cells.calc_ratio, 20000 / 30000 * 100)
  assert.equal(result.tables[0].rows[1].cells.calc_ratio, null)
  assert.equal(result.tables[0].columns.some(c => c.key === "days"), false)
  assert.equal(result.tables[0].totals.calc_ratio, 20000 / 30000 * 100)
})
test("filters recompute totals and remove stale headline statistics", () => {
  const result = customizeReport(source, layout({ filterColumn: "name", filterValue: "beta" }))
  assert.equal(result.tables[0].rows.length, 1)
  assert.equal(result.tables[0].totals.amount, 0)
  assert.equal(result.stats, undefined)
  assert.equal(source.tables[0].rows.length, 3)
})
test("locked statements retain rows and accounting totals despite malicious filter or grouping", () => {
  const locked = { ...source, tables: [{ ...source.tables[0], locked: true }] }
  const result = customizeReport(locked, layout({ filterColumn: "name", filterValue: "beta", groupBy: "name" }))
  assert.deepEqual(result.tables[0].rows, source.tables[0].rows)
  assert.deepEqual(result.tables[0].totals, source.tables[0].totals)
})
test("custom labels, order, notes and calculations survive export", () => {
  const result = customizeReport(source, { ...layout({ columns: ["amount", "name"], labels: { amount: "Receivable" } }), notes: "Review with owner" })
  const csv = reportToCsv(result)
  assert.match(csv, /Review with owner/)
  assert.match(csv, /Receivable,Customer/)
  assert.match(csv, /10000,Acme/)
  assert.doesNotMatch(csv, /Days late/)
})
test("CSV prevents spreadsheet formula injection without corrupting negative numeric amounts", () => {
  const csv = reportToCsv({ tables: [{ key: "test", columns: [{ key: "a", header: "Name" }, { key: "b", header: "Value", type: "money" }], rows: [{ key: "1", cells: { a: '=HYPERLINK("evil")', b: -200 } }] }] })
  assert.match(csv, /'=HYPERLINK/)
  assert.match(csv, /,-200/)
})
test("invalid layouts fail closed and excessive configurations are bounded", () => {
  assert.throws(() => parseLayout('{"tables":{"a":{"calculations":[{"key":"unsafe"}]}}}'))
  assert.throws(() => parseLayout("x".repeat(40001)))
  assert.deepEqual(parseLayout(), { version: 1, tables: {}, notes: "" })
})
test("report dates support explicit custom ranges and relative last month", () => {
  assert.deepEqual(periodRange("range:2026-02-01:2026-02-28"), { from: "2026-02-01", to: "2026-02-28" })
  assert.deepEqual(periodRange("lastmonth", new Date("2026-01-19T12:00:00Z")), { from: "2025-12-01", to: "2025-12-31" })
  assert.equal(parseReportParams({ params: [{ key: "period", kind: "period" }] }, {}).period, "ytd")
  assert.equal(parseReportParams({ params: [] }, { _division: "", _layout: "{}" })._division, "")
})
const pnl = rows => ({ rows, byProject: [], byDimension: {}, revenueCents: rows.filter(r => r.accountType === "income").reduce((s,r)=>s+r.balanceCents,0), cogsCents: 0, expenseCents: 0, grossProfitCents: 100, netIncomeCents: 100 })
test("P&L retains prior-only accounts and exports the selected comparison", () => {
  const account = { accountId: "old", code: "4000", name: "Old revenue", accountType: "income", balanceCents: 200 }
  const result = statementResult("books-profit-loss", { startDate: "2026-01-01", endDate: "2026-06-30", profitLoss: pnl([]), priorProfitLoss: pnl([account]), monthlyProfitLoss: [], comparisonLabel: "Prior year", comparisonRange: {start:"2025-01-01",end:"2025-06-30"} })
  const row = result.tables[0].rows.find(r => r.key === "old")
  assert.equal(row.cells.amount, 0)
  assert.equal(row.cells.prior, 200)
  assert.equal(row.activities.prior.startDate, "2025-01-01")
  assert.equal(row.activities.prior.endDate, "2025-06-30")
  assert.equal(row.cells.variance, -200)
  assert.match(reportToCsv(result), /Prior year/)
})
test("monthly statement columns carry their own drilldown dates", () => {
  const account = { accountId: "a", code: "4000", name: "Revenue", accountType: "income", balanceCents: 100 }
  const result = statementResult("books-profit-loss", { startDate: "2026-01-01", endDate: "2026-02-28", profitLoss: pnl([account]), priorProfitLoss: null, monthlyProfitLoss: [{ startDate: "2026-02-01", endDate: "2026-02-28", label: "Feb", profitLoss: pnl([account]) }] }, "account", true)
  const row = result.tables[0].rows.find(r => r.key === "a")
  assert.equal(row.cells["2026-02-01"], 100)
  assert.equal(row.activities["2026-02-01"].startDate, "2026-02-01")
  assert.equal(result.tables[0].totals["2026-02-01"], 100)
})
test("statement presentation groups preserve standard totals and keep their label column first", () => {
  const statement = { tables: [{ ...source.tables[0], locked: true, rows: [{ key: "income", emphasis: "group", cells: { name: "Income" } }, ...source.tables[0].rows, { key: "total", emphasis: "subtotal", cells: { name: "Total", amount: 30000, cost: 20000 } }] }] }
  const result = customizeReport(statement, layout({ accountGroups: { a: "Recurring", b: "Recurring" }, rowLabels: { a: "Subscription" }, columns: ["amount", "name"] }))
  assert.equal(result.tables[0].columns[0].key, "name")
  assert.equal(result.tables[0].rows.find(r => r.key === "a").cells.name, "Subscription")
  assert.equal(result.tables[0].rows.find(r => r.key === "custom-subtotal:a").cells.amount, 30000)
  assert.equal(result.tables[0].rows.find(r => r.key === "total").cells.amount, 30000)
})
test("grouping distinguishes projects with the same display name", () => {
  const data = structuredClone(source)
  data.tables[0].rows[0].cells.name = { value: "Acme", href: "/projects/one" }
  data.tables[0].rows[1].cells.name = { value: "Acme", href: "/projects/two" }
  const result = customizeReport(data, layout({ groupBy: "name" }))
  assert.equal(result.tables[0].rows.length, 3)
  assert.equal(result.tables[0].rows[0].cells.name.href, "/projects/one")
})
test("secondary groups preserve both dimensions and correct totals", () => {
  const data = structuredClone(source)
  data.tables[0].columns.push({ key: "region", header: "Region" })
  data.tables[0].rows[0].cells.region = "North"
  data.tables[0].rows[1].cells.region = "South"
  const result = customizeReport(data, layout({ groupBy: "name", subgroupBy: "region" }))
  assert.equal(result.tables[0].rows.length, 3)
  assert.equal(result.tables[0].rows[0].cells.region, "North")
  assert.equal(result.tables[0].totals.amount, 30000)
})

test("multiple filters intersect and money comparisons use entered dollars", () => {
  const result = customizeReport(source, layout({ filters: [{column:"name",operator:"equals",value:"Acme"},{column:"amount",operator:"gt",value:"150"}] }));
  assert.deepEqual(result.tables[0].rows.map(r => r.key), ["b"]);
  assert.equal(result.tables[0].totals.amount, 20000);
  assert.equal(result.stats, undefined);
});
test("zero account suppression keeps authoritative statement totals", () => {
  const base = {tables:[{key:"invoices",locked:true,columns:source.tables[0].columns,rows:[...source.tables[0].rows,{key:"total",emphasis:"total",cells:{name:"Net income",amount:30000,cost:20000}}]}]};
  const result = customizeReport(base, layout({hideZero:true, filters:[{column:"amount",operator:"gt",value:"150"}]}));
  assert.deepEqual(result.tables[0].rows.map(r => r.key), ["a","b","total"]);
  assert.equal(result.tables[0].rows[2].cells.amount, 30000);
});
test("adding an available export column makes it visible in the report", () => {
  const base = {tables:[{...source.tables[0],columns:[...source.tables[0].columns,{key:"memo",header:"Memo",exportOnly:true}]}]};
  const result = customizeReport(base, layout({columns:["name","amount","memo"]}));
  assert.equal(result.tables[0].columns.find(c => c.key === "memo").exportOnly,false);
});
test("transaction reports preserve source links, dates, sign and additive totals", () => {
  const { accountActivityResult } = require("../lib/reports/activity-result");
  const result = accountActivityResult({account:{normalBalance:"credit"},startDate:"2026-02-01",endDate:"2026-02-28",openingBalanceCents:1000,closingBalanceCents:6000,periodDebitCents:2000,periodCreditCents:7000,rows:[{lineId:"line",entryDate:"2026-02-03",entryKind:"operating",memo:"Invoice",description:"Work",debitCents:2000,creditCents:7000,balanceCents:6000,source:{label:"Invoice",href:"/invoices/example"}}],truncated:false,rowCap:500});
  assert.equal(result.tables[0].rows[0].cells.amount,5000);
  assert.equal(result.tables[0].rows[0].cells.description.href,"/invoices/example");
  assert.equal(result.tables[0].totals.amount,5000);
  assert.equal(result.tables[0].columns.find(c => c.key === "balance").aggregation,undefined);
});
test("money equality filters round dollars to exact cents", () => {
  const base = {tables:[{...source.tables[0],rows:[{key:"cents",cells:{name:"Fee",amount:29,cost:0}}]}]};
  assert.equal(customizeReport(base, layout({filters:[{column:"amount",operator:"equals",value:"0.29"}]})).tables[0].rows.length,1);
});
