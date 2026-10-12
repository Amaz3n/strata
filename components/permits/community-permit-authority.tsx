"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { setCommunityPermitAuthorityAction } from "@/app/(app)/communities/[id]/settings/actions"
import { searchPermitAuthoritiesAction } from "@/app/(app)/projects/[id]/permits/actions"
import { Button } from "@/components/ui/button"
import { SearchPicker, type SearchPickerItem } from "@/components/ui/search-picker"
import { unwrapAction } from "@/lib/action-result"

/**
 * Who issues building permits for the community's homes. New applications
 * default to it, and a house starts only on a permit from it.
 */
export function CommunityPermitAuthority({ communityId, authority, canWrite }: {
  communityId: string
  authority: SearchPickerItem | null
  canWrite: boolean
}) {
  const [value, setValue] = useState<SearchPickerItem | null>(authority)
  const [pending, startTransition] = useTransition()
  const changed = (value?.id ?? null) !== (authority?.id ?? null)

  const save = () => startTransition(async () => {
    try {
      unwrapAction(await setCommunityPermitAuthorityAction(communityId, value?.id ?? null))
      toast.success(value ? `${value.name} issues this community's permits` : "Permitting authority cleared")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to set the permitting authority")
    }
  })

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Permitting authority</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          The jurisdiction that issues building permits here. Its fees are paid to it as a vendor on each home&apos;s job cost, and a house starts only on its approved permit.
        </p>
      </div>
      <SearchPicker label="Authority" noun="authorities" value={value} onChange={setValue} search={searchPermitAuthoritiesAction} disabled={!canWrite || pending} />
      {canWrite && changed ? (
        <Button size="sm" className="rounded-none" disabled={pending} onClick={save}>{pending ? "Saving…" : "Save authority"}</Button>
      ) : null}
    </section>
  )
}
