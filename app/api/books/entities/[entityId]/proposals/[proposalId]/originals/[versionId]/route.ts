import { NextResponse } from "next/server";
import {
  downloadBooksEntityEvidence,
  EntityEvidenceDownloadError,
} from "@/lib/services/books/entity-evidence-download";

export async function GET(
  request: Request,
  {
    params,
  }: {
    params: Promise<{
      entityId: string;
      proposalId: string;
      versionId: string;
    }>;
  },
) {
  try {
    const { entityId, proposalId, versionId } = await params;
    const attachment = await downloadBooksEntityEvidence(
      entityId,
      proposalId,
      versionId,
      request.signal,
    );
    const name = encodeURIComponent(
      attachment.name.replace(/[\u0000-\u001f\u007f]/g, ""),
    ).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return new Response(attachment.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="entity-evidence"; filename*=UTF-8''${name}`,
        "Content-Length": String(attachment.size),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof EntityEvidenceDownloadError
            ? error.message
            : "Could not download original evidence",
      },
      {
        status:
          error instanceof EntityEvidenceDownloadError ? error.status : 500,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
}
