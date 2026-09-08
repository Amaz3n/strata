import { evidenceAccepted } from "@/lib/lien-waivers/coverage"
import { NextRequest, NextResponse } from "next/server"
import { getProjectWaiverRegister } from "@/lib/services/waiver-register"
import { resolveProductionDeskScope } from "@/lib/services/production-desk-scope"
import { listProjects } from "@/lib/services/projects"
import { requireOrgContext } from "@/lib/services/context"
import { downloadFilesObject } from "@/lib/storage/files-storage"
export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams,
      projectId = q.get("projectId"),
      scope = await resolveProductionDeskScope({
        communityId: q.get("community") ?? undefined,
      })
    const ids = projectId
      ? [projectId]
      : (await listProjects())
          .map((p) => p.id)
          .filter((id) => !scope.projectIds || scope.projectIds.includes(id))
    const register = await getProjectWaiverRegister(
      "",
      q.get("periodEnd") ?? "",
      undefined,
      {
        projectIds: ids,
        search: q.get("q") ?? undefined,
        status: q.get("status") ?? "outstanding",
        exportAll: true,
      },
    )
    if (q.get("format") !== "pdf") {
      const cell = (v: unknown) =>
        `"${String(v ?? "")
          .replace(/^[=+@-]/, "'$&")
          .replaceAll('"', '""')}"`
      const rows = [
        [
          "Vendor",
          "Project",
          "Bill",
          "Through",
          "Bill cents",
          "Paid cents",
          "Held cents",
          "Status",
          "Issues",
        ],
        ...register.entries.map((e) => [
          e.companyName,
          e.projectName,
          e.bill.bill_number,
          e.coverage.through,
          e.bill.total_cents,
          e.bill.paid_cents ?? 0,
          e.coverage.heldCents,
          e.coverage.status,
          e.coverage.reasons.join("; "),
        ]),
        ...register.unbilledClaimants.map((r) => [
          r.claimant_company_name,
          r.projectName,
          "Awaiting payable",
          r.period_end,
          r.amount_cents,
          0,
          0,
          r.received ? "Accepted" : "Outstanding",
          r.metadata?.amount_needs_review ? "Review required amount" : "",
        ]),
      ]
      return new NextResponse(
        rows.map((r) => r.map(cell).join(",")).join("\r\n"),
        {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="waiver-register.csv"',
            "Cache-Control": "private, no-store",
          },
        },
      )
    }
    const ctx = await requireOrgContext(),
      { PDFDocument, StandardFonts } = await import("pdf-lib"),
      pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica)
    let page = pdf.addPage(),
      y = page.getHeight() - 45
    const line = (text: string) => {
      if (y < 45) {
        page = pdf.addPage()
        y = page.getHeight() - 45
      }
      page.drawText(text.replace(/[^\x20-\x7E]/g, "?").slice(0, 105), {
        x: 35,
        y,
        size: 9,
        font,
      })
      y -= 15
    }
    line("Accepted waiver packet - coverage index")
    line("Drafts, pending review, and rejected evidence are excluded.")
    line(`Generated ${new Date().toISOString()} | ${register.total} payables`)
    const fileIds = new Set<string>()
    for (const e of register.entries) {
      line(
        `${e.companyName} | ${e.projectName} | ${e.bill.bill_number ?? e.bill.id}`,
      )
      line(`${e.coverage.status} | Through ${e.coverage.through ?? "missing"}`)
      for (const w of [
        ...e.waivers,
        ...e.requirements.flatMap((r) => r.waivers),
      ]) {
        const id = w.signed_file_id ?? w.document_file_id
        if (id && evidenceAccepted(w)) fileIds.add(id)
      }
    }
    for (const r of register.unbilledClaimants) {
      line(
        `${r.claimant_company_name} | ${r.projectName} | ${r.period_end} | ${r.received ? "Accepted" : "Outstanding"}`,
      )
      for (const w of r.waivers) {
        const id = w.signed_file_id ?? w.document_file_id
        if (id && evidenceAccepted(w)) fileIds.add(id)
      }
    }
    if (fileIds.size > 200)
      throw new Error(
        "This packet exceeds 200 documents. Filter by project, period, or vendor.",
      )
    for (const id of fileIds) {
      const { data: file, error } = await ctx.supabase
        .from("files")
        .select("storage_path")
        .eq("org_id", ctx.orgId)
        .eq("id", id)
        .single()
      if (error || !file) throw new Error("A packet document is unavailable")
      const bytes = await downloadFilesObject({
        ...ctx,
        path: file.storage_path,
      })
      const source = await PDFDocument.load(bytes)
      for (const p of await pdf.copyPages(source, source.getPageIndices()))
        pdf.addPage(p)
    }
    return new NextResponse(new Uint8Array(await pdf.save()), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="waiver-packet.pdf"',
        "Cache-Control": "private, no-store",
      },
    })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not export waiver register",
      },
      { status: 400 },
    )
  }
}
