import { NextResponse } from "next/server";
import { loadProjectDirectory } from "@/lib/services/project-directory";
import { projectDirectoryQuerySchema } from "@/lib/projects/directory";

export async function GET(request: Request) {
  const parsed = projectDirectoryQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success)
    return NextResponse.json(
      { error: "Invalid project filters" },
      { status: 400 },
    );
  try {
    const data = await loadProjectDirectory(parsed.data);
    return NextResponse.json(data.page, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("Project directory read failed", error);
    return NextResponse.json(
      { error: "Unable to load projects. Please retry." },
      { status: 500 },
    );
  }
}
