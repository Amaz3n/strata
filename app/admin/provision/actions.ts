"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requireAuth } from "@/lib/auth/context"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const provisionSchema = z.object({
  orgName: z.string().min(2, "Org name is required"),
  primaryEmail: z.string().email("A valid email is required"),
  fullName: z.string().min(2, "Contact name is required"),
  planCode: z.string().trim().default("local-pro"),
  supportTier: z.string().trim().default("standard"),
  billingModel: z.enum(["subscription", "license"]).default("subscription"),
  region: z.string().trim().optional(),
})

async function resolveRoleId(client: ReturnType<typeof createServiceSupabaseClient>, key: string) {
  const { data, error } = await client.from("roles").select("id").eq("key", key).limit(1).maybeSingle()
  if (error || !data?.id) {
    throw new Error(`Role ${key} not found`)
  }
  return data.id as string
}

async function ensurePlan(client: ReturnType<typeof createServiceSupabaseClient>, planCode: string, billingModel: string) {
  const { data, error } = await client.from("plans").select("code").eq("code", planCode).maybeSingle()
  if (!error && data?.code) return

  const { error: insertError } = await client.from("plans").upsert({
    code: planCode,
    name: "Local Plan",
    pricing_model: billingModel,
    interval: "monthly",
    amount_cents: 0,
    currency: "usd",
    is_active: true,
    metadata: { created_by: "provision" },
  })

  if (insertError) {
    throw new Error(`Failed to ensure plan: ${insertError.message}`)
  }
}

async function inviteOrCreateUser(
  client: ReturnType<typeof createServiceSupabaseClient>,
  email: string,
  fullName: string,
) {
  const { data: existingUser } = await client.from("app_users").select("id").eq("email", email).maybeSingle()
  if (existingUser?.id) {
    return existingUser.id as string
  }

  const { data, error } = await client.auth.admin.inviteUserByEmail(email, { data: { full_name: fullName } })
  if (error || !data?.user) {
    throw new Error(`Failed to invite user: ${error?.message ?? "unknown error"}`)
  }
  return data.user.id
}

export async function provisionOrgAction(prevState: { error?: string; message?: string }, formData: FormData) {
  const parsed = provisionSchema.safeParse({
    orgName: formData.get("orgName"),
    primaryEmail: formData.get("primaryEmail"),
    fullName: formData.get("fullName"),
    planCode: formData.get("planCode"),
    supportTier: formData.get("supportTier"),
    billingModel: formData.get("billingModel"),
    region: formData.get("region"),
  })

  if (!parsed.success) {
    const firstError = parsed.error.errors.at(0)?.message ?? "Please check the form fields."
    return { error: firstError }
  }

  const { user } = await requireAuth()
  // Limit to admins who can manage billing/provisioning.
  await requirePermission("billing.manage", { userId: user.id })

  const serviceClient = createServiceSupabaseClient()

  const ownerRoleId = await resolveRoleId(serviceClient, "owner")
  await ensurePlan(serviceClient, parsed.data.planCode, parsed.data.billingModel)

  try {
    const primaryUserId = await inviteOrCreateUser(serviceClient, parsed.data.primaryEmail, parsed.data.fullName)

    const { data: org, error: orgError } = await serviceClient
      .from("orgs")
      .insert({
        name: parsed.data.orgName,
        billing_model: parsed.data.billingModel,
        billing_email: parsed.data.primaryEmail,
        status: "active",
        created_by: primaryUserId,
      })
      .select("id")
      .single()

    if (orgError || !org?.id) {
      throw new Error(orgError?.message ?? "Failed to create organization")
    }

    await serviceClient.from("org_settings").upsert({
      org_id: org.id,
      region: parsed.data.region ?? null,
      settings: {},
    })

    await serviceClient.from("memberships").upsert({
      org_id: org.id,
      user_id: primaryUserId,
      role_id: ownerRoleId,
      status: "active",
    })

    await serviceClient.from("subscriptions").upsert({
      org_id: org.id,
      plan_code: parsed.data.planCode,
      status: "active",
      current_period_start: new Date().toISOString(),
    })

    await serviceClient.from("support_contracts").upsert({
      org_id: org.id,
      status: "active",
      details: { tier: parsed.data.supportTier, created_by: user.id },
    })

    revalidatePath("/admin/provision")
    return { message: "Organization provisioned and invite sent to primary contact." }
  } catch (error: any) {
    console.error("Provisioning failed", error)
    return { error: error?.message ?? "Failed to provision organization" }
  }
}



