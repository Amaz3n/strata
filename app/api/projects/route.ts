import { NextResponse } from "next/server"

import { logger } from "@/lib/logging/logger"
import { requireOrgContext } from "@/lib/services/context"
import { listProjectNavigationItemsWithClient } from "@/lib/services/projects"

/**
 * On-demand project list for surfaces that need it only after an interaction —
 * the directory's invite picker, for example.
 *
 * The sidebar switcher does NOT read this. It renders from the layout's cached
 * chrome context, so its list is in the App Shell instead of arriving a round
 * trip after hydration.
 *
 * A failure here returns a real error status. It used to answer 200 with an
 * empty array, which callers could not tell apart from an org with no projects.
 */
export async function GET() {
  try {
    const { supabase, orgId } = await requireOrgContext()
    const projects = await listProjectNavigationItemsWithClient(supabase, orgId)
    return NextResponse.json({ projects })
  } catch (error) {
    logger.error("api.projects.list_failed", { route: "/api/projects", error })
    return NextResponse.json({ error: "Unable to load projects." }, { status: 500 })
  }
}
