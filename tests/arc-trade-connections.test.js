require("../scripts/register-ts-node-test");
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const original = Module._load;
const userId = "30000000-0000-4000-8000-000000000001";
const identityId = "30000000-0000-4000-8000-000000000002";
const grantId = "30000000-0000-4000-8000-000000000003";
let user, rows, writes, cookieWrites, allowed;
function reset() {
  user = {
    id: userId,
    email: "PILOT@example.test",
    email_confirmed_at: "2026-01-01",
  };
  allowed = true;
  writes = [];
  cookieWrites = [];
  rows = {
    external_identities: [
      {
        id: identityId,
        email: "pilot@example.test",
        status: "active",
        email_verified_at: "2026-01-01",
        paused_at: null,
        revoked_at: null,
      },
    ],
    external_identity_grants: [
      {
        id: grantId,
        identity_id: identityId,
        org_id: "builder",
        status: "active",
        paused_at: null,
        revoked_at: null,
        portal_access_token_id: "token",
        bid_access_token_id: null,
        org: { id: "builder", name: "Builder" },
        token: {
          id: "token",
          portal_type: "sub",
          token_encrypted: "encrypted",
          project: { id: "project", name: "Builder job", status: "active" },
        },
      },
    ],
  };
}
const service = {
  from(table) {
    const filters = [];
    let mutation;
    const execute = () => {
      if (mutation) {
        writes.push({ table, mutation });
        return { data: [], error: null };
      }
      return {
        data: (rows[table] ?? []).filter((row) => filters.every((f) => f(row))),
        error: null,
      };
    };
    const query = {
      select() {
        return query;
      },
      eq(key, value) {
        filters.push((row) => row[key] === value);
        return query;
      },
      is(key, value) {
        filters.push((row) => row[key] === value);
        return query;
      },
      not(key, op, value) {
        assert.equal(op, "is");
        filters.push((row) => row[key] !== value);
        return query;
      },
      update(value) {
        mutation = value;
        return query;
      },
      insert(value) {
        mutation = value;
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
Module._load = function (request, parent, isMain) {
  if (request === "@/lib/services/business-profile")
    return { requireTradeContext: async () => ({ userId, orgId: "trade" }) };
  if (request === "@/lib/services/permissions")
    return {
      requirePermission: async () => {
        if (!allowed) throw new Error("Forbidden");
      },
    };
  if (request === "@/lib/supabase/server")
    return {
      createServiceSupabaseClient: () => service,
      createServerSupabaseClient: async () => ({
        auth: { getUser: async () => ({ data: { user }, error: null }) },
      }),
    };
  if (request === "next/headers")
    return {
      cookies: async () => ({ set: (value) => cookieWrites.push(value) }),
    };
  if (request === "@/lib/services/portal-credentials")
    return {
      decryptPortalToken: (value) =>
        value === "encrypted" ? "portal-secret" : null,
      hashSessionToken: () => "hashed-session",
    };
  if (
    [
      "@/lib/services/mailer",
      "@/lib/services/context",
      "@/lib/services/audit",
      "@/lib/services/auth-rate-limit",
      "@/lib/services/events",
    ].includes(request)
  )
    return {};
  return original.call(this, request, parent, isMain);
};
const {
  getTradeBuilderWorkspace,
  openTradeBuilderConnection,
} = require("../lib/services/external-portal-auth");
test.after(() => {
  Module._load = original;
});
test.beforeEach(reset);

test("builder connections require matching confirmed login and a claimed verified identity", async () => {
  user.email_confirmed_at = null;
  assert.equal(await getTradeBuilderWorkspace(), null);
  user.email_confirmed_at = "2026-01-01";
  user.id = "different";
  assert.equal(await getTradeBuilderWorkspace(), null);
  user.id = userId;
  rows.external_identities[0].email_verified_at = null;
  assert.equal(await getTradeBuilderWorkspace(), null);
  rows.external_identities[0].email_verified_at = "2026-01-01";
  rows.external_identities[0].email = "someone-else@example.test";
  assert.equal(await getTradeBuilderWorkspace(), null);
  allowed = false;
  await assert.rejects(getTradeBuilderWorkspace(), /Forbidden/);
  assert.equal(writes.length, 0);
});
test("expired tokens and paused, revoked or foreign grants never mint sessions", async () => {
  const grant = rows.external_identity_grants[0];
  for (const patch of [
    { paused_at: "today" },
    { revoked_at: "today" },
    { identity_id: "foreign" },
    { status: "revoked" },
  ]) {
    const originalGrant = structuredClone(grant);
    Object.assign(grant, patch);
    await assert.rejects(
      openTradeBuilderConnection(grantId),
      /no longer available/,
    );
    Object.assign(grant, originalGrant);
  }
  grant.token.expires_at = "2020-01-01";
  await assert.rejects(
    openTradeBuilderConnection(grantId),
    /no longer available/,
  );
  assert.equal(writes.length, 0);
  assert.equal(cookieWrites.length, 0);
});
test("opening an exact live sub grant creates only that verified person's portal session", async () => {
  const workspace = await getTradeBuilderWorkspace();
  assert.equal(workspace.items.length, 1);
  await assert.rejects(
    openTradeBuilderConnection("30000000-0000-4000-8000-000000000099"),
    /no longer available/,
  );
  assert.deepEqual(await openTradeBuilderConnection(grantId), {
    href: "/s/portal-secret",
  });
  assert.equal(
    writes.find((w) => w.table === "external_identity_sessions").mutation
      .identity_id,
    identityId,
  );
  assert.equal(cookieWrites.length, 1);
  assert.equal(cookieWrites[0].httpOnly, true);
  assert.equal(
    writes.some((w) => "password_attempts" in w.mutation),
    false,
  );
});
