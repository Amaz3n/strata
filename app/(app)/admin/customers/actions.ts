"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requireAuth } from "@/lib/auth/context"
import { requireAnyPermission } from "@/lib/services/permissions"
import { provisionOrganization } from "@/lib/services/provisioning"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

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
