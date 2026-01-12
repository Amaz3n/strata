import { NextResponse } from "next/server"

import { requireOrgContext } from "@/lib/services/context"
import { renderCloseoutPdf } from "@/lib/pdfs/closeout"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const { supabase, orgId } = await requireOrgContext()

  const [projectResult, packageResult, orgResult, itemsResult] = await Promise.all([
    supabase.from("projects").select("id, name").eq("org_id", orgId).eq("id", id).maybeSingle(),
    supabase.from("closeout_packages").select("id, status").eq("org_id", orgId).eq("project_id", id).maybeSingle(),
    supabase.from("orgs").select("name").eq("id", orgId).maybeSingle(),
    supabase.from("closeout_items").select("title, status").eq("org_id", orgId).eq("project_id", id).order("created_at", { ascending: true }),
  ])

  if (projectResult.error || !projectResult.data) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 })
  }

  const pdf = await renderCloseoutPdf({
    orgName: orgResult.data?.name ?? undefined,
    projectName: projectResult.data?.name ?? undefined,
    status: packageResult.data?.status ?? "in_progress",
    items: (itemsResult.data ?? []).map((item) => ({
      title: item.title,
      status: item.status ?? "missing",
    })),
  })

  const filename = `closeout-${projectResult.data?.name ?? id}.pdf`

  return new NextResponse(pdf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
    },
  })
}
