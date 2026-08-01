import "server-only";

import { z } from "zod";

import {
  getProvider,
  isAccountingProviderKey,
} from "@/lib/integrations/accounting/registry";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { requireAuthorization } from "@/lib/services/authorization";
import { recordAudit } from "@/lib/services/audit";
import { booksDigest } from "@/lib/services/books/hash";
import { requireOrgContext } from "@/lib/services/context";
import { recordEvent } from "@/lib/services/events";

async function requireCutoverContext(
  permission: "books.cutover" | "books.adjust",
  orgId?: string,
) {
  const context = await requireOrgContext(orgId);
  await requireAuthorization({
    permission,
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "books_cutover",
    resourceId: context.orgId,
    logDecision: true,
  });
  return context;
}

export async function prepareBooksCutover(input: {
  connectionId: string;
  cutoverDate: string;
  targetPosture: "outbound_mirror" | "disconnected";
  orgId?: string;
}) {
  const context = await requireCutoverContext("books.cutover", input.orgId);
  const service = createServiceSupabaseClient();
  const [
    settings,
    connection,
    comparisons,
    opening,
    bankAccounts,
    bankReconciliations,
    syncIssues,
    draftJournals,
    exportResult,
  ] = await Promise.all([
    service
      .from("books_settings")
      .select("arc_ledger_mode, ledger_authority")
      .eq("org_id", context.orgId)
      .single(),
    service
      .from("accounting_connections")
      .select("id, provider, status, last_sync_at, settings")
      .eq("org_id", context.orgId)
      .eq("id", input.connectionId)
      .single(),
    service
      .from("books_comparison_runs")
      .select("id, period_id, status, unexplained_variance_count")
      .eq("org_id", context.orgId)
      .eq("connection_id", input.connectionId)
      .eq("status", "approved")
      .order("completed_at", { ascending: false })
      .limit(3),
    service
      .from("opening_balance_batches")
      .select("id, status, digest")
      .eq("org_id", context.orgId)
      .eq("status", "posted")
      .order("posted_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    service
      .from("bank_accounts")
      .select("id")
      .eq("org_id", context.orgId)
      .eq("active", true),
    service
      .from("bank_reconciliations")
      .select("bank_account_id, statement_end, status")
      .eq("org_id", context.orgId)
      .eq("status", "closed")
      .gte("statement_end", input.cutoverDate),
    service
      .from("accounting_sync_records")
      .select("id", { count: "exact", head: true })
      .eq("org_id", context.orgId)
      .eq("connection_id", input.connectionId)
      .in("status", ["pending", "error", "processing"]),
    service
      .from("journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("org_id", context.orgId)
      .eq("status", "draft")
      .lte("entry_date", input.cutoverDate),
    service
      .from("books_exports")
      .select("id, content_hash, status, downloaded_at")
      .eq("org_id", context.orgId)
      .in("export_type", ["complete", "cutover"])
      .eq("status", "ready")
      .not("downloaded_at", "is", null)
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const firstError =
    settings.error ||
    connection.error ||
    comparisons.error ||
    opening.error ||
    bankAccounts.error ||
    bankReconciliations.error ||
    syncIssues.error ||
    draftJournals.error ||
    exportResult.error;
  if (firstError)
    throw new Error(`Failed to evaluate Books cutover: ${firstError.message}`);
  const reconciledIds = new Set(
    (bankReconciliations.data ?? []).map((row) => row.bank_account_id),
  );
  const missingReconciliations = (bankAccounts.data ?? []).filter(
    (account) => !reconciledIds.has(account.id),
  );
  const mirrorProviderSupported = isAccountingProviderKey(connection.data.provider) && getProvider(connection.data.provider).capabilities.supportsJournalEntryPush;
  const prerequisites = {
    parallel_mode:
      settings.data?.arc_ledger_mode === "parallel" &&
      settings.data?.ledger_authority === "external",
    three_approved_comparisons:
      (comparisons.data?.length ?? 0) >= 3 &&
      (comparisons.data ?? []).every(
        (row) => row.unexplained_variance_count === 0,
      ),
    opening_balances_posted: Boolean(opening.data?.id),
    bank_accounts_reconciled: missingReconciliations.length === 0,
    sync_queue_drained: (syncIssues.count ?? 0) === 0,
    no_draft_journals: (draftJournals.count ?? 0) === 0,
    complete_export_downloaded: Boolean(
      exportResult.data?.id && exportResult.data.downloaded_at,
    ),
    mirror_provider_supported:
      input.targetPosture !== "outbound_mirror" ||
      mirrorProviderSupported,
  };
  const blockers = Object.entries(prerequisites)
    .filter(([, passed]) => !passed)
    .map(([key]) => key);
  const digest = booksDigest({
    orgId: context.orgId,
    connectionId: input.connectionId,
    cutoverDate: input.cutoverDate,
    targetPosture: input.targetPosture,
    prerequisites,
    comparisonIds: (comparisons.data ?? []).map((row) => row.id),
    openingDigest: opening.data?.digest ?? null,
    exportHash: exportResult.data?.content_hash ?? null,
  });
  const { data, error } = await service
    .from("books_cutover_runs")
    .upsert(
      {
        org_id: context.orgId,
        connection_id: input.connectionId,
        cutover_date: input.cutoverDate,
        target_posture: input.targetPosture,
        status: blockers.length === 0 ? "ready" : "blocked",
        prerequisites,
        blockers,
        digest,
        rollback_deadline: new Date(
          Date.now() + 14 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        requested_by: context.userId,
        final_sync_marker: booksDigest({
          last_sync_at: connection.data.last_sync_at,
          settings: connection.data.settings,
        }),
      },
      { onConflict: "org_id,cutover_date,digest" },
    )
    .select("id")
    .single();
  if (error)
    throw new Error(`Failed to prepare Books cutover: ${error.message}`);
  const cutoverRunId = z.object({ id: z.string().uuid() }).parse(data).id;
  if (blockers.length === 0) {
    const currentSettings =
      connection.data.settings &&
      typeof connection.data.settings === "object" &&
      !Array.isArray(connection.data.settings)
        ? connection.data.settings
        : {};
    const freeze = await service
      .from("accounting_connections")
      .update({
        settings: {
          ...currentSettings,
          cutover_freeze_run_id: cutoverRunId,
          cutover_frozen_at: new Date().toISOString(),
        },
      })
      .eq("org_id", context.orgId)
      .eq("id", input.connectionId);
    if (freeze.error)
      throw new Error(
        `Failed to freeze accounting sync for cutover: ${freeze.error.message}`,
      );
  }
  return {
    cutoverRunId,
    status: blockers.length === 0 ? ("ready" as const) : ("blocked" as const),
    blockers,
    digest,
    prerequisites,
  };
}

export async function approveBooksCutover(input: {
  cutoverRunId: string;
  approvalRole: "owner" | "accountant";
  orgId?: string;
}) {
  const permission =
    input.approvalRole === "owner" ? "books.cutover" : "books.adjust";
  const context = await requireCutoverContext(permission, input.orgId);
  const service = createServiceSupabaseClient();
  const { data: cutover, error: cutoverError } = await service
    .from("books_cutover_runs")
    .select("status, digest")
    .eq("org_id", context.orgId)
    .eq("id", input.cutoverRunId)
    .single();
  if (cutoverError || cutover?.status !== "ready" || !cutover.digest)
    throw new Error("Cutover is not ready for approval");
  const { error } = await service.from("books_cutover_approvals").insert({
    org_id: context.orgId,
    cutover_run_id: input.cutoverRunId,
    approval_role: input.approvalRole,
    approved_by: context.userId,
    approved_digest: cutover.digest,
  });
  if (error)
    throw new Error(`Failed to approve Books cutover: ${error.message}`);
}

export async function cancelBooksCutover(cutoverRunId: string, orgId?: string) {
  const context = await requireCutoverContext("books.cutover", orgId);
  const service = createServiceSupabaseClient();
  const { data: run, error } = await service
    .from("books_cutover_runs")
    .select("id, connection_id, status")
    .eq("org_id", context.orgId)
    .eq("id", cutoverRunId)
    .single();
  if (
    error ||
    !run ||
    !new Set(["draft", "validating", "blocked", "ready"]).has(run.status)
  ) {
    throw new Error("Only an unfinished cutover can be cancelled");
  }
  if (run.connection_id) {
    const { data: connection, error: connectionError } = await service
      .from("accounting_connections")
      .select("settings")
      .eq("org_id", context.orgId)
      .eq("id", run.connection_id)
      .single();
    if (connectionError)
      throw new Error(
        `Failed to load accounting connection: ${connectionError.message}`,
      );
    const settings =
      connection.settings &&
      typeof connection.settings === "object" &&
      !Array.isArray(connection.settings)
        ? ({ ...connection.settings } as Record<string, unknown>)
        : {};
    if (settings.cutover_freeze_run_id === cutoverRunId) {
      delete settings.cutover_freeze_run_id;
      delete settings.cutover_frozen_at;
      const unfreeze = await service
        .from("accounting_connections")
        .update({ settings })
        .eq("org_id", context.orgId)
        .eq("id", run.connection_id);
      if (unfreeze.error)
        throw new Error(
          `Failed to release cutover freeze: ${unfreeze.error.message}`,
        );
    }
  }
  const update = await service
    .from("books_cutover_runs")
    .update({
      status: "failed",
      error_message: "Cancelled by user",
      updated_at: new Date().toISOString(),
    })
    .eq("org_id", context.orgId)
    .eq("id", cutoverRunId);
  if (update.error)
    throw new Error(`Failed to cancel cutover: ${update.error.message}`);
  await recordEvent({
    orgId: context.orgId,
    actorId: context.userId,
    eventType: "books.cutover_cancelled",
    entityType: "books_cutover_run",
    entityId: cutoverRunId,
    payload: {},
  });
}

export async function completeBooksCutover(
  cutoverRunId: string,
  orgId?: string,
) {
  const context = await requireCutoverContext("books.cutover", orgId);
  const service = createServiceSupabaseClient();
  const { data: run, error: runError } = await service
    .from("books_cutover_runs")
    .select("id, connection_id, target_posture, status, digest")
    .eq("org_id", context.orgId)
    .eq("id", cutoverRunId)
    .single();
  if (runError || run?.status !== "ready")
    throw new Error("Cutover is not ready");
  const { error } = await service.rpc("complete_books_cutover", {
    p_org_id: context.orgId,
    p_run_id: cutoverRunId,
    p_actor_id: context.userId,
  });
  if (error)
    throw new Error(`Failed to complete Books cutover: ${error.message}`);
  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "books.authority_changed",
      entityType: "books_cutover_run",
      entityId: cutoverRunId,
      payload: {
        ledger_authority: "arc",
        external_sync_posture: run.target_posture,
      },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "update",
      entityType: "books_settings",
      entityId: context.orgId,
      after: {
        ledger_authority: "arc",
        external_sync_posture: run.target_posture,
      },
      source: "books.cutover",
    }),
  ]);
}

export async function finalizeExpiredCutoverCredentials(limit = 25) {
  const service = createServiceSupabaseClient();
  const { data, error } = await service
    .from("books_cutover_runs")
    .select("id, org_id, connection_id")
    .eq("status", "completed")
    .eq("target_posture", "disconnected")
    .lt("rollback_deadline", new Date().toISOString())
    .not("connection_id", "is", null)
    .limit(limit);
  if (error)
    throw new Error(`Failed to load credential cutovers: ${error.message}`);
  let finalized = 0;
  for (const row of data ?? []) {
    const { data: connection } = await service
      .from("accounting_connections")
      .select("provider, settings")
      .eq("org_id", row.org_id)
      .eq("id", row.connection_id)
      .maybeSingle();
    if (!connection || !isAccountingProviderKey(connection.provider)) continue;
    const currentSettings =
      connection.settings &&
      typeof connection.settings === "object" &&
      !Array.isArray(connection.settings)
        ? connection.settings
        : {};
    if (typeof currentSettings.credentials_finalized_at === "string") continue;
    await getProvider(connection.provider).disconnect({
      orgId: row.org_id,
      connectionId: row.connection_id,
    });
    await service
      .from("accounting_connections")
      .update({
        access_token: "revoked",
        refresh_token: "revoked",
        credentials: {},
        settings: {
          ...currentSettings,
          credentials_finalized_at: new Date().toISOString(),
        },
      })
      .eq("org_id", row.org_id)
      .eq("id", row.connection_id);
    finalized += 1;
  }
  return { attempted: data?.length ?? 0, finalized };
}

export async function rollbackBooksCutover(input: {
  cutoverRunId: string;
  reason: string;
  orgId?: string;
}) {
  const context = await requireCutoverContext("books.cutover", input.orgId);
  if (input.reason.trim().length < 10)
    throw new Error("A substantive rollback reason is required");
  const service = createServiceSupabaseClient();
  const { error } = await service.rpc("rollback_books_cutover", {
    p_org_id: context.orgId,
    p_run_id: input.cutoverRunId,
    p_actor_id: context.userId,
    p_reason: input.reason.trim(),
  });
  if (error)
    throw new Error(`Failed to roll back Books cutover: ${error.message}`);
  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "books.cutover_rolled_back",
      entityType: "books_cutover_run",
      entityId: input.cutoverRunId,
      payload: { reason: input.reason.trim() },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "update",
      entityType: "books_settings",
      entityId: context.orgId,
      after: { ledger_authority: "external", arc_ledger_mode: "parallel" },
      source: "books.cutover.rollback",
    }),
  ]);
}
