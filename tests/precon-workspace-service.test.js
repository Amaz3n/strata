require("../scripts/register-ts-node-test");
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { randomUUID } = require("node:crypto");
const orgId = randomUUID(),
  userId = randomUUID(),
  prospectId = randomUUID();
const rows = {
  prospects: [{ id: prospectId, org_id: orgId }],
  projects: [],
  precon_workspaces: [],
  precon_decisions: [],
  files: [],
};
let allowed = true,
  projectAllowed = true,
  gateCount = 0;
const audit = [],
  writes = [];
const service = {
  from(table) {
    let filters = [],
      payload,
      operation,
      head = false,
      multiple = false;
    const q = {
      select(_fields, options) {
        head = options?.head ?? false;
        return q;
      },
      eq(key, value) {
        filters.push([key, value]);
        return q;
      },
      is(key, value) {
        return q.eq(key, value);
      },
      in(key, values) {
        filters.push([key, values]);
        return q;
      },
      order() {
        multiple = true;
        return q;
      },
      limit() {
        return q;
      },
      insert(value) {
        payload = value;
        operation = "insert";
        return q;
      },
      update(value) {
        payload = value;
        operation = "update";
        return q;
      },
      then(resolve, reject) {
        return Promise.resolve(execute()).then(resolve, reject);
      },
      single() {
        return execute();
      },
      maybeSingle() {
        return execute();
      },
    };
    function execute() {
      const current = rows[table].find((row) =>
        filters.every(([key, value]) =>
          Array.isArray(value) ? value.includes(row[key]) : row[key] === value,
        ),
      );
      if (operation) {
        if (operation === "update" && !current)
          return { data: null, error: null };
        if (
          operation === "insert" &&
          table === "precon_workspaces" &&
          rows[table].some((row) => row.prospect_id === payload.prospect_id)
        )
          return { data: null, error: { code: "23505" } };
        const saved = { ...(current ?? { id: randomUUID() }), ...payload };
        if (operation === "insert") rows[table].push(saved);
        else Object.assign(current, saved);
        writes.push({ table, filters, payload });
        return { data: saved, error: null };
      }
      if (head) return { count: gateCount, error: null };
      return {
        data:
          table === "files" || multiple
            ? rows[table].filter((row) =>
                filters.every(([key, value]) =>
                  Array.isArray(value)
                    ? value.includes(row[key])
                    : row[key] === value,
                ),
              )
            : (current ?? null),
        error: null,
      };
    }
    return q;
  },
};
const stubs = {
  "@/lib/services/context": {
    requireOrgContext: async () => ({ supabase: service, orgId, userId }),
  },
  "@/lib/services/permissions": {
    requirePermission: async () => {
      if (!allowed) throw new Error("Forbidden");
    },
    requireAnyPermission: async () => {
      if (!allowed) throw new Error("Forbidden");
    },
  },
  "@/lib/services/authorization": {
    requireAuthorization: async () => {
      if (!allowed || !projectAllowed) throw new Error("Forbidden");
    },
  },
  "@/lib/supabase/server": { createServiceSupabaseClient: () => service },
  "@/lib/services/audit": { recordAudit: async (value) => audit.push(value) },
  "@/lib/services/events": { recordEvent: async () => {} },
};
const load = Module._load;
Module._load = function (request, ...args) {
  return stubs[request] ?? load.call(this, request, ...args);
};
let savePreconDecision,
  assertPreconDecisionGate,
  getPreconWorkspace;
try {
  ({
    savePreconDecision,
    assertPreconDecisionGate,
    getPreconWorkspace,
  } = require("../lib/services/precon-workspace"));
} finally {
  Module._load = load;
}
const { EMPTY_PRECON_BRIEF } = require("../lib/precon/workspace");

test("decision resolutions preserve actor and stale updates cannot overwrite them", async () => {
  const input = {
    title: "Owner finish selection",
    kind: "client_decision",
    owner_user_id: null,
    due_date: null,
    cost_impact_cents: null,
  };
  const { id } = await savePreconDecision(prospectId, input);
  await savePreconDecision(
    prospectId,
    { ...input, status: "resolved", resolution: "Owner confirmed finish A" },
    id,
    1,
  );
  await assert.rejects(savePreconDecision(prospectId, input, id, 1), /changed/);
  assert.equal(rows.precon_decisions[0].resolved_by, userId);
  assert.equal(rows.precon_decisions[0].resolution, "Owner confirmed finish A");
});

test("open agreement/start conditions fail closed until resolved", async () => {
  gateCount = 2;
  await assert.rejects(
    assertPreconDecisionGate(prospectId, "agreement"),
    /2 outstanding agreement/,
  );
  await assert.rejects(
    assertPreconDecisionGate(prospectId, "start"),
    /2 outstanding start/,
  );
  gateCount = 0;
  await assertPreconDecisionGate(prospectId, "agreement");
});

test("workspace reads default old JSON without writing or treating intake as saved brief facts", async () => {
  const freshId = randomUUID();
  rows.prospects.push({
    id: freshId,
    org_id: orgId,
    notes: "Unsaved intake scope",
    budget_range: "over_1m",
    timeline_preference: "asap",
  });
  const before = writes.length;
  const unsaved = await getPreconWorkspace(freshId);
  assert.equal(unsaved.version, 0);
  assert.equal(unsaved.brief.scope, "");
  assert.equal(unsaved.brief.target_budget_cents, null);
  assert.equal(unsaved.brief.target_start, null);

  const legacy = { ...EMPTY_PRECON_BRIEF, scope: "Saved scope" };
  delete legacy.pricing_path;
  delete legacy.direct_agreement_reason;
  rows.precon_workspaces.push({
    id: randomUUID(),
    org_id: orgId,
    prospect_id: freshId,
    version: 2,
    brief: legacy,
  });
  const loaded = await getPreconWorkspace(freshId);
  assert.equal(loaded.brief.pricing_path, "budget_review");
  assert.equal(loaded.brief.direct_agreement_reason, "");
  assert.equal(loaded.brief.scope, "Saved scope");
  assert.equal("pricing_path" in legacy, false);
  assert.equal(writes.length, before);
});

test("lost, won and delivery workspaces reject decision edits without writes", async () => {
  const prospect = rows.prospects[0];
  const project = { id: randomUUID(), org_id: orgId, prospect_id: prospectId, phase: "precon" };
  rows.projects.push(project);
  const before = writes.length;
  const oldStatus = prospect.status;
  const oldPhase = project.phase;
  try {
    for (const [status, phase] of [["lost", "precon"], ["won", "delivery"], ["pricing", "delivery"]]) {
      prospect.status = status;
      project.phase = phase;
      await assert.rejects(savePreconDecision(prospectId, { title: "New condition", kind: "client_decision", owner_user_id: null, due_date: null, cost_impact_cents: null }), /Reopen|delivery/);
    }
    assert.equal(writes.length, before);
  } finally {
    prospect.status = oldStatus;
    project.phase = oldPhase;
    rows.projects.splice(rows.projects.indexOf(project), 1);
  }
});
