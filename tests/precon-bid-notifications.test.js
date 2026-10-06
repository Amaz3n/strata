require("../scripts/register-ts-node-test");
const test = require("node:test"), assert = require("node:assert/strict"), Module = require("node:module");
const { randomUUID } = require("node:crypto");
const packageId = randomUUID(), noticeId = randomUUID(), orgId = randomUUID();
const invite = (id, email) => ({ id, org_id: orgId, bid_package_id: packageId, invite_email: email, status: "sent" });
const invites = [invite(randomUUID(), "first@example.test"), invite(randomUUID(), "second@example.test")];
let jobs, failQueue, failRecipients, writes, unauthorized;
const db = { from(table) {
  let payload, operation, filters = [], contains;
  const query = {
    select() { return query; }, eq(k,v) { filters.push([k,v]); return query; }, in() { return query; }, limit() { return query; },
    contains(k,v) { contains = v; return query; },
    insert(value) { payload = value; operation = "insert"; return query; }, update() { operation = "update"; return query; },
    single() { return execute(true); }, maybeSingle() { return execute(true); },
    then(resolve,reject) { return Promise.resolve(execute(false)).then(resolve,reject); },
  };
  function execute(single) {
    if (operation) { writes.push({ table, operation, payload }); return { data: { id: randomUUID(), ...payload }, error: null }; }
    if (table === "bid_addenda") return { data: { id: noticeId, bid_package_id: packageId, org_id: orgId, number: 1, message: "Revised deadline" }, error: null };
    if (table === "bid_packages") return { data: { id: packageId, org_id: orgId, status: "open", title: "Electrical", scope_revision: 1 }, error: null };
    if (table === "orgs") return { data: { id: orgId, name: "Builder" }, error: null };
    if (table === "bid_invites") return single ? { data: invites.find(item => item.id === filters.find(([k])=>k === "id")?.[1]), error: null } : { data: invites, error: failRecipients ? { message: "Unavailable" } : null };
    if (table === "outbox") return { data: jobs.filter(job => job.payload.inviteId === contains.inviteId).map(() => ({id:1})), error: null };
    return { data: single ? null : [], error: null };
  }
  return query;
}};
const original = Module._load;
Module._load = function(name,...args) {
  if (name === "@/lib/services/context") return { requireOrgContext: async () => ({ supabase: db, orgId, userId: "actor" }) };
  if (name === "@/lib/services/permissions") return { requirePermission: async () => { if (unauthorized) throw new Error("Forbidden"); }, requireAnyPermission: async () => {} };
  if (name === "@/lib/supabase/server") return { createServiceSupabaseClient: () => db };
  if (name === "@/lib/services/outbox") return { enqueueOutboxJob: async job => { if (failQueue && job.payload.to === "second@example.test") return { enqueued: false, reason: "error" }; jobs.push(job); return { enqueued: true, id: jobs.length }; } };
  if (name === "@/lib/services/portal-credentials") return { hashBidToken: value => `hashed-${value}` };
  if (name === "@/lib/services/authorization") return { getDivisionScopedProjectIds: async () => null };
  if (name === "@/lib/services/production-bid-access") return original.call(this,name,...args);
  if (name.startsWith("@/lib/services/")) return {};
  return original.call(this,name,...args);
};
const { retryBidAddendumNotifications } = require("../lib/services/bids");
Module._load = original;
function reset() { jobs = []; failQueue = false; failRecipients = false; writes = []; unauthorized = false; }
test("a nonthrowing queue failure is reported per bidder; retry queues only missing notice", async () => {
  reset(); failQueue = true;
  const first = await retryBidAddendumNotifications({ addendumId: noticeId });
  assert.deepEqual(first.queued, ["first@example.test"]);
  assert.equal(first.failed.length, 1);
  assert.equal(first.failed[0].recipient, "second@example.test");
  failQueue = false;
  const retry = await retryBidAddendumNotifications({ addendumId: noticeId });
  assert.deepEqual(retry.queued, ["second@example.test"]);
  assert.deepEqual(retry.alreadyQueued, ["first@example.test"]);
  assert.equal(retry.failed.length, 0);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0].dedupeByPayloadKeys, ["kind", "addendumId", "inviteId"]);
  assert.ok(writes.every(write => write.table === "bid_access_tokens" && write.operation === "insert"), "retry neither creates addenda nor revokes old portal links");
});
test("failed recipient lookup does not claim there were no bidders", async () => {
  reset(); failRecipients = true;
  const result = await retryBidAddendumNotifications({ addendumId: noticeId });
  assert.equal(result.failed.length, 1);
  assert.equal(result.queued.length, 0);
  assert.equal(jobs.length, 0);
});
test("notification retries require project management permission", async () => {
  reset(); unauthorized = true;
  await assert.rejects(retryBidAddendumNotifications({ addendumId: noticeId }), /Forbidden/);
  assert.equal(writes.length, 0);
});
