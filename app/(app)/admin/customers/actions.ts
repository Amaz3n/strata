"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requireAuth } from "@/lib/auth/context"
import { requireAnyPermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { PRODUCT_TIERS } from "@/lib/product-tier"
import { activateOrgBilling, syncOrgEntitlementsFromPlan } from "@/lib/services/billing"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

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
  productTier: z.enum(PRODUCT_TIERS),
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

const activateCustomerBillingSchema = z.object({
  orgId: z.string().uuid("Invalid organization id"),
  amountDollars: z.coerce.number().positive("Amount must be greater than zero."),
  interval: z.enum(["month", "year"]),
  collectionMethod: z.enum(["checkout", "invoice"]),
  netDays: z.coerce.number().int().min(1).max(90).optional(),
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

export async function extendCustomerTrialAction(formData: FormData) {
  return run(async () => {
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
  })
}

export async function activateCustomerBillingAction(formData: FormData) {
  return run(async () => {
      const parsed = activateCustomerBillingSchema.safeParse({
        orgId: formData.get("orgId"),
        amountDollars: formData.get("amountDollars"),
        interval: formData.get("interval") ?? "month",
        collectionMethod: formData.get("collectionMethod") ?? "checkout",
        netDays: formData.get("netDays") || undefined,
      })

      if (!parsed.success) {
        return { error: parsed.error.errors.at(0)?.message ?? "Invalid billing activation request." }
      }

      const { user, orgId } = await requireAuth()
      await requireAnyPermission(["billing.manage", "platform.billing.manage"], {
        orgId: orgId ?? undefined,
        userId: user.id,
      })

      try {
        const result = await activateOrgBilling({
          orgId: parsed.data.orgId,
          amountCents: Math.round(parsed.data.amountDollars * 100),
          interval: parsed.data.interval,
          collectionMethod: parsed.data.collectionMethod,
          netDays: parsed.data.collectionMethod === "invoice" ? parsed.data.netDays ?? 30 : undefined,
          actorUserId: user.id,
        })

        revalidatePath("/admin/customers")
        revalidatePath("/platform")
        revalidatePath("/")
        return { success: true, checkoutUrl: result.checkoutUrl, planCode: result.planCode }
      } catch (error: any) {
        console.error("Failed to activate billing", error)
        return { error: error?.message ?? "Failed to activate billing." }
      }
  })
}

export async function updateCustomerDetailsAction(formData: FormData) {
  return run(async () => {
      const parsed = updateCustomerDetailsSchema.safeParse({
        orgId: formData.get("orgId"),
        name: formData.get("name"),
        slug: formData.get("slug"),
        status: formData.get("status"),
        billingModel: formData.get("billingModel"),
        billingEmail: formData.get("billingEmail") ?? "",
        productTier: formData.get("productTier"),
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
        .select("id, name, slug, status, billing_model, billing_email, product_tier")
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
        product_tier: parsed.data.productTier,
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

      if (existing.product_tier !== parsed.data.productTier) {
        await recordEvent({
          orgId: parsed.data.orgId,
          actorId: user.id,
          eventType: "org.product_tier_changed",
          entityType: "org",
          entityId: parsed.data.orgId,
          payload: {
            from: existing.product_tier,
            to: parsed.data.productTier,
          },
        })
      }

      revalidatePath("/admin/customers")
      revalidatePath("/platform")
      revalidatePath("/")
  })
}

export async function updateCustomerSubscriptionAction(formData: FormData) {
  return run(async () => {
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
  })
}

export async function deleteOrganizationAction(orgId: string) {
  return run(async () => {
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
  })
}
