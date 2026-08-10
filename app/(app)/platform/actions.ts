"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"

import { requireAuth } from "@/lib/auth/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import {
  clearPlatformOrgContext,
  endImpersonationSession,
  findUserByEmail,
  setPlatformOrgContext,
  startImpersonationSession,
} from "@/lib/services/platform-session"
import { provisionOrganization } from "@/lib/services/provisioning"
import { setPlatformOrganizationStatus } from "@/lib/services/platform-access"
import { activateOrgBilling } from "@/lib/services/billing"
import { seedSampleProject } from "@/lib/services/demo-seed"
import { seedSampleCommunity } from "@/lib/services/demo-community-seed"
import { createOnboardingRun } from "@/lib/services/onboarding"
import { createOrgMemberInvite } from "@/lib/services/team"
import {
  AI_FEATURE_VALUES,
  AI_PROVIDER_VALUES,
  AI_TIER_VALUES,
  clearPlatformAiFeatureDefaultConfig,
  upsertPlatformAiFeatureDefaultConfig,
  validateAiProviderModelPair,
} from "@/lib/services/ai-config"
import { invalidateAiPriceCache } from "@/lib/services/ai/usage"
import { setOrgAiSearchAccess } from "@/lib/services/ai-search-access"
import { PRODUCT_TIERS } from "@/lib/product-tier"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

const enterOrgContextSchema = z.object({
  orgId: z.string().uuid("Invalid organization id"),
  reason: z.string().max(300).optional(),
})

const startImpersonationSchema = z.object({
  targetEmail: z.string().email("Valid user email is required"),
  reason: z.string().min(8, "Reason must be at least 8 characters"),
  orgId: z.string().uuid().optional(),
  expiresInMinutes: z.coerce.number().min(5).max(240).optional(),
})

const provisionPlatformOrgSchema = z.object({
  orgName: z.string().min(2, "Organization name is required"),
  slug: z.string().min(2, "Slug is required"),
  billingModel: z.enum(["subscription", "license"]).default("subscription"),
  productTier: z.enum(PRODUCT_TIERS).default("residential"),
  fullName: z.string().min(2, "Primary contact name is required"),
  primaryEmail: z.string().email("Valid email is required"),
  trialDays: z.coerce.number().int().min(1).max(60).optional(),
  amountDollars: z.coerce.number().positive("Amount must be greater than zero.").optional(),
  interval: z.enum(["month", "year"]).optional(),
  collectionMethod: z.enum(["checkout", "invoice"]).optional(),
  netDays: z.coerce.number().int().min(1).max(90).optional(),
  seedSampleProject: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  seedSampleCommunity: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  sendInvites: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  teamMembers: z
    .array(
      z.object({
        fullName: z.string().trim().optional(),
        email: z.string().trim().email("Valid team member email is required"),
        role: z.enum(["org_admin", "org_user"]).default("org_user"),
      }),
    )
    .default([]),
}).superRefine((data, ctx) => {
  const hasAmount = typeof data.amountDollars === "number" && Number.isFinite(data.amountDollars)
  if (!hasAmount) return
  if (data.billingModel !== "subscription") {
    ctx.addIssue({ code: "custom", path: ["amountDollars"], message: "Set-price billing is only available for subscriptions." })
  }
  if (!hasAmount) {
    ctx.addIssue({ code: "custom", path: ["amountDollars"], message: "Enter the negotiated amount." })
  }
  if (!data.interval) {
    ctx.addIssue({ code: "custom", path: ["interval"], message: "Choose a billing interval." })
  }
  if (!data.collectionMethod) {
    ctx.addIssue({ code: "custom", path: ["collectionMethod"], message: "Choose a payment method." })
  }
})

const setOrganizationStatusSchema = z.object({
  orgId: z.string().uuid("Invalid organization id"),
  status: z.enum(["active", "archived"]),
  reason: z.string().max(300).optional(),
})

const setAiSearchAccessSchema = z.object({
  orgId: z.string().uuid("Invalid organization id"),
  enabled: z.boolean(),
})

type PlatformOnboardingState = {
  error?: string
  message?: string
  checkoutUrl?: string
  orgId?: string
  orgName?: string
  invitedCount?: number
}

function parseTeamMembers(formData: FormData) {
  const names = formData.getAll("teamMemberName")
  const emails = formData.getAll("teamMemberEmail")
  const roles = formData.getAll("teamMemberRole")

  return emails
    .map((email, index) => ({
      fullName: String(names[index] ?? "").trim(),
      email: String(email ?? "").trim(),
      role: String(roles[index] ?? "org_user"),
    }))
    .filter((member) => member.email.length > 0)
}

export async function enterOrgContextAction(formData: FormData) {
  return run(async () => {
      const parsed = enterOrgContextSchema.safeParse({
        orgId: formData.get("orgId"),
        reason: formData.get("reason"),
      })

      if (!parsed.success) {
        throw new Error(parsed.error.errors[0]?.message ?? "Invalid context request")
      }

      const { user } = await requireAuth()
      await requirePermission("platform.org.access", { userId: user.id })
      await setPlatformOrgContext(parsed.data.orgId, parsed.data.reason)

      revalidatePath("/")
      redirect("/")
  })
}

export async function clearOrgContextAction() {
  return run(async () => {
      const { user } = await requireAuth()
      await requirePermission("platform.org.access", { userId: user.id })
      await clearPlatformOrgContext()

      revalidatePath("/")
      redirect("/platform")
  })
}

export async function startImpersonationAction(
  _prevState: { error?: string; message?: string },
  formData: FormData,
) {
  const parsed = startImpersonationSchema.safeParse({
    targetEmail: formData.get("targetEmail"),
    reason: formData.get("reason"),
    orgId: formData.get("orgId") || undefined,
    expiresInMinutes: formData.get("expiresInMinutes") || undefined,
  })

  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid impersonation input" }
  }

  const { user } = await requireAuth()
  await requirePermission("impersonation.start", { userId: user.id })

  const target = await findUserByEmail(parsed.data.targetEmail)
  if (!target?.id) {
    return { error: "No user found for that email." }
  }

  if (target.id === user.id) {
    return { error: "You cannot impersonate your own account." }
  }

  try {
    await startImpersonationSession({
      targetUserId: target.id,
      orgId: parsed.data.orgId,
      reason: parsed.data.reason,
      expiresInMinutes: parsed.data.expiresInMinutes,
    })
  } catch (error: any) {
    return { error: error?.message ?? "Unable to start impersonation session." }
  }

  revalidatePath("/")
  revalidatePath("/platform")
  return {
    message: `Impersonation session started for ${target.full_name ?? target.email ?? target.id}.`,
  }
}

export async function endImpersonationAction() {
  return run(async () => {
      const { user } = await requireAuth()
      await requirePermission("impersonation.end", { userId: user.id })
      await endImpersonationSession()

      revalidatePath("/")
      revalidatePath("/platform")
      redirect("/platform")
  })
}

export async function provisionPlatformOrgAction(
  _prevState: PlatformOnboardingState,
  formData: FormData,
): Promise<PlatformOnboardingState> {
  const parsed = provisionPlatformOrgSchema.safeParse({
    orgName: formData.get("orgName"),
    slug: formData.get("slug") ?? formData.get("orgSlug"),
    billingModel: formData.get("billingModel") ?? "subscription",
    productTier: formData.get("productTier") ?? "residential",
    fullName: formData.get("fullName"),
    primaryEmail: formData.get("primaryEmail"),
    trialDays: formData.get("trialDays"),
    amountDollars: formData.get("amountDollars") || undefined,
    interval: formData.get("interval") || undefined,
    collectionMethod: formData.get("collectionMethod") || undefined,
    netDays: formData.get("netDays") || undefined,
    seedSampleProject: formData.get("seedSampleProject") ?? "true",
    seedSampleCommunity: formData.get("seedSampleCommunity") ?? "false",
    sendInvites: formData.get("sendInvites") ?? "false",
    teamMembers: parseTeamMembers(formData),
  })

  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Please check the form fields." }
  }

  const { user } = await requireAuth()
  await requireAnyPermission(["billing.manage", "platform.billing.manage"], { userId: user.id })

  try {
    const org = await provisionOrganization({
      name: parsed.data.orgName,
      slug: parsed.data.slug,
      billingModel: parsed.data.billingModel,
      planCode: null,
      primaryEmail: parsed.data.primaryEmail,
      primaryName: parsed.data.fullName,
      trialDays: parsed.data.trialDays,
      createdBy: user.id,
      sendInviteEmail: parsed.data.sendInvites,
      productTier: parsed.data.productTier,
    })

    const serviceSupabase = createServiceSupabaseClient()
    const primaryEmail = parsed.data.primaryEmail.trim().toLowerCase()
    const teamMembers = parsed.data.teamMembers.filter((member) => member.email.trim().toLowerCase() !== primaryEmail)

    for (const member of teamMembers) {
      await createOrgMemberInvite({
        supabase: serviceSupabase,
        orgId: org.id,
        actorUserId: user.id,
        fullName: member.fullName,
        email: member.email,
        role: member.role,
        sendEmail: parsed.data.sendInvites,
      })
    }

    let checkoutUrl: string | undefined
    let invoiceCollection = false
    if (parsed.data.billingModel === "subscription" && parsed.data.amountDollars && parsed.data.interval && parsed.data.collectionMethod) {
      const activation = await activateOrgBilling({
        orgId: org.id,
        amountCents: Math.round(parsed.data.amountDollars * 100),
        interval: parsed.data.interval,
        collectionMethod: parsed.data.collectionMethod,
        netDays: parsed.data.collectionMethod === "invoice" ? parsed.data.netDays ?? 30 : undefined,
        actorUserId: user.id,
      })
      checkoutUrl = activation.checkoutUrl ?? undefined
      invoiceCollection = parsed.data.collectionMethod === "invoice"
    }

    let seedWarning = ""
    if (parsed.data.productTier === "production") {
      try {
        await createOnboardingRun({ orgId: org.id })
      } catch (onboardingError) {
        console.error("Failed to create production onboarding run", onboardingError)
        seedWarning += " The production onboarding run could not be created automatically."
      }
    }
    if (parsed.data.productTier === "production" && parsed.data.seedSampleCommunity) {
      try {
        await seedSampleCommunity(org.id, user.id)
      } catch (sampleCommunityError) {
        console.error("Failed to seed sample production community", sampleCommunityError)
        seedWarning += " Sample community seeding failed; the org was still created."
      }
    }
    if (parsed.data.seedSampleProject) {
      try {
        await seedSampleProject(org.id, user.id)
      } catch (seedError) {
        console.error("Failed to seed sample project", seedError)
        seedWarning += " Sample project seeding failed; the org was still created."
      }
    }

    revalidatePath("/platform")
    revalidatePath("/admin")
    revalidatePath("/admin/customers")

    return {
      message: checkoutUrl
        ? parsed.data.sendInvites
          ? "Client org created. Send the Stripe Checkout link to finish subscription setup."
          : "Client org created without sending workspace invites. Send the Stripe Checkout link to finish subscription setup."
        : invoiceCollection
          ? `Client org created. Stripe will email the invoice to ${parsed.data.primaryEmail}.`
          : parsed.data.sendInvites
            ? `Client org created and workspace invites sent.${seedWarning}`
            : `Client org created without sending workspace invites.${seedWarning}`,
      checkoutUrl,
      orgId: org.id,
      orgName: org.name,
      invitedCount: teamMembers.length + 1,
    }
  } catch (error: any) {
    console.error("Failed to provision organization from platform", error)
    return { error: error?.message ?? "Failed to provision organization." }
  }
}

export async function setOrganizationStatusAction(formData: FormData) {
  return run(async () => {
      const parsed = setOrganizationStatusSchema.safeParse({
        orgId: formData.get("orgId"),
        status: formData.get("status"),
        reason: formData.get("reason"),
      })

      if (!parsed.success) {
        throw new Error(parsed.error.errors[0]?.message ?? "Invalid status update request.")
      }

      const { user } = await requireAuth()
      await requireAnyPermission(["platform.billing.manage", "platform.support.write"], { userId: user.id })

      await setPlatformOrganizationStatus({
        orgId: parsed.data.orgId,
        status: parsed.data.status,
        reason: parsed.data.reason,
        actorUserId: user.id,
      })

      revalidatePath("/platform")
      revalidatePath("/admin/customers")
      revalidatePath("/")
  })
}

export async function setAiSearchAccessAction(input: { orgId: string; enabled: boolean }) {
  return run(async () => {
      // Throw rather than return an error object: `run` turns a thrown error into
      // the { success: false, error } envelope, so a failure never arrives wrapped
      // in a successful result the caller has to unpack a second time.
      const parsed = setAiSearchAccessSchema.safeParse(input)
      if (!parsed.success) {
        throw new Error(parsed.error.errors[0]?.message ?? "Invalid AI search access request.")
      }

      const { user } = await requireAuth()
      await requireAnyPermission(["platform.feature_flags.manage", "billing.manage"], { userId: user.id })

      await setOrgAiSearchAccess({
        orgId: parsed.data.orgId,
        enabled: parsed.data.enabled,
        actorId: user.id,
      })

      revalidatePath("/platform")
      return { success: true as const, orgId: parsed.data.orgId, enabled: parsed.data.enabled }
  })
}

// ---------------------------------------------------------------------------
// AI telemetry and controls
// ---------------------------------------------------------------------------

const updateAiTierSchema = z.object({
  feature: z.enum(AI_FEATURE_VALUES),
  tier: z.enum(AI_TIER_VALUES),
  provider: z.enum(AI_PROVIDER_VALUES),
  // Free text on purpose: a model released after this code shipped must be
  // selectable without a deploy. OpenRouter ids are namespaced (`qwen/...`).
  model: z.string().trim().min(1).max(200),
})

export async function updateAiTierModelAction(input: unknown) {
  return run(async () => {
    const parsed = updateAiTierSchema.safeParse(input)
    if (!parsed.success) throw new Error(parsed.error.errors[0]?.message ?? "Invalid model routing.")

    const { user } = await requireAuth()
    await requireAnyPermission(["platform.feature_flags.manage", "billing.manage"], { userId: user.id })

    const { feature, tier, provider, model } = parsed.data
    const mismatch = validateAiProviderModelPair(provider, model)
    if (mismatch) throw new Error(mismatch)

    await upsertPlatformAiFeatureDefaultConfig({
      supabase: createServiceSupabaseClient(),
      feature,
      tier,
      provider,
      model,
      updatedBy: user.id,
    })

    revalidatePath("/platform")
    return { success: true as const, feature, tier, provider, model }
  })
}

export async function clearAiTierModelAction(input: unknown) {
  return run(async () => {
    const parsed = z
      .object({ feature: z.enum(AI_FEATURE_VALUES), tier: z.enum(AI_TIER_VALUES) })
      .safeParse(input)
    if (!parsed.success) throw new Error("Invalid feature or tier.")

    const { user } = await requireAuth()
    await requireAnyPermission(["platform.feature_flags.manage", "billing.manage"], { userId: user.id })

    await clearPlatformAiFeatureDefaultConfig({
      supabase: createServiceSupabaseClient(),
      feature: parsed.data.feature,
      tier: parsed.data.tier,
    })

    revalidatePath("/platform")
    return { success: true as const }
  })
}

const modelPriceSchema = z.object({
  provider: z.enum(AI_PROVIDER_VALUES),
  model: z.string().trim().min(1).max(200),
  inputPerMTokUsd: z.number().min(0).max(10_000).nullable(),
  outputPerMTokUsd: z.number().min(0).max(10_000).nullable(),
})

/**
 * Record what a model costs. This is what converts an "unpriced" call — which
 * the ledger reports as null rather than zero — into real spend.
 */
export async function setAiModelPriceAction(input: unknown) {
  return run(async () => {
    const parsed = modelPriceSchema.safeParse(input)
    if (!parsed.success) throw new Error(parsed.error.errors[0]?.message ?? "Invalid price.")

    const { user } = await requireAuth()
    await requireAnyPermission(["platform.feature_flags.manage", "billing.manage"], { userId: user.id })

    const supabase = createServiceSupabaseClient()
    const { provider, model, inputPerMTokUsd, outputPerMTokUsd } = parsed.data
    const key = `${provider}:${model.replace(/^models\//, "")}`

    const { data: existing } = await supabase
      .from("platform_settings")
      .select("value")
      .eq("key", "ai_model_prices")
      .maybeSingle()

    const current =
      existing?.value && typeof existing.value === "object" && !Array.isArray(existing.value)
        ? (existing.value as Record<string, unknown>)
        : {}

    const next = {
      ...current,
      [key]: { input_per_mtok_usd: inputPerMTokUsd, output_per_mtok_usd: outputPerMTokUsd },
    }

    const { error } = await supabase
      .from("platform_settings")
      .upsert({ key: "ai_model_prices", value: next, updated_by: user.id }, { onConflict: "key" })
    if (error) throw new Error(error.message ?? "Unable to save the model price.")

    invalidateAiPriceCache()
    revalidatePath("/platform")
    return { success: true as const, key }
  })
}
