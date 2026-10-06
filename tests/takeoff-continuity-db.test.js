const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
let PGlite;
try {
  ({ PGlite } = require(
    process.env.ARC_TEST_PGLITE_MODULE || "@electric-sql/pglite",
  ));
} catch {}
const org = "10000000-0000-4000-8000-000000000001",
  job = "10000000-0000-4000-8000-000000000002",
  change = "10000000-0000-4000-8000-000000000003",
  condition = "10000000-0000-4000-8000-000000000004",
  line = "10000000-0000-4000-8000-000000000005";
test(
  "measured change orders commit quantity, price and provenance atomically",
  { skip: !PGlite },
  async (t) => {
    const db = new PGlite();
    t.after(() => db.close());
    await db.exec(`create role anon; create role authenticated; create role service_role;
 create schema auth; create function auth.uid() returns uuid language sql as $$select '${org}'::uuid$$;
 create function public.has_org_permission(uuid,text) returns boolean language sql as $$select coalesce(current_setting('test.permitted',true),'true') <> 'false'$$;
 create table public.change_orders(id uuid primary key, org_id uuid, project_id uuid, lifecycle text default 'draft', status text default 'draft', client_visible boolean default false, updated_at timestamptz default now(), metadata jsonb default '{}', markup_mode text default 'percent', total_cents bigint, cost_total_cents bigint);
 create table public.cost_codes(id uuid primary key, org_id uuid);
 create table public.takeoff_conditions(id uuid primary key, org_id uuid, project_id uuid);
 create table public.change_order_lines(id uuid primary key, org_id uuid, change_order_id uuid references public.change_orders(id), description text, quantity numeric check(quantity > 0), unit text, unit_cost_cents integer, cost_code_id uuid, sort_order integer default 0, metadata jsonb default '{}', internal_cost_cents bigint, commitment_change_order_id uuid, gmp_impact text default 'none', gmp_delta_cents bigint default 0);
 insert into public.takeoff_conditions values('${condition}','${org}','${job}');`);
    await db.exec(
      fs.readFileSync(
        "supabase/migrations/20260929011236_takeoff_estimating_continuity.sql",
        "utf8",
      ),
    );
    const reset = async () => {
      await db.exec(
        `set test.permitted = 'true'; truncate public.change_orders cascade; insert into public.change_orders(id,org_id,project_id,metadata) values('${change}','${org}','${job}','{"tax_rate":10,"markup_percent":20}');`,
      );
    };
    const get = async (sql) => (await db.query(sql)).rows;
    const apply = async (updates, stale) => {
      const parent = (
        await get(
          `select updated_at from public.change_orders where id='${change}'`,
        )
      )[0];
      const snapshot = await get(
        `select * from public.change_order_lines where change_order_id='${change}' order by id`,
      );
      return db.query(
        "select public.apply_change_order_measurements($1,$2,$3,$4,$5,$6)",
        [
          org,
          change,
          stale ?? parent.updated_at,
          org,
          JSON.stringify(snapshot),
          JSON.stringify(updates),
        ],
      );
    };
    const update = (qty = 100, id = line) => ({
      id,
      condition_id: condition,
      description: "Flooring",
      quantity: qty,
      unit: "sf",
      unit_cost_cents: 200,
      cost_code_id: null,
      metadata: {
        takeoff: { condition_id: condition, measured_quantity: qty },
      },
    });
    await t.test(
      "adds quantities and derives tax/markup without accepting client totals",
      async () => {
        await reset();
        await apply([update()]);
        assert.equal(
          (await get(`select total_cents from public.change_orders`))[0]
            .total_cents,
          26000,
        );
        const row = (await get("select * from public.change_order_lines"))[0];
        assert.equal(row.quantity, "100");
        assert.equal(row.metadata.takeoff.measured_quantity, 100);
        await apply([update(150)]);
        assert.equal(
          (
            await get("select count(*)::int n from public.change_order_lines")
          )[0].n,
          1,
        );
        assert.equal(
          (await get("select total_cents from public.change_orders"))[0]
            .total_cents,
          39000,
        );
      },
    );
    await t.test(
      "preserves an edited rate and internal lump-sum cost",
      async () => {
        await reset();
        await apply([update()]);
        await db.exec(
          "update public.change_order_lines set unit_cost_cents=500,internal_cost_cents=9000",
        );
        await apply([update(120)]);
        assert.equal(
          (
            await get("select unit_cost_cents from public.change_order_lines")
          )[0].unit_cost_cents,
          500,
        );
        const parent = (
          await get(
            "select total_cents,cost_total_cents from public.change_orders",
          )
        )[0];
        assert.equal(parent.total_cents, 66000);
        assert.equal(parent.cost_total_cents, 9000);
      },
    );
    await t.test(
      "issued, visible, approved and stale snapshots cannot change money",
      async () => {
        for (const assignment of [
          "status='sent'",
          "client_visible=true",
          "lifecycle='approved'",
        ]) {
          await reset();
          await db.exec(`update public.change_orders set ${assignment}`);
          await assert.rejects(apply([update()]), /unissued draft/);
          assert.equal(
            (
              await get("select count(*)::int n from public.change_order_lines")
            )[0].n,
            0,
          );
        }
        await reset();
        await assert.rejects(
          apply([update()], "2000-01-01T00:00:00Z"),
          /changed/,
        );
      },
    );
    await t.test(
      "a bad second row rolls back the first row and all totals",
      async () => {
        await reset();
        await assert.rejects(
          apply([update(), update(-1, "10000000-0000-4000-8000-000000000006")]),
          /Invalid quantity/,
        );
        assert.equal(
          (
            await get("select count(*)::int n from public.change_order_lines")
          )[0].n,
          0,
        );
      },
    );
    await t.test(
      "tenant/project and permission checks run before writes",
      async () => {
        await reset();
        await db.exec("set test.permitted='false'");
        await assert.rejects(apply([update()]), /Permission denied/);
        await db.exec("set test.permitted='true'");
        await db.exec(
          `update public.takeoff_conditions set project_id='10000000-0000-4000-8000-000000000009'`,
        );
        await assert.rejects(apply([update()]), /another project/);
      },
    );
    await t.test("only the server role can invoke the transaction", async () => {
      for (const role of ["anon", "authenticated"]) {
        const allowed = await db.query("select has_function_privilege($1, 'public.apply_change_order_measurements(uuid,uuid,timestamptz,uuid,jsonb,jsonb)', 'execute') as allowed", [role]);
        assert.equal(allowed.rows[0].allowed, false);
      }
      const allowed = await db.query("select has_function_privilege('service_role', 'public.apply_change_order_measurements(uuid,uuid,timestamptz,uuid,jsonb,jsonb)', 'execute') as allowed");
      assert.equal(allowed.rows[0].allowed, true);
    });
  },
);
