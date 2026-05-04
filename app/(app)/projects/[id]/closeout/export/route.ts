import { NextResponse } from "next/server"

import { requireOrgContext } from "@/lib/services/context"
import { renderCloseoutPdf } from "@/lib/pdfs/closeout"

const baseCloseoutItemSelect = "title, status"
const extendedCloseoutItemSelect = "title, status, due_date, responsible_party, notes"

function isMissingCloseoutOptionalColumnError(error: { message?: string } | null | undefined) {
  const message = error?.message ?? ""
  return (
    message.includes("column closeout_items.due_date does not exist") ||
    message.includes("column closeout_items.responsible_party does not exist") ||
    message.includes("column closeout_items.notes does not exist")
  )
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const { supabase, orgId } = await requireOrgContext()

  const loadItems = async (selectClause: string) =>
    supabase
      .from("closeout_items")
      .select(selectClause)
      .eq("org_id", orgId)
      .eq("project_id", id)
      .order("created_at", { ascending: true })

  const [projectResult, packageResult, orgResult, itemsResult] = await Promise.all([
    supabase.from("projects").select("id, name").eq("org_id", orgId).eq("id", id).maybeSingle(),
    supabase.from("closeout_packages").select("id, status").eq("org_id", orgId).eq("project_id", id).maybeSingle(),
    supabase.from("orgs").select("name").eq("id", orgId).maybeSingle(),
    loadItems(extendedCloseoutItemSelect),
  ])

  const resolvedItemsResult =
    itemsResult.error && isMissingCloseoutOptionalColumnError(itemsResult.error) ? await loadItems(baseCloseoutItemSelect) : itemsResult

  if (projectResult.error || !projectResult.data) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 })
  }

  const pdf = await renderCloseoutPdf({
    orgName: orgResult.data?.name ?? undefined,
    projectName: projectResult.data?.name ?? undefined,
    status: packageResult.data?.status ?? "in_progress",
    items: ((resolvedItemsResult.data as any[]) ?? []).map((item) => ({
      title: item.title,
      status: item.status ?? "missing",
      dueDate: item.due_date ?? undefined,
      responsibleParty: item.responsible_party ?? undefined,
      notes: item.notes ?? undefined,
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
