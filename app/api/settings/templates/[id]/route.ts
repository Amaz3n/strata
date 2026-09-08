import { NextResponse } from "next/server";
import { requireOrgContext } from "@/lib/services/context";
import { downloadFilesObject } from "@/lib/storage/files-storage";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const ctx = await requireOrgContext();
    const { data, error } = await ctx.supabase
      .from("files")
      .select("storage_path")
      .eq("org_id", ctx.orgId)
      .eq("folder_path", "/Templates/Originals")
      .eq("id", id)
      .single();
    if (error || !data) throw new Error("Missing source");
    const bytes = await downloadFilesObject({
      supabase: ctx.supabase,
      orgId: ctx.orgId,
      path: data.storage_path,
    });
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new NextResponse("Document unavailable", { status: 403 });
  }
}
