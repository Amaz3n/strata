import ProjectDocumentsPage from "@/components/documents/project-documents-page";

export const instant = true;
export default function Page(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ path?: string }>;
}) {
  return <ProjectDocumentsPage {...props} />;
}
