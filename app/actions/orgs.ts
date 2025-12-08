"use server"

import { cookies } from "next/headers"

import { requireAuth } from "@/lib/auth/context"
import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase/server"
import { getOrgOnboardingState } from "@/lib/services/orgs"
import { isPlatformAdminId } from "@/lib/auth/platform"

export interface OrgMembershipSummary {
  org_id: string
  org_name: string
  org_slug: string | null
  role_key: string | null
  billing_model: string | null
}

export async function listMembershipsAction(): Promise<OrgMembershipSummary[]> {
  const { user } = await requireAuth()
  const isPlatformAdmin = isPlatformAdminId(user.id, user.email ?? undefined)

  if (isPlatformAdmin) {
    const svc = createServiceSupabaseClient()
    const { data, error } = await svc
      .from("orgs")
      .select("id, name, slug, billing_model")
      .order("created_at", { ascending: true })

    if (error) {
      console.error("Failed to load orgs for platform admin", error)
      return []
    }

    return (data ?? []).map((row: any) => ({
      org_id: row.id,
      org_name: row.name,
      org_slug: row.slug ?? null,
      role_key: "platform",
      billing_model: row.billing_model ?? null,
    }))
  }

  const supabase = createServerSupabaseClient()

  const { data, error } = await supabase
    .from("memberships")
    .select(
      `
      org_id,
      role:roles!memberships_role_id_fkey(key),
      orgs!inner(id, name, slug, billing_model)
    `,
    )
    .eq("user_id", user.id)
    .eq("status", "active")
    .order("created_at", { ascending: true })

  if (error) {
    console.error("Failed to load memberships", error)
    return []
  }

  return (data ?? []).map((row: any) => ({
    org_id: row.org_id as string,
    org_name: row.orgs?.name as string,
    org_slug: (row.orgs?.slug as string | null) ?? null,
    role_key: row.role?.key ?? null,
    billing_model: row.orgs?.billing_model ?? null,
  }))
}

export async function switchOrgAction(orgId: string) {
  if (!orgId) return
  const { user } = await requireAuth()
  const supabase = createServerSupabaseClient()

  // Verify membership to avoid setting an invalid org.
  const { data, error } = await supabase
    .from("memberships")
    .select("id")
    .eq("user_id", user.id)
    .eq("org_id", orgId)
    .eq("status", "active")
    .limit(1)
    .maybeSingle()

  if (error || !data) {
    console.error("Org switch denied (no membership)", error)
    throw new Error("You do not have access to this organization.")
  }

  const cookieStore = await cookies()
  cookieStore.set({
    name: "org_id",
    value: orgId,
    path: "/",
    httpOnly: false,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30,
  })
}

export async function getOnboardingStateAction() {
  return getOrgOnboardingState()
}

