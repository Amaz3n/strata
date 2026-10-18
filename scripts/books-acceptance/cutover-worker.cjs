// One Open-WIP house commit in its own process, as the platform operator, so CUTOVER-01 can kill it partway as a
// crashed request would be.
const { createKit } = require("./scenario-kit.cjs")

const arg = (name) => process.argv[process.argv.indexOf(name) + 1]
const kit = createKit({ container: arg("--container"), apiUrl: arg("--api-url") })
const actor = JSON.parse(arg("--actor"))
require("./scenarios/cutover-01-resume.cjs").helpers.actAsSignedInUser()
const { commitImportBatch } = require("../../lib/services/imports")
kit.as(actor, () => commitImportBatch(arg("--batch"), { platformOrgId: actor.orgId })).catch((error) => { console.error(error.message); process.exitCode = 1 })
