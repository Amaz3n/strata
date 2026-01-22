import { NextResponse } from "next/server"

import { requireAuth } from "@/lib/auth/context"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { isPlatformAdminId } from "@/lib/auth/platform"

export async function GET() {
  try {
    const { user } = await requireAuth()
    const isPlatformAdmin = isPlatformAdminId(user.id, user.email ?? undefined)

    if (isPlatformAdmin) {
      const svc = await createServerSupabaseClient()
      const { data, error } = await svc
        .from("orgs")
        .select("id, name, slug, billing_model")
        .order("created_at", { ascending: true })

      if (error) {
        return NextResponse.json({ orgs: [] }, { status: 200 })
      }

      return NextResponse.json({
        orgs: (data ?? []).map((row: any) => ({
          org_id: row.id,
          org_name: row.name,
          org_slug: row.slug ?? null,
          role_key: "platform",
          billing_model: row.billing_model ?? null,
        })),
      })
    }

    const supabase = await createServerSupabaseClient()
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
      return NextResponse.json({ orgs: [] }, { status: 200 })
    }

    return NextResponse.json({
      orgs: (data ?? []).map((row: any) => ({
        org_id: row.org_id as string,
        org_name: row.orgs?.name as string,
        org_slug: (row.orgs?.slug as string | null) ?? null,
        role_key: row.role?.key ?? null,
        billing_model: row.orgs?.billing_model ?? null,
      })),
    })
  } catch (error) {
    return NextResponse.json({ orgs: [] }, { status: 200 })
  }
}
