"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/auth/context"
import { requireAnyPermission } from "@/lib/services/permissions"

const createPlanSchema = z.object({
  code: z.string().min(1, "Plan code is required").regex(/^[a-z0-9-]+$/, "Code must contain only lowercase letters, numbers, and hyphens"),
  name: z.string().min(1, "Plan name is required"),
  pricingModel: z.enum(["subscription", "license"]),
  interval: z.string().optional(),
  amountCents: z.number().min(0, "Amount must be non-negative"),
  currency: z.string().default("usd"),
  description: z.string().optional(),
  stripePriceId: z.string().optional(),
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
    stripePriceId: formData.get("stripePriceId"),
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
          created_by: user.id,
        },
      })

    if (error) throw error

    revalidatePath("/admin/plans")
    return { message: "Subscription plan created successfully." }
  } catch (error: any) {
    console.error("Failed to create plan:", error)
    return { error: error?.message ?? "Failed to create subscription plan" }
  }
}
