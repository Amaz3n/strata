require("../scripts/register-ts-node-test");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveBusinessProfile,
  businessBrand,
} = require("../lib/business-profile");
const { getProjectPosture } = require("../lib/product-tier");
const {
  tradeJobSchema,
  tradeWorkSchema,
  crewConflicts,
} = require("../lib/trade/workspace");
const {
  buildProjectNavGroups,
} = require("../components/layout/project-nav-items");
const { buildTradeNavGroups } = require("../components/layout/trade-nav-items");
const project = "20000000-0000-4000-8000-000000000001";
const person = "20000000-0000-4000-8000-000000000002";
const profile = { kind: "trade", specialty: "Electrical" };

test("company experience remains independent of project posture and safe for existing orgs", () => {
  assert.equal(resolveBusinessProfile({}).kind, "builder");
  assert.equal(
    resolveBusinessProfile({ business_profile: { kind: "unknown" } }).kind,
    "builder",
  );
  assert.equal(businessBrand(profile, "commercial"), "Arc Trade");
  assert.equal(getProjectPosture("commercial", "residential"), "commercial");
  assert.equal(getProjectPosture("residential", "commercial"), "residential");
});
test("trade jobs validate money in cents, types, and date ranges", () => {
  assert.equal(
    tradeJobSchema.parse({
      name: "Electrical installation",
      total_contract_value_cents: 2500050,
    }).total_contract_value_cents,
    2500050,
  );
  for (const patch of [
    { total_contract_value_cents: -1 },
    { total_contract_value_cents: 10.5 },
    { total_contract_value_cents: 3e9 },
    { property_type: "trade" },
    { client_id: "foreign" },
    { start_date: "2026-10-03", end_date: "2026-10-01" },
  ]) {
    assert.equal(
      tradeJobSchema.safeParse({ name: "Electrical installation", ...patch })
        .success,
      false,
    );
  }
  assert.equal(
    tradeWorkSchema.safeParse({
      project_id: project,
      name: "Rough-in",
      start_date: "2026-02-30",
      end_date: "2026-03-01",
    }).success,
    false,
  );
});
test("crew conflicts include touching dates across jobs but exclude same-job, cancelled and unassigned work", () => {
  const base = {
    id: "a",
    project_id: project,
    assigned_to: person,
    name: "Rough",
    start_date: "2026-10-01",
    end_date: "2026-10-03",
    planned_hours: 24,
    status: "planned",
  };
  const overlapping = {
    ...base,
    id: "b",
    project_id: "another-job",
    start_date: "2026-10-03",
    end_date: "2026-10-05",
  };
  assert.deepEqual([...crewConflicts([base, overlapping])], ["a", "b"]);
  for (const patch of [
    { assigned_to: null },
    { assigned_to: "another-person" },
    { status: "cancelled" },
    { status: "completed" },
    { project_id: project },
    { start_date: "2026-10-04" },
  ]) {
    assert.equal(crewConflicts([base, { ...overlapping, ...patch }]).size, 0);
  }
});
test("trade navigation exposes complete workflows without production sales modules", () => {
  const items = buildTradeNavGroups("/trade/crew").flatMap(
    (group) => group.items,
  );
  assert.equal(
    items.find((item) => item.title === "Schedule & crew").isActive,
    true,
  );
  assert.ok(items.some((item) => item.url === "/pipeline"));
  assert.ok(items.some((item) => item.url === "/billing"));
  assert.ok(items.every((item) => item.requiredAny.length));
  const nav = buildProjectNavGroups({
    projectId: project,
    section: "time",
    businessProfile: profile,
  });
  const subs = nav.flatMap((group) =>
    group.items.flatMap((item) => item.items ?? []),
  );
  assert.ok(subs.some((item) => item.title === "Crew time"));
  assert.ok(subs.some((item) => item.title === "RFIs"));
  assert.ok(subs.some((item) => item.title === "Change Orders"));
  assert.ok(!subs.some((item) => item.title === "Bids"));
  const builder = buildProjectNavGroups({
    projectId: project,
    section: "time",
  }).flatMap((group) => group.items.flatMap((item) => item.items ?? []));
  assert.ok(builder.some((item) => item.title === "Bids"));
});
