// One ordinary projection run for one organization in its own process, so CAP-01
// can kill it partway as a crashed worker would be.
const { createKit } = require("./scenario-kit.cjs")

const arg = (name) => process.argv[process.argv.indexOf(name) + 1]
const kit = createKit({ container: arg("--container"), apiUrl: arg("--api-url") })
const { projectJournal } = require("../../lib/services/books/projector")
kit.service(() => projectJournal(arg("--org"))).catch((error) => { console.error(error.message); process.exitCode = 1 })
