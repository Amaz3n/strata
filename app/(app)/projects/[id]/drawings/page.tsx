import ProjectDrawingsPage from "@/components/drawings/project-drawings-page";

export default function Page(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    set?: string;
    sheetId?: string;
    condition?: string;
    planVersion?: string;
    sourceFile?: string;
    estimate?: string;
  }>;
}) {
  return <ProjectDrawingsPage {...props} />;
}
