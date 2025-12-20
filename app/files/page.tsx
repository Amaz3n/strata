import { AppShell } from "@/components/layout/app-shell"
import { getCurrentUserAction } from "@/app/actions/user"
import { DocumentsCenterClient } from "./documents-client"
import { listFilesAction, getFileCountsAction, listProjectsForFilterAction } from "./actions"

export const dynamic = "force-dynamic"

export default async function FilesPage() {
  const [currentUser, files, counts, projects] = await Promise.all([
    getCurrentUserAction(),
    listFilesAction({}),
    getFileCountsAction(),
    listProjectsForFilterAction(),
  ])

  return (
    <AppShell title="Documents" user={currentUser}>
      <div className="p-6 h-full">
        <DocumentsCenterClient
          initialFiles={files}
          initialCounts={counts}
          initialProjects={projects}
        />
      </div>
    </AppShell>
  )
}
