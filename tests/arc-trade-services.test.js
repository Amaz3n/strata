require("../scripts/register-ts-node-test");
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const original = Module._load;
const orgId = "30000000-0000-4000-8000-000000000001";
const userId = "30000000-0000-4000-8000-000000000002";
const projectId = "30000000-0000-4000-8000-000000000003";
const customerId = "30000000-0000-4000-8000-000000000004";
let allowed = true,
  projectAllowed = true,
  profile = { kind: "trade", specialty: "Electrical" };
let rows, calls, created, events, audits, concurrent, visibleIds, denied;
function reset() {
  rows = {
    contacts: [{ id: customerId, org_id: orgId }],
    projects: [{ id: projectId, org_id: orgId }],
    memberships: [{ org_id: orgId, user_id: userId, status: "active" }],
    org_settings: [
      { org_id: orgId, settings: { preserved: "keep me" }, updated_at: "old" },
    ],
  };
  calls = [];
  created = [];
  events = [];
  audits = [];
  concurrent = false;
  allowed = true;
  projectAllowed = true;
  visibleIds = [projectId];
  denied = new Set();
}
const supabase = {
  from(table) {
    const filters = [];
    const predicates = [];
    let cap = Infinity;
    let patch,
      inserting = false;
    const execute = () => {
      calls.push({ table, filters });
      if (patch && concurrent) rows.org_settings[0].updated_at = "concurrent";
      let matches = (rows[table] ?? []).filter(
        (row) =>
          filters.every(([key, value]) => row[key] === value) &&
          predicates.every((p) => p(row)),
      );
      if (inserting) {
        rows[table] = [...(rows[table] ?? []), patch];
        matches = [patch];
      } else if (patch) matches.forEach((row) => Object.assign(row, patch));
      return {
        data: structuredClone(matches.slice(0, cap)),
        count: matches.length,
        error: null,
      };
    };
    const query = {
      select() {
        return query;
      },
      eq(key, value) {
        filters.push([key, value]);
        return query;
      },
      in(key, values) {
        predicates.push((row) => values.includes(row[key]));
        return query;
      },
      not(key, op, values) {
        assert.equal(op, "in");
        predicates.push(
          (row) => !values.slice(1, -1).split(",").includes(row[key]),
        );
        return query;
      },
      gt(key, value) {
        predicates.push((row) => row[key] > value);
        return query;
      },
      order() {
        return query;
      },
      limit(value) {
        cap = value;
        return query;
      },
      update(value) {
        patch = value;
        return query;
      },
      insert(value) {
        patch = value;
        inserting = true;
        return query;
      },
      maybeSingle() {
        const r = execute();
        return Promise.resolve({ ...r, data: r.data[0] ?? null });
      },
      then(resolve) {
        return Promise.resolve(execute()).then(resolve);
      },
    };
    return query;
  },
};
const context = () => ({
  orgId,
  userId,
  supabase,
  productTier: "residential",
  profile,
});
Module._load = function (request, parent, isMain) {
  if (request === "@/lib/services/context")
    return { requireOrgContext: async () => context() };
  if (request === "@/lib/services/permissions")
    return {
      requirePermission: async () => {
        if (!allowed) throw new Error("Forbidden");
      },
      requireProjectPermission: async () => {
        if (!projectAllowed) throw new Error("Forbidden project");
      },
      hasPermission: async (key) => allowed && !denied.has(key),
      hasAnyPermission: async (keys) =>
        allowed && keys.some((key) => !denied.has(key)),
    };
  if (request === "@/lib/services/projects")
    return {
      resolveVisibleProjectIds: async () => visibleIds,
      createProject: async ({ input }) => {
        created.push(input);
        return { id: projectId };
      },
    };
  if (request === "@/lib/services/schedule")
    return {
      createScheduleItem: async ({ input }) => {
        created.push(input);
        return input;
      },
    };
  if (request === "@/lib/services/events")
    return { recordEvent: async (event) => events.push(event) };
  if (request === "@/lib/services/audit")
    return { recordAudit: async (audit) => audits.push(audit) };
  return original.call(this, request, parent, isMain);
};
const business = require("../lib/services/business-profile");
// Use the real profile persistence service and a trusted context for the job service.
const serviceLoader = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@/lib/services/business-profile")
    return { requireTradeContext: async () => context() };
  return serviceLoader.call(this, request, parent, isMain);
};
const {
  createTradeJob,
  scheduleTradeWork,
  getTradeWorkspace,
} = require("../lib/services/trade-workspace");
test.after(() => {
  Module._load = original;
});
test.beforeEach(reset);

test("workspace changes preserve unrelated settings, require admin permission, and reject concurrent writes", async () => {
  allowed = false;
  await assert.rejects(business.saveBusinessProfile(profile), /Forbidden/);
  assert.equal(calls.length, 0);
  allowed = true;
  await business.saveBusinessProfile(profile);
  assert.equal(rows.org_settings[0].settings.preserved, "keep me");
  assert.equal(rows.org_settings[0].settings.business_profile.kind, "trade");
  assert.equal(events.length, 1);
  assert.equal(audits.length, 1);
  concurrent = true;
  await assert.rejects(
    business.saveBusinessProfile({ kind: "builder" }),
    /changed/,
  );
  assert.equal(rows.org_settings[0].settings.business_profile.kind, "trade");
});
test("trade job creation rejects foreign customer IDs and retains private costing defaults", async () => {
  const input = {
    name: "Pilot electrical",
    client_id: customerId,
    total_contract_value_cents: 1250050,
    property_type: "commercial",
  };
  allowed = false;
  await assert.rejects(createTradeJob(input), /Forbidden/);
  allowed = true;
  rows.contacts[0].org_id = "foreign";
  await assert.rejects(createTradeJob(input), /directory/);
  assert.equal(created.length, 0);
  rows.contacts[0].org_id = orgId;
  await createTradeJob(input);
  assert.equal(created[0].open_book, false);
  assert.equal(created[0].total_contract_value_cents, 1250050);
  assert.equal(created[0].property_type, "commercial");
});
test("scheduling rejects foreign jobs, suspended crew, and missing project permission before mutation", async () => {
  const work = {
    project_id: projectId,
    name: "Rough-in",
    assigned_to: userId,
    start_date: "2026-10-02",
    end_date: "2026-10-03",
    planned_hours: 16,
  };
  projectAllowed = false;
  await assert.rejects(scheduleTradeWork(work), /Forbidden/);
  projectAllowed = true;
  rows.projects[0].org_id = "foreign";
  await assert.rejects(scheduleTradeWork(work), /company workspace/);
  rows.projects[0].org_id = orgId;
  rows.memberships[0].status = "suspended";
  await assert.rejects(scheduleTradeWork(work), /active member/);
  assert.equal(created.length, 0);
  rows.memberships[0].status = "active";
  await scheduleTradeWork(work);
  assert.equal(created[0].trade, "electrical");
  assert.equal(created[0].planned_hours, 16);
  assert.ok(
    calls.every(({ filters }) =>
      filters.some(([key, value]) => key === "org_id" && value === orgId),
    ),
  );
});

test("trade workspace reads only visible company jobs and does not fetch unauthorized office data", async () => {
  const job = {
    id: projectId,
    org_id: orgId,
    name: "Electrical",
    status: "active",
    phase: "delivery",
    description: null,
    start_date: null,
    end_date: null,
  };
  rows.projects = [
    job,
    { ...job, id: "unassigned" },
    { ...job, id: "foreign", org_id: "foreign" },
  ];
  const work = {
    id: "work",
    org_id: orgId,
    project_id: projectId,
    name: "Rough-in",
    status: "planned",
    start_date: null,
    end_date: null,
    assigned_to: null,
    planned_hours: null,
  };
  rows.schedule_items = [
    work,
    { ...work, id: "foreign-work", org_id: "foreign" },
    { ...work, id: "hidden-work", project_id: "unassigned" },
  ];
  rows.memberships[0].user = { full_name: "Crew", email: "crew@example.test" };
  rows.contacts[0] = {
    ...rows.contacts[0],
    full_name: "Customer",
    email: null,
  };
  const invoice = {
    id: "invoice",
    org_id: orgId,
    project_id: projectId,
    invoice_number: "INV-1",
    status: "sent",
    due_date: null,
    balance_due_cents: 1000,
    currency: "USD",
  };
  rows.invoices = [
    invoice,
    { ...invoice, id: "foreign-invoice", org_id: "foreign" },
    { ...invoice, id: "hidden-invoice", project_id: "unassigned" },
    { ...invoice, id: "draft", status: "draft" },
  ];
  const workspace = await getTradeWorkspace();
  assert.deepEqual(
    workspace.jobs.map((j) => j.id),
    [projectId],
  );
  assert.deepEqual(
    workspace.work.map((w) => w.id),
    ["work"],
  );
  assert.deepEqual(
    workspace.invoices.map((i) => i.id),
    ["invoice"],
  );
  calls = [];
  denied = new Set(["invoice.read", "directory.read", "schedule.read"]);
  const restricted = await getTradeWorkspace();
  assert.equal(restricted.invoices.length, 0);
  assert.equal(restricted.contacts.length, 0);
  assert.equal(restricted.work.length, 0);
  assert.ok(
    !calls.some((c) =>
      ["invoices", "contacts", "schedule_items", "memberships"].includes(
        c.table,
      ),
    ),
  );
  calls = [];
  visibleIds = [];
  assert.equal((await getTradeWorkspace()).jobs.length, 0);
  assert.ok(!calls.some((c) => c.table === "projects"));
});
