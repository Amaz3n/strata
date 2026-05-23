"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/auth/context"
import { requireAnyPermission } from "@/lib/services/permissions"
import { allBillingFeatureKeys, BILLING_FEATURE_CATALOG } from "@/lib/billing-feature-catalog"
import { ensureBillingFeatureCatalog } from "@/lib/services/billing"

const createPlanSchema = z.object({
  code: z.string().min(1, "Plan code is required").regex(/^[a-z0-9-]+$/, "Code must contain only lowercase letters, numbers, and hyphens"),
  name: z.string().min(1, "Plan name is required"),
  pricingModel: z.enum(["subscription", "license"]),
  interval: z.string().optional(),
  amountCents: z.number().min(0, "Amount must be non-negative"),
  currency: z.string().default("usd"),
  description: z.string().optional(),
  packageType: z.enum(["full_access", "custom"]).default("full_access"),
  publicName: z.string().optional(),
  internalNotes: z.string().optional(),
  stripePriceId: z.string().optional(),
  featureKeys: z.array(z.enum(BILLING_FEATURE_CATALOG.map((feature) => feature.key) as [string, ...string[]])).default([]),
  isActive: z.boolean().default(true),
})

export async function createPlanAction(prevState: { error?: string; message?: string }, formData: FormData) {
  const parsed = createPlanSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
    pricingModel: formData.get("pricingModel"),
    interval: formData.get("interval"),
    amountCents: parseInt(formData.get("amountCents") as string) || 0,
    currency: formData.get("currency") || "usd",
    description: formData.get("description"),
    packageType: formData.get("packageType") || "full_access",
    publicName: formData.get("publicName"),
    internalNotes: formData.get("internalNotes"),
    stripePriceId: formData.get("stripePriceId"),
    featureKeys: formData.getAll("featureKeys"),
    isActive: formData.get("isActive") === "true",
  })

  if (!parsed.success) {
    const firstError = parsed.error.errors.at(0)?.message ?? "Please check the form fields."
    return { error: firstError }
  }

  const { user } = await requireAuth()
  await requireAnyPermission(["billing.manage", "platform.billing.manage"], { userId: user.id })

  const supabase = createServiceSupabaseClient()

  try {
    await ensureBillingFeatureCatalog()
    const featureKeys =
      parsed.data.packageType === "full_access"
        ? allBillingFeatureKeys()
        : Array.from(new Set(parsed.data.featureKeys))

    if (featureKeys.length === 0) {
      return { error: "Select at least one feature for a custom package." }
    }

    const { error } = await supabase
      .from("plans")
      .insert({
        code: parsed.data.code,
        name: parsed.data.name,
        pricing_model: parsed.data.pricingModel,
        interval: parsed.data.pricingModel === "subscription" ? parsed.data.interval : null,
        amount_cents: parsed.data.amountCents,
        currency: parsed.data.currency,
        is_active: parsed.data.isActive,
        stripe_price_id: parsed.data.stripePriceId || null,
        metadata: {
          description: parsed.data.description,
          package_type: parsed.data.packageType,
          public_name: parsed.data.publicName || parsed.data.name,
          internal_notes: parsed.data.internalNotes,
          created_by: user.id,
        },
      })

    if (error) throw error

    const { error: featureError } = await supabase.from("plan_feature_limits").insert(
      featureKeys.map((featureKey) => ({
        plan_code: parsed.data.code,
        feature_key: featureKey,
        limit_type: "enabled",
        limit_value: 1,
        metadata: {},
      })),
    )

    if (featureError) throw featureError

    revalidatePath("/admin/plans")
    return { message: "Subscription plan created successfully." }
  } catch (error: any) {
    console.error("Failed to create plan:", error)
    return { error: error?.message ?? "Failed to create subscription plan" }
  }
}

export async function deletePlanAction(planCode: string) {
  const { user } = await requireAuth()
  await requireAnyPermission(["billing.manage", "platform.billing.manage"], { userId: user.id })

  if (!planCode || typeof planCode !== "string") {
    return { error: "Invalid plan code" }
  }

  const supabase = createServiceSupabaseClient()

  try {
    // 1. Check if the plan is in use by subscriptions
    const { count: subscriptionCount, error: subError } = await supabase
      .from("subscriptions")
      .select("*", { count: "exact", head: true })
      .eq("plan_code", planCode)

    if (subError) throw subError

    // 2. Check if the plan is in use by licenses
    const { count: licenseCount, error: licError } = await supabase
      .from("licenses")
      .select("*", { count: "exact", head: true })
      .eq("plan_code", planCode)

    if (licError) throw licError

    if ((subscriptionCount ?? 0) > 0 || (licenseCount ?? 0) > 0) {
      const parts = []
      if ((subscriptionCount ?? 0) > 0) parts.push(`${subscriptionCount} subscription(s)`)
      if ((licenseCount ?? 0) > 0) parts.push(`${licenseCount} license(s)`)
      return {
        error: `Cannot delete plan "${planCode}" because it is currently in use by ${parts.join(" and ")}. Please deactivate the plan instead.`
      }
    }

    // 3. Delete the plan (this will cascade delete plan_feature_limits)
    const { error: deleteError } = await supabase
      .from("plans")
      .delete()
      .eq("code", planCode)

    if (deleteError) throw deleteError

    revalidatePath("/admin/plans")
    return { message: `Plan "${planCode}" has been successfully removed.` }
  } catch (error: any) {
    console.error("Failed to delete plan:", error)
    return { error: error?.message ?? "Failed to delete subscription plan" }
  }
}

