import { AppShell } from "@/components/layout/app-shell"
import { SettingsWindow } from "@/components/settings/settings-window"
import { getCurrentUserAction } from "../actions/user"
import { requirePermissionGuard } from "@/lib/auth/guards"

export default async function SettingsPage() {
  await requirePermissionGuard("members.manage")
  const currentUser = await getCurrentUserAction()

  return (
    <AppShell title="Settings" user={currentUser}>
      <div className="p-4 lg:p-6">
        <SettingsWindow user={currentUser} />
      </div>
    </AppShell>
  )
}
