import { NextResponse } from "next/server"

import { listMembershipsAction } from "@/app/actions/orgs"
import { requireAuth } from "@/lib/auth/context"
import { hasPlatformAccessByUserId } from "@/lib/services/platform-access"

export async function GET() {
  try {
    const { user } = await requireAuth()
    const [orgs, canCreateOrganization] = await Promise.all([
      listMembershipsAction(),
      hasPlatformAccessByUserId(user.id, user.email),
    ])
    return NextResponse.json({ orgs, canCreateOrganization })
  } catch (error) {
    console.error("Failed to load organizations", error)
    return NextResponse.json({ orgs: [], canCreateOrganization: false }, { status: 200 })
  }
}
