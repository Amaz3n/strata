require("../scripts/register-ts-node-test");
const test = require("node:test"), assert = require("node:assert/strict"), Module = require("node:module");
const { randomUUID } = require("node:crypto");

const orgId = randomUUID(), packageId = randomUUID();
let pkg, invites, writes, jobs, events;

function rowsFor(table, filters) {
  const value = (key) => filters.find(([k]) => k === key)?.[1];
  if (table === "bid_packages") return [pkg];
  if (table === "bid_invites") {
    return invites.filter((row) => (!value("id") || row.id === value("id")) && (!value("status") || row.status === value("status")));
  }
  if (table === "companies") return [{ id: value("id") }];
  if (table === "orgs") return [{ id: orgId, name: "Builder", logo_url: null, slug: "builder" }];
  return [];
}

const db = { from(table) {
  let operation, payload, filters = [], head = false;
  const query = {
    select(_columns, options) { head = !!options?.head; return query; },
    eq(k, v) { filters.push([k, v]); return query; },
    in() { return query; }, is() { return query; }, neq() { return query; }, order() { return query; }, limit() { return query; },
    insert(value) { operation = "insert"; payload = value; return query; },
    update(value) { operation = "update"; payload = value; return query; },
    delete() { operation = "delete"; return query; },
    single() { return execute(true); }, maybeSingle() { return execute(true); },
    then(resolve, reject) { return Promise.resolve(execute(false)).then(resolve, reject); },
  };
  function execute(single) {
    if (operation) {
      writes.push({ table, operation, payload, filters });
      if (operation === "update" && table === "bid_packages") { Object.assign(pkg, payload); return { data: { ...pkg }, error: null }; }
      if (operation === "update" && table === "bid_invites") {
        const row = invites.find((invite) => invite.id === filters.find(([k]) => k === "id")?.[1]);
        if (row) Object.assign(row, payload);
      }
      if (operation === "insert" && table === "bid_invites") {
        const row = { id: randomUUID(), company: { id: payload.company_id, name: "Sparks LLC", email: "bids@sparks.test" }, contact: null, ...payload };
        invites.push(row);
        return { data: row, error: null };
      }
      return { data: single ? { id: randomUUID(), ...payload } : null, error: null };
    }
    const rows = rowsFor(table, filters);
    if (head) return { data: null, count: table === "bid_scope_items" ? 0 : rows.length, error: null };
    return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
  }
  return query;
}};

const original = Module._load;
Module._load = function (name, ...args) {
  if (name === "@/lib/services/context") return { requireOrgContext: async () => ({ supabase: db, orgId, userId: "actor" }) };
  if (name === "@/lib/services/permissions") return { requirePermission: async () => {}, requireAnyPermission: async () => {} };
  if (name === "@/lib/supabase/server") return { createServiceSupabaseClient: () => db };
  if (name === "@/lib/services/outbox") return { enqueueOutboxJob: async (job) => { jobs.push(job); return { enqueued: true, id: jobs.length }; } };
  if (name === "@/lib/services/portal-credentials") return { hashBidToken: (value) => `hashed-${value}` };
  if (name === "@/lib/services/authorization") return { getDivisionScopedProjectIds: async () => null };
  if (name === "@/lib/services/events") return { recordEvent: async (event) => { events.push(event); } };
  if (name === "@/lib/services/audit") return { recordAudit: async () => {} };
  if (name === "@/lib/services/prequalification") return { getBidInvitePrequalificationWarnings: async () => new Map() };
  if (name === "@/lib/services/production-bid-access") return original.call(this, name, ...args);
  if (name.startsWith("@/lib/services/")) return {};
  return original.call(this, name, ...args);
};
const { bulkCreateBidInvites, sendBidPackage, removeBidInvite } = require("../lib/services/bids");
Module._load = original;

function reset(overrides = {}) {
  pkg = { id: packageId, org_id: orgId, project_id: null, prospect_id: null, community_id: null, house_plan_id: null, title: "Electrical", trade: "Electrical", mode: "simple", due_at: new Date(Date.now() + 86_400_000).toISOString(), status: "draft", ...overrides };
  invites = []; writes = []; jobs = []; events = [];
}

test("a draft package lines trades up without minting links or emailing", async () => {
  reset();
  const result = await bulkCreateBidInvites({ input: { bid_package_id: packageId, invites: [{ company_id: randomUUID() }], send_emails: true } });
  assert.equal(result.failed.length, 0);
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].status, "draft");
  assert.equal(result.emailsSent, 0);
  assert.equal(jobs.length, 0);
  assert.ok(!writes.some((write) => write.table === "bid_access_tokens"), "no access link for a lined-up trade");
});

test("an issued package still sends trades their link on invite", async () => {
  reset({ status: "open" });
  const result = await bulkCreateBidInvites({ input: { bid_package_id: packageId, invites: [{ company_id: randomUUID() }], send_emails: true } });
  assert.equal(result.created[0].status, "sent");
  assert.equal(result.emailsSent, 1);
  assert.equal(jobs[0].payload.kind, "invite");
});

test("sending refuses a package without a due date and changes nothing", async () => {
  reset({ due_at: null });
  invites.push({ id: randomUUID(), org_id: orgId, bid_package_id: packageId, company_id: randomUUID(), status: "draft" });
  await assert.rejects(sendBidPackage({ bidPackageId: packageId }), /Set a due date in the future before sending/);
  assert.equal(writes.length, 0);
  assert.equal(pkg.status, "draft");
});

test("sending refuses a tender with no scope lines and a package with no trades", async () => {
  reset({ mode: "tender" });
  invites.push({ id: randomUUID(), org_id: orgId, bid_package_id: packageId, company_id: randomUUID(), status: "draft" });
  await assert.rejects(sendBidPackage({ bidPackageId: packageId }), /Add at least one scope line before sending a tender/);
  reset();
  await assert.rejects(sendBidPackage({ bidPackageId: packageId }), /Add at least one trade before sending/);
  assert.equal(writes.length, 0);
});

test("sending opens the package, emails every lined-up trade and reports ones without email", async () => {
  reset();
  const withEmail = { id: randomUUID(), org_id: orgId, bid_package_id: packageId, company_id: randomUUID(), status: "draft", company: { id: "c1", name: "Sparks LLC", email: "bids@sparks.test" } };
  const noEmail = { id: randomUUID(), org_id: orgId, bid_package_id: packageId, company_id: randomUUID(), status: "draft", company: { id: "c2", name: "Quiet Co" } };
  invites.push(withEmail, noEmail);
  const result = await sendBidPackage({ bidPackageId: packageId });
  assert.equal(pkg.status, "open");
  assert.equal(result.sent, 1);
  assert.deepEqual(result.failed, [{ inviteId: noEmail.id, companyName: "Quiet Co", error: "No email on file — copy their link instead" }]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].payload.to, "bids@sparks.test");
  assert.equal(writes.filter((write) => write.table === "bid_access_tokens").length, 2, "both trades get a link");
  assert.ok(!writes.some((write) => write.table === "bid_access_tokens" && write.operation === "update"), "sending never revokes links");
  assert.equal(events.filter((event) => event.eventType === "bid_invite_sent").length, 2);
  assert.ok(events.some((event) => event.eventType === "bid_package_status_changed"));
  await assert.rejects(sendBidPackage({ bidPackageId: packageId }), /Only a draft bid package can be sent/);
});

test("only a trade that was never sent the package can be removed", async () => {
  reset();
  const sent = { id: randomUUID(), org_id: orgId, bid_package_id: packageId, company_id: randomUUID(), status: "sent" };
  const linedUp = { id: randomUUID(), org_id: orgId, bid_package_id: packageId, company_id: randomUUID(), status: "draft" };
  invites.push(sent, linedUp);
  await assert.rejects(removeBidInvite({ inviteId: sent.id }), /Only trades that haven't been sent the package can be removed/);
  assert.ok(!writes.some((write) => write.operation === "delete"));
  await removeBidInvite({ inviteId: linedUp.id });
  assert.equal(writes.filter((write) => write.operation === "delete").length, 1);
  assert.ok(events.some((event) => event.eventType === "bid_invite_removed"));
});
