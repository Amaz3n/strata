import { NextResponse } from "next/server"

import { requireAuth } from "@/lib/auth/context"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { hasPlatformAccessByUserId } from "@/lib/services/platform-access"

export async function GET() {
  try {
    const { user } = await requireAuth()
    const isPlatformAdmin = await hasPlatformAccessByUserId(user.id, user.email ?? undefined)

    if (isPlatformAdmin) {
      const svc = await createServerSupabaseClient()
      const { data, error } = await svc
        .from("orgs")
        .select("id, name, slug, logo_url, billing_model")
        .order("created_at", { ascending: true })

      if (error) {
        return NextResponse.json({ orgs: [], canCreateOrganization: true }, { status: 200 })
      }

      return NextResponse.json({
        orgs: (data ?? []).map((row: any) => ({
          org_id: row.id,
          org_name: row.name,
          org_slug: row.slug ?? null,
          logo_url: row.logo_url ?? null,
          role_key: "platform",
          billing_model: row.billing_model ?? null,
        })),
        canCreateOrganization: true,
      })
    }

    const supabase = await createServerSupabaseClient()
    const { data, error } = await supabase
      .from("memberships")
      .select(
        `
        org_id,
        role:roles!memberships_role_id_fkey(key),
        orgs!inner(id, name, slug, logo_url, billing_model)
      `,
      )
      .eq("user_id", user.id)
      .eq("status", "active")
      .order("created_at", { ascending: true })

    if (error) {
      return NextResponse.json({ orgs: [], canCreateOrganization: false }, { status: 200 })
    }

    return NextResponse.json({
      orgs: (data ?? []).map((row: any) => ({
        org_id: row.org_id as string,
        org_name: row.orgs?.name as string,
        org_slug: (row.orgs?.slug as string | null) ?? null,
        logo_url: (row.orgs?.logo_url as string | null) ?? null,
        role_key: row.role?.key ?? null,
        billing_model: row.orgs?.billing_model ?? null,
      })),
      canCreateOrganization: false,
    })
  } catch (error) {
    return NextResponse.json({ orgs: [], canCreateOrganization: false }, { status: 200 })
  }
}
