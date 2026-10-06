const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// CREATE OR REPLACE preserves privileges. Replay each actual function body and
// its adjacent grants, so a later replacement need not repeat the original ACL.
async function installBooksExportSnapshot(db) {
  const directory = path.join(__dirname, "../../supabase/migrations");
  const definition =
    "create or replace function public.capture_books_export_snapshot(";
  let replacements = 0;
  for (const name of fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const sql = fs.readFileSync(path.join(directory, name), "utf8");
    const start = sql.indexOf(definition);
    if (start < 0) {
      const renameMatch = sql.match(
        /alter function public.capture_books_export_snapshot\(uuid\) rename to (capture_books_export_snapshot_before_[a-z_]+);/,
      );
      if (!renameMatch) continue;
      const wrapperStart = sql.indexOf(renameMatch[0]);
      // Registry wrappers may reference newly staged ledgers. These empty
      // identity stubs exercise export transport only, never ledger/schema QA.
      const tables = name.includes("native_invoice_correction_reviews")
        ? ["books_native_invoice_correction_reviews"]
        : name.includes("native_invoice_correction_proposals")
          ? ["books_native_invoice_correction_proposals"]
          : name.includes("native_invoice_income_resolutions")
            ? ["books_native_invoice_income_resolutions"]
            : name.includes("native_invoice_income_archive")
              ? ["books_native_invoice_income_selections"]
              : name.includes("native_invoice_request_resolutions")
                ? ["books_native_invoice_request_resolutions"]
                : name.includes("native_invoice_atomic_posting")
                  ? ["books_native_invoice_postings"]
                  : name.includes("native_adjustment_ledger")
                    ? [
                        "books_native_adjustment_facts",
                        "books_native_adjustment_reviews",
                        "books_native_journal_entries",
                        "books_native_journal_lines",
                        "books_native_period_holds",
                      ]
                    : name.includes("project_owner_request_resolutions")
                      ? ["books_project_owner_request_resolutions"]
                      : name.includes("project_owner_archive")
                        ? [
                            "books_project_entity_proposals",
                            "books_project_entity_reviews",
                          ]
                        : name.includes("entity_chart_versions")
                          ? [
                              "books_entity_chart_versions",
                              "books_entity_accounts",
                              "books_entity_account_definitions",
                              "books_entity_control_accounts",
                              "books_entity_chart_reviews",
                            ]
                          : name.includes("entity_fiscal_calendars")
                            ? [
                                "books_entity_calendar_years",
                                "books_entity_fiscal_periods",
                                "books_entity_calendar_reviews",
                              ]
                            : ["books_journal_request_resolutions"];
      for (const table of tables)
        await db.exec(
          `create table if not exists public.${table}(id uuid primary key,org_id uuid not null)`,
        );
      await db.exec(`drop function if exists public.${renameMatch[1]}(uuid)`);
      const wrapperEnd = sql.indexOf(
        "grant execute on function public.capture_books_export_snapshot(uuid) to service_role;",
        wrapperStart,
      );
      assert.ok(
        wrapperEnd > wrapperStart,
        `Snapshot wrapper grants are required in ${name}`,
      );
      await db.exec(
        sql.slice(
          wrapperStart,
          wrapperEnd +
            "grant execute on function public.capture_books_export_snapshot(uuid) to service_role;"
              .length,
        ),
      );
      replacements++;
      continue;
    }
    const end = sql.indexOf("$$;", start);
    assert.ok(end >= start, `Snapshot body terminator is required in ${name}`);
    await db.exec(sql.slice(start, end + 3));
    const grants = sql
      .slice(end + 3)
      .match(
        /^(?:\s*(?:revoke|grant)[^;]*capture_books_export_snapshot\(uuid\)[^;]*;)+/i,
      );
    if (grants) await db.exec(grants[0]);
    replacements++;
  }
  assert.ok(replacements > 0, "Snapshot function migrations are required");
}
module.exports = { installBooksExportSnapshot };
