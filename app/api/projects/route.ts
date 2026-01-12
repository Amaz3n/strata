import { NextResponse } from "next/server"

import { requireOrgContext } from "@/lib/services/context"
import { listProjectsWithClient } from "@/lib/services/projects"

export async function GET() {
  try {
    const { supabase, orgId } = await requireOrgContext()
    const projects = await listProjectsWithClient(supabase, orgId)
    return NextResponse.json({ projects })
  } catch (error) {
    return NextResponse.json({ projects: [] }, { status: 200 })
  }
}
