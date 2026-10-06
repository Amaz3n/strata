import { NextResponse } from "next/server";
import { uploadBankingReceipt } from "@/lib/services/books/banking-workspace";
export const maxDuration = 120;
// An independent request keeps receipt extraction from blocking the browser's
// serial Server Action queue while the bookkeeper continues coding transactions.
export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin)
      return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
    if (Number(request.headers.get("content-length") ?? 0) > 21 * 1024 * 1024)
      return NextResponse.json(
        { error: "Receipt exceeds 20 MB" },
        { status: 413 },
      );
    return NextResponse.json({
      success: true,
      data: await uploadBankingReceipt(await request.formData()),
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Receipt upload failed",
      },
      { status: 400 },
    );
  }
}
