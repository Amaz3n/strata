"use server"

import { z } from "zod"

import { requireAuth } from "@/lib/auth/context"
import { requirePermission } from "@/lib/services/permissions"
import { provisionOrganization } from "@/lib/services/provisioning"

const provisionCustomerSchema = z.object({
  name: z.string().min(2, "Organization name is required"),
  slug: z.string().min(2, "Slug is required"),
  billingModel: z.enum(["subscription", "license"]),
  planCode: z.string().optional(),
  primaryEmail: z.string().email("Valid email is required"),
  primaryName: z.string().min(2, "Primary contact name is required"),
  trialDays: z.coerce.number().optional(),
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
  await requirePermission("billing.manage", { orgId: orgId ?? undefined, userId: user.id })

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
