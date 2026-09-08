import "server-only"

import { z } from "zod"

import { requireAuth } from "@/lib/auth/context"
import { getPaymentRailProvider } from "@/lib/integrations/payments/payment-rail-registry"
import type { PaymentExecutionConfig } from "@/lib/payments/operations-monitor"
import { recordAudit } from "@/lib/services/audit"
import { getCurrentPlatformAccess } from "@/lib/services/platform-access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export const PAYMENT_LAUNCH_GATES = [
  "provider_program",
  "payments_legal",
  "risk_reserves",
  "operations_runbook",
  "production_qa",
] as const

export type PaymentLaunchGateKey = (typeof PAYMENT_LAUNCH_GATES)[number]

export interface PaymentLaunchGateState {
  gateKey: PaymentLaunchGateKey
  decision: "approved" | "revoked" | "pending"
  evidenceReference: string | null
  note: string | null
  attestedBy: string | null
  createdAt: string | null
}

const PAYOUT_SETTINGS_CACHE_MS = 60 * 60 * 1000
let payoutSettingsCache: { interval: string; checkedAt: number } | null = null

export async function getPlatformPayoutScheduleState(): Promise<{
  interval: string
  ready: boolean
  error: string | null
}> {
  try {
    if (!payoutSettingsCache || Date.now() - payoutSettingsCache.checkedAt >= PAYOUT_SETTINGS_CACHE_MS) {
      const settings = await getPaymentRailProvider().retrievePlatformPayoutSettings()
      payoutSettingsCache = { interval: settings.interval, checkedAt: Date.now() }
    }
    return { interval: payoutSettingsCache.interval, ready: payoutSettingsCache.interval === "manual", error: null }
  } catch (cause) {
    return {
      interval: "unavailable",
      ready: false,
      error: cause instanceof Error ? cause.message : "Provider payout settings could not be read",
    }
  }
}

export async function requirePaymentLaunchOwner() {
  const { user } = await requireAuth()
  const access = await getCurrentPlatformAccess()
  if (!access.isEnvSuperadmin && !access.roles.includes("platform_super_admin")) {
    throw new Error("Only Arc platform owners can attest or revoke payment launch gates")
  }
  return { user, access }
}

export async function listPaymentLaunchGateStates(): Promise<PaymentLaunchGateState[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.from("payment_launch_gate_attestations")
    .select("id,gate_key,decision,evidence_reference,note,attested_by,created_at")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
  if (error) throw new Error(`Unable to load payment launch approvals: ${error.message}`)
  const latest = new Map<string, (typeof data)[number]>()
  for (const row of data ?? []) if (!latest.has(row.gate_key)) latest.set(row.gate_key, row)
  return PAYMENT_LAUNCH_GATES.map((gateKey) => {
    const row = latest.get(gateKey)
    return {
      gateKey,
      decision: row?.decision === "approved" || row?.decision === "revoked" ? row.decision : "pending",
      evidenceReference: row?.evidence_reference ?? null,
      note: row?.note ?? null,
      attestedBy: row?.attested_by ?? null,
      createdAt: row?.created_at ?? null,
    }
  })
}

/**
 * The environment half of launch readiness, as data rather than as a throw.
 *
 * `assertPaymentLaunchReady` is the enforcement point and stays a throw. This
 * exists so the watchdog can *report* the same conditions without triggering
 * them, which is the difference between an alert and a stack trace.
 */
export function readPaymentExecutionConfig(): PaymentExecutionConfig {
  return {
    executionEnabled: process.env.FINTECH_PAYMENTS_EXECUTION_ENABLED === "true",
    reconciliationEnabled: process.env.FINTECH_PAYMENTS_RECONCILIATION_ENABLED === "true",
    liveModeApproved: process.env.FINTECH_PAYMENTS_LIVE_MODE_APPROVED === "true",
    mode: process.env.FINTECH_PAYMENTS_MODE ?? null,
  }
}

/**
 * Is any organization actually on the rail?
 *
 * The money crons used to assert full launch readiness before checking whether
 * there was any money to move, so a deployment with the rail switched off
 * everywhere still failed every five minutes. Nothing about that failure was
 * true — there was no work, and no builder was affected. Asking this first turns
 * a no-op tick into a success without weakening anything: the readiness
 * assertion still runs before a single provider call.
 */
export async function hasEnabledPaymentRail(): Promise<boolean> {
  const supabase = createServiceSupabaseClient()
  const { count, error } = await supabase
    .from("payment_rail_policies")
    .select("org_id", { count: "exact", head: true })
    .eq("enabled", true)
  if (error) throw new Error(`Unable to read payment rail policies: ${error.message}`)
  return (count ?? 0) > 0
}

export async function assertPaymentLaunchReady() {
  if (process.env.FINTECH_PAYMENTS_EXECUTION_ENABLED !== "true") {
    throw new Error("Electronic payment execution is not enabled in this environment")
  }
  if (process.env.FINTECH_PAYMENTS_RECONCILIATION_ENABLED !== "true") {
    throw new Error("Electronic payments cannot be enabled until daily reconciliation is running")
  }
  const gates = await listPaymentLaunchGateStates()
  const incomplete = gates.filter((gate) => gate.decision !== "approved")
  if (incomplete.length > 0) {
    throw new Error(`Electronic payments are awaiting launch approval: ${incomplete.map((gate) => gate.gateKey).join(", ")}`)
  }
  const payoutSchedule = await getPlatformPayoutScheduleState()
  if (!payoutSchedule.ready) {
    throw new Error(
      payoutSchedule.error
        ? `Electronic payments cannot start because the provider payout schedule could not be verified: ${payoutSchedule.error}`
        : `Electronic payments require the Stripe platform payout schedule to be manual; live interval is ${payoutSchedule.interval}`,
    )
  }
}

const attestationSchema = z.object({
  gateKey: z.enum(PAYMENT_LAUNCH_GATES),
  decision: z.enum(["approved", "revoked"]),
  evidenceReference: z.string().trim().min(3).max(500),
  note: z.string().trim().min(20).max(2000),
})

export async function attestPaymentLaunchGate(input: z.input<typeof attestationSchema>) {
  const parsed = attestationSchema.parse(input)
  const { user } = await requirePaymentLaunchOwner()
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.from("payment_launch_gate_attestations").insert({
    gate_key: parsed.gateKey,
    decision: parsed.decision,
    evidence_reference: parsed.evidenceReference,
    note: parsed.note,
    attested_by: user.id,
  }).select("id").single()
  if (error || !data) throw new Error(`Unable to record payment launch approval: ${error?.message}`)
  await recordAudit({
    actorId: user.id,
    action: "insert",
    entityType: "payment_launch_gate_attestation",
    entityId: data.id,
    after: parsed,
    source: "app",
  })
  return { id: data.id }
}
