import { AppShell } from "@/components/layout/app-shell"
import { getCurrentUserAction } from "@/app/actions/user"

export default async function FilesPage() {
  const currentUser = await getCurrentUserAction()

  return (
    <AppShell title="Files" user={currentUser}>
      <div className="p-6 text-muted-foreground">Files module is coming soon.</div>
    </AppShell>
  )
}

