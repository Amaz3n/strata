import { unstable_rethrow } from "next/navigation";
import {
  downloadPrivatePayrollDocument,
  PayrollDocumentDownloadError,
} from "@/lib/services/books/payroll-document-download";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ fileId: string; versionId: string }> },
) {
  try {
    const { fileId, versionId } = await params,
      result = await downloadPrivatePayrollDocument(
        fileId,
        versionId,
        request.signal,
      );
    const ascii =
      result.name
        .replace(/[\r\n"\\]/g, "_")
        .replace(/[^\x20-\x7e]/g, "_")
        .slice(0, 180) || "Payroll.csv";
    return new Response(result.body, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Length": String(result.size),
        "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(result.name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof PayrollDocumentDownloadError)
      return Response.json(
        { error: error.message },
        { status: error.status, headers: { "Cache-Control": "no-store" } },
      );
    return Response.json(
      { error: "Could not load payroll document" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
