import { NextRequest, NextResponse } from "next/server"
import { createHash } from "node:crypto"

import { createServiceSupabaseClient } from "@/lib/supabase/server"

export const runtime = "nodejs"

const CRON_SECRET = process.env.CRON_SECRET

function isAuthorizedCronRequest(request: NextRequest) {
  const isDev = process.env.NODE_ENV !== "production"
  if (isDev) return true

  const isVercelCron = request.headers.get("x-vercel-cron") === "1"
  const authHeader = request.headers.get("authorization") ?? request.headers.get("Authorization")
  const bearer = typeof authHeader === "string" ? authHeader.trim() : ""
  const legacyHeader = request.headers.get("x-cron-secret")

  const secretOk =
    (!!CRON_SECRET && bearer === `Bearer ${CRON_SECRET}`) ||
    (!!CRON_SECRET && legacyHeader === CRON_SECRET)

  if (CRON_SECRET) {
    return secretOk
  }

  return isVercelCron
}

export async function POST(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceSupabaseClient()
  const now = new Date()
  const windowStartIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()

  const [migrationsRes, rolePermissionsRes, unknownDeniesRes, totalDeniesRes, platformMembershipsRes] = await Promise.all([
    supabase
      .schema("supabase_migrations")
      .from("schema_migrations")
      .select("version")
      .order("version", { ascending: false })
      .limit(20),
    supabase
      .from("role_permissions")
      .select("role_id, permission_key"),
    supabase
      .from("authorization_audit_log")
      .select("id", { count: "exact", head: true })
      .eq("reason_code", "deny_unknown_permission")
      .gte("occurred_at", windowStartIso),
    supabase
      .from("authorization_audit_log")
      .select("id", { count: "exact", head: true })
      .eq("decision", "deny")
      .gte("occurred_at", windowStartIso),
    supabase
      .from("platform_memberships")
      .select("id", { count: "exact", head: true })
      .eq("status", "active"),
  ])

  if (
    migrationsRes.error ||
    rolePermissionsRes.error ||
    unknownDeniesRes.error ||
    totalDeniesRes.error ||
    platformMembershipsRes.error
  ) {
    const message =
      migrationsRes.error?.message ||
      rolePermissionsRes.error?.message ||
      unknownDeniesRes.error?.message ||
      totalDeniesRes.error?.message ||
      platformMembershipsRes.error?.message ||
      "Failed to collect RBAC evidence."
    return NextResponse.json({ error: message }, { status: 500 })
  }

  const rolePermissionRows = (rolePermissionsRes.data ?? []) as Array<{
    role_id: string
    permission_key: string
  }>
  const permissionMatrixDigest = createHash("sha256")
    .update(
      rolePermissionRows
        .map((row) => `${row.role_id}|${row.permission_key}`)
        .sort()
        .join("\n"),
    )
    .digest("hex")

  const snapshot = {
    generated_at: now.toISOString(),
    migration_versions: (migrationsRes.data ?? []).map((row: any) => row.version as string),
    role_permission_count: rolePermissionRows.length,
    role_permission_digest_sha256: permissionMatrixDigest,
    deny_unknown_permission_24h: unknownDeniesRes.count ?? 0,
    deny_total_24h: totalDeniesRes.count ?? 0,
    active_platform_memberships: platformMembershipsRes.count ?? 0,
  }

  const { error: writeError } = await supabase.from("authorization_audit_log").insert({
    action_key: "authz.evidence.snapshot",
    decision: "allow",
    reason_code: "system_job",
    policy_version: "phase6-v1",
    context: snapshot,
  })

  if (writeError) {
    return NextResponse.json({ error: `Failed to persist RBAC evidence: ${writeError.message}` }, { status: 500 })
  }

  return NextResponse.json({ ok: true, snapshot })
}
