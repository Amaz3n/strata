require("../scripts/register-ts-node-test");
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const original = Module._load;
let schedules, snapshots, sent, succeed, renders;
const config = {
  id: "config",
  org_id: "org",
  user_id: "user",
  name: "Monthly review",
  slug: "ops",
  scope: "org",
  project_id: null,
  params: { period: "lastmonth" },
  format: "pdf",
};
class Query {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.values = null;
    this.one = false;
    this.claim = false;
  }
  select() {
    return this;
  }
  eq(key, value) {
    this.filters.push([key, value]);
    return this;
  }
  lte() {
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  or() {
    this.claim = true;
    return this;
  }
  update(values) {
    this.values = values;
    return this;
  }
  maybeSingle() {
    this.one = true;
    return this;
  }
  single() {
    this.one = true;
    return this;
  }
  then(resolve, reject) {
    try {
      return Promise.resolve(this.run()).then(resolve, reject);
    } catch (e) {
      return Promise.reject(e).then(resolve, reject);
    }
  }
  run() {
    if (this.table === "orgs") return { data: { product_tier: "residential" } };
    let rows = this.table === "report_schedules" ? schedules : snapshots;
    rows = rows.filter((row) =>
      this.filters.every(([key, value]) =>
        key === "params->>_scheduleOccurrence"
          ? row.params?._scheduleOccurrence === value
          : row[key] === value,
      ),
    );
    if (this.claim)
      rows = rows.filter(
        (row) =>
          !row.delivery_claimed_until ||
          row.delivery_claimed_until <= new Date().toISOString(),
      );
    if (this.values) for (const row of rows) Object.assign(row, this.values);
    const copies = rows.map((row) => ({ ...row }));
    return { data: this.one ? (copies[0] ?? null) : copies, error: null };
  }
}
const db = { from: (table) => new Query(table) };
Module._load = function (name, ...args) {
  if (name === "@/lib/services/report-workspace")
    return {
      authorizeReport: async () => ({ definition }),
      evaluateReport: async (_, context) => ({
        context,
        result: {
          provenance: { generatedAt: "2026-01-01T00:00:00Z" },
          tables: [],
        },
      }),
    };
  if (name === "@/lib/services/context")
    return {
      requireOrgContext: async () => ({
        supabase: db,
        orgId: "org",
        userId: "user",
      }),
      runWithServiceOrgContext: async (_, work) => work(),
    };
  if (name === "@/lib/services/permissions")
    return {
      getUserPermissions: async () => ["report.read"],
      requirePermission: async () => {},
      requireAnyPermission: async () => {},
    };
  if (name === "@/lib/supabase/server")
    return { createServiceSupabaseClient: () => db };
  if (name === "@/lib/reports/registry")
    return {
      getReportDefinition: () => definition,
      supportsFormat: () => true,
    };
  if (name === "@/lib/pdfs/report")
    return {
      renderReportPdf: async () => Buffer.from(`pdf-generation-${++renders}`),
    };
  if (name === "@/lib/services/mailer")
    return {
      escapeHtml: (s) => s,
      getOrgSenderEmail: () => "reports@example.test",
      renderStandardEmailLayout: () => "<p>Report</p>",
      sendEmail: async (payload) => {
        sent.push(payload);
        return succeed;
      },
    };
  if (name === "@/lib/services/report-runs")
    return {
      recordReportRun: async (input) => {
        snapshots.push({
          org_id: "org",
          slug: input.slug,
          snapshot: input.result,
          title: input.title,
          params: input.context.params,
        });
        return "snapshot";
      },
    };
  return original.call(this, name, ...args);
};
const definition = {
  slug: "ops",
  scopes: ["org"],
  permissions: ["report.read"],
  params: [],
};
const {
  processDueReportSchedules,
  nextScheduledRun,
} = require("../lib/services/report-configs");
Module._load = original;
test.beforeEach(() => {
  schedules = [
    {
      id: "schedule",
      org_id: "org",
      saved_config_id: "config",
      created_by: "user",
      config,
      recipient_emails: ["owner@example.test"],
      is_active: true,
      next_run_at: "2026-01-01T13:00:00.000Z",
      cadence: "monthly",
      month_day: 1,
      send_hour_utc: 13,
      delivery_claimed_until: null,
    },
  ];
  snapshots = [];
  sent = [];
  succeed = true;
  renders = 0;
});
test("simultaneous workers cannot deliver the same occurrence twice", async () => {
  await Promise.all([processDueReportSchedules(), processDueReportSchedules()]);
  assert.equal(sent.length, 1);
  assert.equal(snapshots.length, 1);
  assert.equal(
    sent[0].idempotencyKey,
    "report-schedule/schedule:2026-01-01T13:00:00.000Z",
  );
  assert.equal(schedules[0].delivery_claimed_until, null);
});
test("failed delivery retries the same snapshot, attachment bytes and idempotency key", async () => {
  succeed = false;
  const failure = await processDueReportSchedules();
  assert.equal(failure[0].ok, false);
  assert.match(schedules[0].last_error, /not sent/);
  assert.equal(schedules[0].next_run_at, "2026-01-01T13:00:00.000Z");
  schedules[0].delivery_claimed_until = null; // simulate lease expiry
  succeed = true;
  const success = await processDueReportSchedules();
  assert.equal(success[0].ok, true);
  assert.equal(snapshots.length, 1);
  assert.equal(sent[0].idempotencyKey, sent[1].idempotencyKey);
  assert.deepEqual(sent[0].attachments, sent[1].attachments);
  assert.equal(schedules[0].delivery_payload, null);
});
test("monthly scheduling crosses year boundaries without replaying a past date", () => {
  assert.equal(
    nextScheduledRun(
      { cadence: "monthly", month_day: 1, send_hour_utc: 13 },
      new Date("2026-12-31T16:00:00Z"),
    ),
    "2027-01-01T13:00:00.000Z",
  );
});
