import { NextResponse } from "next/server";
import { downloadBooksProjectOwnerOriginal } from "@/lib/services/books/project-entity-ownership";
export async function GET(
  _request: Request,
  {
    params,
  }: {
    params: Promise<{
      projectId: string;
      entityId: string;
      proposalId: string;
      versionId: string;
    }>;
  },
) {
  try {
    const r = await downloadBooksProjectOwnerOriginal(
      await params,
      _request.signal,
    );
    return new Response(r.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition":
          'attachment; filename="ownership-supporting-original"',
        "Content-Length": String(r.sizeBytes),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Original-SHA256": r.checksum,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Original supporting document is unavailable" },
      { status: 404, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
