"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requireAuth } from "@/lib/auth/context"
import { requireAnyPermission } from "@/lib/services/permissions"
import { provisionOrganization } from "@/lib/services/provisioning"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import { syncOrgEntitlementsFromPlan } from "@/lib/services/billing"

const provisionCustomerSchema = z.object({
  name: z.string().min(2, "Organization name is required"),
  slug: z.string().min(2, "Slug is required"),
  billingModel: z.enum(["subscription", "license"]),
  planCode: z.string().optional(),
  primaryEmail: z.string().email("Valid email is required"),
  primaryName: z.string().min(2, "Primary contact name is required"),
  trialDays: z.coerce.number().optional(),
})

const extendTrialSchema = z.object({
  orgId: z.string().uuid("Invalid organization id"),
  trialDays: z.coerce.number().int().min(1).max(90),
})

const updateCustomerDetailsSchema = z.object({
  orgId: z.string().uuid("Invalid organization id"),
  name: z.string().trim().min(2, "Organization name is required"),
  slug: z
    .string()
    .trim()
    .min(2, "Slug is required")
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "Slug can only contain lowercase letters, numbers, and hyphens."),
  status: z.enum(["active", "inactive", "suspended", "archived"]),
  billingModel: z.enum(["subscription", "license"]),
  billingEmail: z.string().trim().email("Valid billing email is required").or(z.literal("")),
})

const updateCustomerSubscriptionSchema = z.object({
  orgId: z.string().uuid("Invalid organization id"),
  status: z.enum(["trialing", "active", "past_due", "canceled"]),
  planCode: z.string().trim().nullish(),
  currentPeriodEnd: z.string().trim().nullish(),
  trialEndsAt: z.string().trim().nullish(),
  externalCustomerId: z.string().trim().nullish(),
  externalSubscriptionId: z.string().trim().nullish(),
})

function emptyToNull(value?: string | null) {
  const trimmed = value?.trim()
  if (trimmed === "__none") return null
  return trimmed ? trimmed : null
}

function dateInputToIso(value?: string | null) {
  const trimmed = value?.trim()
  if (!trimmed) return null
  const date = new Date(`${trimmed}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${trimmed}`)
  }
  return date.toISOString()
}

export async function provisionCustomerAction(formData: FormData) {
  const parsed = provisionCustomerSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
    billingModel: formData.get("billingModel") ?? "subscription",
    planCode: formData.get("planCode"),
    primaryEmail: formData.get("primaryEmail"),
    primaryName: formData.get("primaryName"),
    trialDays: formData.get("trialDays"),
  })

  if (!parsed.success) {
    const firstError = parsed.error.errors.at(0)?.message ?? "Please check the form fields."
    throw new Error(firstError)
  }

  const { user, orgId } = await requireAuth()
  await requireAnyPermission(["billing.manage", "platform.billing.manage"], {
    orgId: orgId ?? undefined,
    userId: user.id,
  })

  return provisionOrganization({
    name: parsed.data.name,
    slug: parsed.data.slug,
    billingModel: parsed.data.billingModel,
    planCode: parsed.data.planCode,
    primaryEmail: parsed.data.primaryEmail,
    primaryName: parsed.data.primaryName,
    trialDays: parsed.data.trialDays,
    createdBy: user.id,
  })
}

export async function extendCustomerTrialAction(formData: FormData) {
  const parsed = extendTrialSchema.safeParse({
    orgId: formData.get("orgId"),
    trialDays: formData.get("trialDays"),
  })

  if (!parsed.success) {
    throw new Error(parsed.error.errors.at(0)?.message ?? "Invalid trial extension request.")
  }

  const { user, orgId } = await requireAuth()
  await requireAnyPermission(["billing.manage", "platform.billing.manage"], {
    orgId: orgId ?? undefined,
    userId: user.id,
  })

  const supabase = createServiceSupabaseClient()
  const now = new Date()

  const { data: org, error: orgError } = await supabase
    .from("orgs")
    .select("id, billing_model")
    .eq("id", parsed.data.orgId)
    .maybeSingle()

  if (orgError || !org?.id) {
    throw new Error("Organization not found.")
  }

  if (org.billing_model !== "subscription") {
    throw new Error("Trials are only available for subscription billing model organizations.")
  }

  const { data: latestSubscription } = await supabase
    .from("subscriptions")
    .select("id, plan_code, trial_ends_at, current_period_end")
    .eq("org_id", parsed.data.orgId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  const currentEndRaw = latestSubscription?.trial_ends_at ?? latestSubscription?.current_period_end ?? null
  const currentEnd = currentEndRaw ? new Date(currentEndRaw) : null
  const baseDate = currentEnd && currentEnd > now ? currentEnd : now
  const nextTrialEnd = new Date(baseDate.getTime() + parsed.data.trialDays * 24 * 60 * 60 * 1000)

  if (latestSubscription?.id) {
    const { error: updateError } = await supabase
      .from("subscriptions")
      .update({
        status: "trialing",
        trial_ends_at: nextTrialEnd.toISOString(),
        current_period_end: nextTrialEnd.toISOString(),
      })
      .eq("id", latestSubscription.id)

    if (updateError) {
      throw new Error(updateError.message)
    }
  } else {
    const { error: insertError } = await supabase.from("subscriptions").insert({
      org_id: parsed.data.orgId,
      plan_code: null,
      status: "trialing",
      current_period_start: now.toISOString(),
      current_period_end: nextTrialEnd.toISOString(),
      trial_ends_at: nextTrialEnd.toISOString(),
    })

    if (insertError) {
      throw new Error(insertError.message)
    }
  }

  revalidatePath("/admin/customers")
  revalidatePath("/platform")
  revalidatePath("/")
}

export async function updateCustomerDetailsAction(formData: FormData) {
  const parsed = updateCustomerDetailsSchema.safeParse({
    orgId: formData.get("orgId"),
    name: formData.get("name"),
    slug: formData.get("slug"),
    status: formData.get("status"),
    billingModel: formData.get("billingModel"),
    billingEmail: formData.get("billingEmail") ?? "",
  })

  if (!parsed.success) {
    throw new Error(parsed.error.errors.at(0)?.message ?? "Invalid organization update request.")
  }

  const { user, orgId } = await requireAuth()
  await requireAnyPermission(["billing.manage", "platform.billing.manage"], {
    orgId: orgId ?? undefined,
    userId: user.id,
  })

  const supabase = createServiceSupabaseClient()

  const { data: existing, error: existingError } = await supabase
    .from("orgs")
    .select("id, name, slug, status, billing_model, billing_email")
    .eq("id", parsed.data.orgId)
    .maybeSingle()

  if (existingError || !existing?.id) {
    throw new Error("Organization not found.")
  }

  const { data: slugOwner, error: slugError } = await supabase
    .from("orgs")
    .select("id")
    .eq("slug", parsed.data.slug)
    .neq("id", parsed.data.orgId)
    .maybeSingle()

  if (slugError) {
    throw new Error(slugError.message)
  }

  if (slugOwner?.id) {
    throw new Error("That slug is already in use.")
  }

  const payload = {
    name: parsed.data.name,
    slug: parsed.data.slug,
    status: parsed.data.status,
    billing_model: parsed.data.billingModel,
    billing_email: parsed.data.billingEmail || null,
    updated_at: new Date().toISOString(),
  }

  const { error: updateError } = await supabase.from("orgs").update(payload).eq("id", parsed.data.orgId)
  if (updateError) {
    throw new Error(updateError.message)
  }

  await recordAudit({
    orgId: parsed.data.orgId,
    actorId: user.id,
    action: "update",
    entityType: "org",
    entityId: parsed.data.orgId,
    before: existing,
    after: payload,
    source: "platform_customers_org_edit",
  })

  revalidatePath("/admin/customers")
  revalidatePath("/platform")
  revalidatePath("/")
}

export async function updateCustomerSubscriptionAction(formData: FormData) {
  const parsed = updateCustomerSubscriptionSchema.safeParse({
    orgId: formData.get("orgId"),
    status: formData.get("status"),
    planCode: formData.get("planCode"),
    currentPeriodEnd: formData.get("currentPeriodEnd"),
    trialEndsAt: formData.get("trialEndsAt"),
    externalCustomerId: formData.get("externalCustomerId"),
    externalSubscriptionId: formData.get("externalSubscriptionId"),
  })

  if (!parsed.success) {
    throw new Error(parsed.error.errors.at(0)?.message ?? "Invalid subscription update request.")
  }

  const { user, orgId } = await requireAuth()
  await requireAnyPermission(["billing.manage", "platform.billing.manage"], {
    orgId: orgId ?? undefined,
    userId: user.id,
  })

  const supabase = createServiceSupabaseClient()
  const planCode = emptyToNull(parsed.data.planCode)
  const currentPeriodEnd = dateInputToIso(parsed.data.currentPeriodEnd)
  const trialEndsAt = parsed.data.status === "active" ? null : dateInputToIso(parsed.data.trialEndsAt)
  const externalCustomerId = emptyToNull(parsed.data.externalCustomerId)
  const externalSubscriptionId = emptyToNull(parsed.data.externalSubscriptionId)

  const { data: org, error: orgError } = await supabase
    .from("orgs")
    .select("id, billing_model")
    .eq("id", parsed.data.orgId)
    .maybeSingle()

  if (orgError || !org?.id) {
    throw new Error("Organization not found.")
  }

  if (org.billing_model !== "subscription") {
    throw new Error("Only subscription billing model organizations can have subscription state.")
  }

  if (planCode) {
    const { data: plan, error: planError } = await supabase
      .from("plans")
      .select("code")
      .eq("code", planCode)
      .eq("pricing_model", "subscription")
      .maybeSingle()

    if (planError || !plan?.code) {
      throw new Error("Subscription plan not found.")
    }
  }

  const existingResult = externalSubscriptionId
    ? await supabase
        .from("subscriptions")
        .select("*")
        .eq("external_subscription_id", externalSubscriptionId)
        .maybeSingle()
    : await supabase
        .from("subscriptions")
        .select("*")
        .eq("org_id", parsed.data.orgId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()

  if (existingResult.error) {
    throw new Error(existingResult.error.message)
  }

  const existing = existingResult.data
  if (existing?.org_id && existing.org_id !== parsed.data.orgId) {
    throw new Error("That Stripe subscription is already linked to a different organization.")
  }

  const payload = {
    plan_code: planCode,
    status: parsed.data.status,
    current_period_end: currentPeriodEnd,
    trial_ends_at: trialEndsAt,
    external_customer_id: externalCustomerId,
    external_subscription_id: externalSubscriptionId,
    updated_at: new Date().toISOString(),
  }

  if (existing?.id) {
    const { error: updateError } = await supabase.from("subscriptions").update(payload).eq("id", existing.id)
    if (updateError) {
      throw new Error(updateError.message)
    }
  } else {
    const { error: insertError } = await supabase.from("subscriptions").insert({
      org_id: parsed.data.orgId,
      current_period_start: new Date().toISOString(),
      ...payload,
    })

    if (insertError) {
      throw new Error(insertError.message)
    }
  }

  if (planCode) {
    await syncOrgEntitlementsFromPlan(parsed.data.orgId, planCode)
  } else {
    await supabase.from("entitlements").delete().eq("org_id", parsed.data.orgId).eq("source", "plan")
  }
  await recordAudit({
    orgId: parsed.data.orgId,
    actorId: user.id,
    action: existing?.id ? "update" : "insert",
    entityType: "subscription",
    entityId: existing?.id ?? externalSubscriptionId ?? undefined,
    before: existing ?? null,
    after: payload,
    source: "platform_customers_manual_edit",
  })

  revalidatePath("/admin/customers")
  revalidatePath("/platform")
  revalidatePath("/")
}

export async function deleteOrganizationAction(orgId: string) {
  if (!orgId || typeof orgId !== "string") {
    return { error: "Invalid organization ID" }
  }

  const { user } = await requireAuth()
  await requireAnyPermission(["billing.manage", "platform.billing.manage"], {
    userId: user.id,
  })

  const supabase = createServiceSupabaseClient()

  try {
    // 1. Clean up references in non-cascading tables
    const tablesToClean = [
      "impersonation_sessions",
      "authorization_audit_log",
      "closeout_items",
      "closeout_packages",
      "decisions",
    ]

    for (const table of tablesToClean) {
      const { error: cleanError } = await supabase
        .from(table)
        .delete()
        .eq("org_id", orgId)

      if (cleanError) {
        console.warn(`Note: safe cleanup warning for table "${table}":`, cleanError.message)
      }
    }

    // 2. Perform the deletion on the orgs table (which cascades cleanly to all other core tables)
    const { error: deleteError } = await supabase
      .from("orgs")
      .delete()
      .eq("id", orgId)

    if (deleteError) throw deleteError

    revalidatePath("/admin/customers")
    revalidatePath("/platform")
    revalidatePath("/")

    return { message: "Organization has been successfully removed." }
  } catch (error: any) {
    console.error("Failed to delete organization:", error)
    return { error: error?.message ?? "Failed to delete organization" }
  }
}
