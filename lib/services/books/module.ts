import "server-only";

import { cache } from "react";
import { z } from "zod";

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/services/audit";
import { requireBooksAuthorization as requireAuthorization } from "@/lib/services/books/access";
import { requireOrgContext } from "@/lib/services/context";
import { recordEvent } from "@/lib/services/events";
import { initializeArcBooks } from "@/lib/services/books/ledger";
import { assertValidOperatingPosture } from "@/lib/services/books/types";

const moduleRowSchema = z.object({
  workspace_enabled: z.boolean(),
  ledger_authority: z.enum(["external", "arc"]),
  arc_ledger_mode: z.enum(["disabled", "shadow", "parallel", "official"]),
  external_sync_posture: z.enum(["normal", "outbound_mirror", "disconnected"]),
  external_provider: z.string().nullable(),
  functional_currency: z.string(),
  reporting_basis: z.literal("accrual"),
  fiscal_year_start_month: z.number().int().min(1).max(12),
});

export type BooksModuleRow = z.infer<typeof moduleRowSchema>;

const loadEnabledForOrg = cache(async (orgId: string) => {
  const service = createServiceSupabaseClient();
  const { data, error } = await service
    .from("books_settings")
    .select("workspace_enabled")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error)
    throw new Error(`Failed to load Arc Books module state: ${error.message}`);
  return data?.workspace_enabled === true;
});

/** Cheap shell-level feature check. A missing settings row is always disabled. */
export async function isBooksWorkspaceEnabled(orgId?: string) {
  const context = await requireOrgContext(orgId);
  return loadEnabledForOrg(context.orgId);
}

/** Server-side boundary used by every Books route and mutation. */
export async function requireBooksWorkspaceEnabled(orgId?: string) {
  const context = await requireOrgContext(orgId);
  if (!(await loadEnabledForOrg(context.orgId))) {
    throw new Error(
      "Arc Books is disabled. An organization administrator can enable it in Settings → Accounting.",
    );
  }
  return context;
}

export async function getBooksModuleSettings(
  options: { orgId?: string; includeConnections?: boolean } = {},
) {
  const context = await requireOrgContext(options.orgId);
  const service = createServiceSupabaseClient();
  if (options.includeConnections) {
    await requireAuthorization({
      permission: "org.admin",
      userId: context.userId,
      orgId: context.orgId,
      supabase: context.supabase,
      resourceType: "accounting_connection",
      resourceId: context.orgId,
      logDecision: false,
    });
  }
  const [settingsResult, connectionsResult] = await Promise.all([
    service
      .from("books_settings")
      .select(
        "workspace_enabled, ledger_authority, arc_ledger_mode, external_sync_posture, external_provider, functional_currency, reporting_basis, fiscal_year_start_month",
      )
      .eq("org_id", context.orgId)
      .maybeSingle(),
    options.includeConnections
      ? service
          .from("accounting_connections")
          .select("id, provider, label, status, last_sync_at")
          .eq("org_id", context.orgId)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (settingsResult.error)
    throw new Error(
      `Failed to load Arc Books settings: ${settingsResult.error.message}`,
    );
  if (connectionsResult.error)
    throw new Error(
      `Failed to load accounting connections: ${connectionsResult.error.message}`,
    );

  const settings = settingsResult.data
    ? moduleRowSchema.parse(settingsResult.data)
    : null;
  return {
    enabled: settings?.workspace_enabled ?? false,
    settings,
    canDisable: settings?.ledger_authority !== "arc",
    connections: connectionsResult.data ?? [],
  };
}

async function requireModuleAdmin(orgId?: string) {
  const context = await requireOrgContext(orgId);
  await requireAuthorization({
    permission: "org.admin",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "books_settings",
    resourceId: context.orgId,
    logDecision: true,
  });
  return context;
}

export async function setBooksWorkspaceEnabled(
  enabled: boolean,
  orgId?: string,
) {
  const context = await requireModuleAdmin(orgId);
  const service = createServiceSupabaseClient();
  const { data: beforeData, error: beforeError } = await service
    .from("books_settings")
    .select(
      "workspace_enabled, ledger_authority, arc_ledger_mode, external_sync_posture",
    )
    .eq("org_id", context.orgId)
    .maybeSingle();
  if (beforeError)
    throw new Error(
      `Failed to load Arc Books settings: ${beforeError.message}`,
    );

  if (enabled) {
    await initializeArcBooks(context.orgId);
    const nextMode =
      beforeData?.arc_ledger_mode === "disabled"
        ? "shadow"
        : beforeData?.arc_ledger_mode;
    const { error } = await service
      .from("books_settings")
      .update({
        workspace_enabled: true,
        ...(nextMode ? { arc_ledger_mode: nextMode } : {}),
        updated_by: context.userId,
      })
      .eq("org_id", context.orgId);
    if (error) throw new Error(`Failed to enable Arc Books: ${error.message}`);
  } else {
    if (!beforeData) return { enabled: false };
    if (beforeData.ledger_authority === "arc") {
      throw new Error(
        "Arc Books is this organization's official ledger and cannot be disabled. Use the controlled rollback or migration workflow instead.",
      );
    }
    const { count: activeCutoverCount, error: cutoverError } = await service
      .from("books_cutover_runs")
      .select("id", { count: "exact", head: true })
      .eq("org_id", context.orgId)
      .in("status", ["draft", "validating", "blocked", "ready"]);
    if (cutoverError)
      throw new Error(`Failed to check cutover state: ${cutoverError.message}`);
    if ((activeCutoverCount ?? 0) > 0) {
      throw new Error(
        "Cancel the active authority cutover before disabling Arc Books so external sync is not left frozen.",
      );
    }
    // Ledger standing survives a disable. Resetting `arc_ledger_mode` here used
    // to silently demote a `parallel` org back to `shadow` on re-enable,
    // destroying the cutover prerequisite it had spent a quarter earning.
    // `workspace_enabled` is the module gate on its own — every reader of
    // `arc_ledger_mode` (projector, rebuild drills, revenue recognition, cutover
    // prerequisites) pairs it with `workspace_enabled`.
    const { error } = await service
      .from("books_settings")
      .update({
        workspace_enabled: false,
        updated_by: context.userId,
      })
      .eq("org_id", context.orgId);
    if (error) throw new Error(`Failed to disable Arc Books: ${error.message}`);
  }

  const after = {
    workspace_enabled: enabled,
    ledger_authority: beforeData?.ledger_authority ?? "external",
    arc_ledger_mode: enabled
      ? beforeData?.arc_ledger_mode === "disabled" || !beforeData
        ? "shadow"
        : beforeData.arc_ledger_mode
      : (beforeData?.arc_ledger_mode ?? "disabled"),
    external_sync_posture: beforeData?.external_sync_posture ?? "normal",
  };
  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: enabled
        ? "books.workspace_enabled"
        : "books.workspace_disabled",
      entityType: "books_settings",
      entityId: context.orgId,
      payload: after,
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "update",
      entityType: "books_settings",
      entityId: context.orgId,
      before: beforeData ?? { workspace_enabled: false },
      after,
      source: "settings.accounting",
    }),
  ]);
  return { enabled };
}

export async function updateBooksFiscalSettings(
  input: { fiscalYearStartMonth: number },
  orgId?: string,
) {
  const context = await requireModuleAdmin(orgId);
  await requireBooksWorkspaceEnabled(context.orgId);
  const fiscalYearStartMonth = z
    .number()
    .int()
    .min(1)
    .max(12)
    .parse(input.fiscalYearStartMonth);
  const service = createServiceSupabaseClient();
  const { error } = await service
    .from("books_settings")
    .update({
      fiscal_year_start_month: fiscalYearStartMonth,
      updated_by: context.userId,
    })
    .eq("org_id", context.orgId);
  if (error)
    throw new Error(`Failed to update accounting settings: ${error.message}`);
  await recordAudit({
    orgId: context.orgId,
    actorId: context.userId,
    action: "update",
    entityType: "books_settings",
    entityId: context.orgId,
    after: { fiscal_year_start_month: fiscalYearStartMonth },
    source: "settings.accounting",
  });
  return { fiscalYearStartMonth };
}

/**
 * Enter the measured parallel-close phase after shadow mode has proved the
 * projected ledger is deterministic and currently reconciled.
 *
 * CPA review remains a human gate; `attestation` is the durable reference to
 * that review, not a pretend automated substitute for it.
 */
export async function promoteBooksToParallel(input: {
  attestation: string;
  orgId?: string;
}) {
  const context = await requireOrgContext(input.orgId);
  await requireAuthorization({
    permission: "books.cutover",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "books_settings",
    resourceId: context.orgId,
    logDecision: true,
  });
  const attestation = z
    .string()
    .trim()
    .min(20, "Reference the completed CPA review and approval")
    .max(1000)
    .parse(input.attestation);
  const service = createServiceSupabaseClient();
  const [
    settingsResult,
    connectionResult,
    rebuildResult,
    reconciliationResult,
  ] = await Promise.all([
    service
      .from("books_settings")
      .select(
        "workspace_enabled, ledger_authority, arc_ledger_mode, external_sync_posture",
      )
      .eq("org_id", context.orgId)
      .single(),
    service
      .from("accounting_connections")
      .select("id", { count: "exact", head: true })
      .eq("org_id", context.orgId)
      .eq("status", "active"),
    service
      .from("ledger_rebuild_runs")
      .select("status, completed_at")
      .eq("org_id", context.orgId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    service
      .from("accounting_reconciliation_runs")
      .select("status, discrepancy_count, completed_at")
      .eq("org_id", context.orgId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (settingsResult.error)
    throw new Error(
      `Failed to load Books posture: ${settingsResult.error.message}`,
    );
  const before = settingsResult.data;
  if (
    !before.workspace_enabled ||
    before.ledger_authority !== "external" ||
    before.arc_ledger_mode !== "shadow" ||
    before.external_sync_posture !== "normal"
  ) {
    throw new Error(
      "Only an enabled external-authoritative workspace in shadow mode can enter parallel close",
    );
  }
  if (connectionResult.error || (connectionResult.count ?? 0) === 0)
    throw new Error(
      "An active external accounting connection is required for parallel close",
    );
  if (rebuildResult.error || rebuildResult.data?.status !== "passed")
    throw new Error(
      "Run a clean ledger rebuild before entering parallel close",
    );
  if (
    reconciliationResult.error ||
    reconciliationResult.data?.status !== "passed" ||
    Number(reconciliationResult.data.discrepancy_count ?? 0) !== 0
  ) {
    throw new Error(
      "Resolve every reconciliation finding before entering parallel close",
    );
  }

  assertValidOperatingPosture({
    ledgerAuthority: "external",
    arcLedgerMode: "parallel",
    externalSyncPosture: "normal",
  });
  const { error } = await service
    .from("books_settings")
    .update({
      arc_ledger_mode: "parallel",
      updated_by: context.userId,
    })
    .eq("org_id", context.orgId)
    .eq("arc_ledger_mode", "shadow");
  if (error)
    throw new Error(`Failed to enter parallel close: ${error.message}`);

  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "books.parallel_mode_started",
      entityType: "books_settings",
      entityId: context.orgId,
      payload: {
        attestation,
        rebuild_completed_at: rebuildResult.data.completed_at,
        reconciliation_completed_at: reconciliationResult.data.completed_at,
      },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "update",
      entityType: "books_settings",
      entityId: context.orgId,
      before: { arc_ledger_mode: "shadow" },
      after: { arc_ledger_mode: "parallel", attestation },
      source: "books.parallel-promotion",
    }),
  ]);
  return { mode: "parallel" as const };
}
