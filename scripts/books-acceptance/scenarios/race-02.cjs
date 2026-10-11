// RACE-02 — production races. Independent database sessions (two API requests, or two
// psql backends released together by a barrier; see sessions.cjs) contend on the same
// rule, closing, claim, home, publication or inter-company sale. Every outcome must be
// serial-equivalent or a clean refusal, with no duplicate money, home, claim or receipt.
// The cases run on the LOT-01 production builder and its chain, built on demand.
const AREAS = ["config", "sales", "starts", "release"]
// Releases and claims leave their own jobs behind (cancelled releases, parked notices). On this
// shared acceptance stack they would otherwise be claimed by the next case's workers or fail
// its org's outbox drain, so the queue is settled between cases (never during one).
const QUEUE = ["start_release", "start_release_trade_notice", "process_drawing_set", "trade_schedule_change_notice"]
const settleQueue = (kit) => kit.sql(`update public.outbox set status='completed' where status in ('pending','processing','failed') and job_type in (${QUEUE.map((type) => kit.q(type)).join(",")})`)
const subcases = {}
for (const area of AREAS) for (const [name, run] of Object.entries(require(`./lot-01-${area}.cjs`).subcases))
  if (name.startsWith("race-")) subcases[name] = async (kit, expected, check) => {
    settleQueue(kit)
    try { return await run(kit, expected, check) } finally { settleQueue(kit) }
  }

module.exports = { subcases }
