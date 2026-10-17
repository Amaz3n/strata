// One scheduled job's run in its own process, through the same withCronRun wrapper the route uses, whose work never
// finishes; OPS-01 kills it as the runtime kills a function that outlives its duration.
const { createKit } = require("./scenario-kit.cjs")

const arg = (name) => process.argv[process.argv.indexOf(name) + 1]
createKit({ container: arg("--container"), apiUrl: arg("--api-url") })
const { withCronRun } = require("../../lib/services/job-runs")
// Authorized as the scheduler is: an unauthorized request is not a run and writes no row.
withCronRun(arg("--job"), () => new Promise(() => { setInterval(() => {}, 1000) }))({ headers: new Headers({ authorization: `Bearer ${process.env.CRON_SECRET}` }) }).catch((error) => { console.error(error.message); process.exitCode = 1 })
