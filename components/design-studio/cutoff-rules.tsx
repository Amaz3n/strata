"use client"

import { useEffect, useMemo, useRef, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import {
  listArchivedCatalogPackagesAction,
  cloneOrgGroupsAction,
  upsertPackageAction,
  upsertSelectionGroupAction,
  reviewCatalogGroupCategoriesAction,
} from "@/app/(app)/design-studio/actions"
import { catalogGroupPublicationSchema, selectionGroupSchema, packageSchema, type CatalogGroupPublicationInput, type SelectionPackageInput } from "@/lib/validation/selections"
import type { CatalogPublicationLabels } from "@/lib/validation/catalog-publication-review"
import { clearGroupPublication, persistGroupPublication, groupPublicationLockName, readGroupPublication } from "@/lib/selections/group-publication-recovery"
import type { CatalogGroupCategoryPage } from "@/lib/services/catalog-group-categories"
import { CatalogMemberPicker } from "@/components/design-studio/catalog-member-picker"
import type { CatalogPackageMemberPage } from "@/lib/services/catalog-package-members"
import type { CatalogArchivedPackagePage } from "@/lib/services/catalog-publication-history"
import type { CatalogDto, SelectionPackageDto, SelectionGroupDto } from "@/lib/services/option-catalog"
import { unwrapAction } from "@/lib/action-result"
import { clearPackagePublication, persistPackagePublication, packagePublicationLockName, readPackagePublication } from "@/lib/selections/package-publication-recovery"
import { StudioShell } from "@/components/design-studio/studio-shell"
import { PackageMemberPicker } from "@/components/design-studio/package-member-picker"
import { CatalogPublicationReview } from "@/components/design-studio/catalog-publication-review"
import { CatalogPublicationReconciliation } from "@/components/design-studio/catalog-publication-reconciliation"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Edit, Plus } from "@/components/icons"

import "./studio.css"

interface Props {
  orgId: string
  actorId: string
  groups: SelectionGroupDto[]
  groupCursor?: string
  nextGroupCursor?: string | null
  categoryLabels?: Array<{ id: string; name: string | null }>
  catalog: CatalogDto
  communityId?: string
  canManage: boolean
}

function money(cents: number | null | undefined) {
  if (cents == null) return "—"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(cents / 100)
}

export function CutoffRules({ groups, groupCursor, nextGroupCursor, catalog, categoryLabels, communityId, canManage, orgId, actorId }: Props) {
  const router = useRouter()
  const [groupTarget, setGroupTarget] = useState<{ group: SelectionGroupDto | null } | null>(null)
  const groupSaving = useRef(false)
  const groupAttempt = useRef<CatalogGroupPublicationInput | null>(null)
  const groupEpoch = useRef(0)
  const [groupReview, setGroupReview] = useState<{ attempt: CatalogGroupPublicationInput; labels: CatalogPublicationLabels; contextKey: string } | null>(null)
  const [groupRecovery, setGroupRecovery] = useState<CatalogGroupPublicationInput | null>(null)
  const [groupRecoveryReady, setGroupRecoveryReady] = useState(false)
  const [groupError, setGroupError] = useState<string | null>(null)
  const [packageOpen, setPackageOpen] = useState(false)
  const [packageKey, setPackageKey] = useState<string | null>(null)
  const packageSaving = useRef(false)
  const packageAttempt = useRef<SelectionPackageInput | null>(null)
  const [packageRecovery, setPackageRecovery] = useState<SelectionPackageInput | null>(null)
  const [anchor, setAnchor] = useState<"start" | "end">("start")
  const [categoryIds, setCategoryIds] = useState<string[]>([])
  const [packageOptionIds, setPackageOptionIds] = useState<string[]>([])
  const [pending, startTransition] = useTransition()
  const recoveryChecked = useRef(false)
  const [recoveryReady, setRecoveryReady] = useState(false)
  const [packageError, setPackageError] = useState<string | null>(null)
  const [packageTarget, setPackageTarget] = useState<SelectionPackageDto | null>(null)
  const [packageAvailable, setPackageAvailable] = useState(true)
  const [packageLifecycle, setPackageLifecycle] = useState<"archive" | "restore" | null>(null)
  const [packageRepair, setPackageRepair] = useState(false)
  const [archivedPage, setArchivedPage] = useState<CatalogArchivedPackagePage | null>(null)
  const archiveBrowsing = useRef(false)
  const scope = useMemo(() => ({ orgId, actorId, communityId }), [orgId, actorId, communityId])
  useEffect(() => {
    try {
      const attempt = readPackagePublication(window.localStorage, scope)
      if (attempt) {
        packageAttempt.current = attempt
        setPackageKey(attempt.publicationKey ?? null)
        setPackageRecovery(attempt)
        setPackageOptionIds(attempt.optionIds)
        setPackageOpen(true)
      }
      recoveryChecked.current = true
      setRecoveryReady(true)
    } catch {
      setPackageError("Saved package publication could not be read. Restore browser storage and reload before publishing again.")
    }
  }, [scope])

  const groupCommunityId = groupRecovery ? groupRecovery.communityId ?? null : groupTarget?.group ? groupTarget.group.community_id : communityId ?? null
  const groupStorageScope = useMemo(() => ({ orgId, actorId, communityId: groupCommunityId }), [orgId, actorId, groupCommunityId])
  const groupContextKey = `${orgId}:${actorId}:${communityId ?? "org"}:${groupCommunityId ?? "org"}:${canManage}`
  const groupContext = useRef(groupContextKey)
  groupContext.current = groupContextKey
  useEffect(() => {
    setGroupRecoveryReady(false)
    try {
      const saved = readGroupPublication(window.localStorage, groupStorageScope)
      groupAttempt.current = saved
      setGroupRecovery(saved)
      if (saved) {
        setGroupReview(null)
        setGroupTarget({ group: saved.expectedGroup })
        setCategoryIds(saved.categoryIds)
        setAnchor(saved.cutoffAnchor)
      }
      setGroupRecoveryReady(true)
    } catch {
      setGroupError("Saved cutoff rule publication could not be read. Restore browser storage and reload before publishing again.")
    }
  }, [groupStorageScope])
  useEffect(() => { groupEpoch.current++;setGroupReview(null) }, [groupContextKey])
  useEffect(() => () => { groupEpoch.current++ }, [])

  function togglePackageOption(id: string, members?: CatalogPackageMemberPage["items"]) {
    if (packageSaving.current || packageAttempt.current || !canManage) return
    setPackageOptionIds(previous => {
      const identity = id.toLowerCase()
      if (previous.some(value => value.toLowerCase() === identity)) return previous.filter(value => value.toLowerCase() !== identity)
      const options = new Map((members ?? []).map(row => [row.id.toLowerCase(), { available: row.available, categoryId: row.categoryKey }]))
      const option = options.get(identity)
      if (!option?.available || !option.categoryId) return previous
      const retained = previous.filter(value => options.get(value.toLowerCase())?.categoryId !== option.categoryId)
      return retained.length < 100 ? [...retained, id] : previous
    })
  }

  const categoryById = useMemo(() => {
    const categories = new Map<string, { name: string }>()
    for (const category of catalog.categories) {
      categories.set(category.id, category)
      if (category.parent_category_id) categories.set(category.parent_category_id, category)
    }
    for (const label of categoryLabels ?? []) if (label.name) categories.set(label.id, { name: label.name })
    return categories
  }, [catalog.categories, categoryLabels])

  function openGroup(group: SelectionGroupDto | null) {
    if (!canManage || groupSaving.current || !groupRecoveryReady) return
    groupEpoch.current++
    setGroupError(null)
    setGroupReview(null)
    const original = groupRecovery?.expectedGroup ?? group
    setAnchor(groupRecovery?.cutoffAnchor ?? original?.cutoff_anchor ?? "start")
    setCategoryIds([...(groupRecovery?.categoryIds ?? original?.category_ids ?? [])])
    setGroupTarget({ group: original ? { ...original, category_ids: [...original.category_ids] } : null })
  }

  function saveGroup(formData: FormData) {
    if (!canManage || groupSaving.current || groupAttempt.current || groupReview || !groupRecoveryReady) return
    const group = groupTarget?.group ?? null
    const parsed = selectionGroupSchema.safeParse({
      expectedOrgId: orgId, expectedActorId: actorId, id: group?.id ?? null,
      communityId: group ? group.community_id : communityId ?? null,
      name: String(formData.get("name") ?? ""), scheduleTaskKey: String(formData.get("scheduleTaskKey") ?? ""),
      cutoffOffsetDays: Number(formData.get("cutoffOffsetDays") ?? -14), cutoffAnchor: anchor,
      sortOrder: group?.sort_order ?? groups.length, categoryIds,
    })
    if (!parsed.success) { setGroupError(parsed.error.issues[0]?.message ?? "Review the rule values"); return }
    const draft = parsed.data, epoch = ++groupEpoch.current, context = groupContextKey
    groupSaving.current = true
    setGroupError(null)
    startTransition(async () => {
      try {
        const reviewed = unwrapAction(await reviewCatalogGroupCategoriesAction({ expectedOrgId: orgId, expectedActorId: actorId, communityId: draft.communityId ?? null, categoryIds: draft.categoryIds }))
        if (epoch !== groupEpoch.current || context !== groupContext.current) return
        const attempt = catalogGroupPublicationSchema.parse({ ...draft, publicationKey: crypto.randomUUID(), requireAtomicPublication: true,
          expectedGroup: group, expectedCategoryVersions: reviewed.categories.map(row => ({ id: row.id, definitionHash: row.definitionHash })),
        })
        setGroupReview({ attempt, labels: { kind: "group", categories: reviewed.categories }, contextKey: context })
      } catch (error) {
        if (epoch === groupEpoch.current && context === groupContext.current) setGroupError(error instanceof Error ? error.message : "Could not review the cutoff rule")
      } finally { groupSaving.current = false }
    })
  }

  function confirmGroup() {
    if (!canManage || !groupRecoveryReady || groupSaving.current || groupAttempt.current || !groupReview || groupReview.contextKey !== groupContextKey) return
    if (!navigator.locks) { setGroupError("This browser cannot protect rule publication across tabs. Use a browser with Web Locks support."); return }
    const attempt = groupReview.attempt, scope = groupStorageScope, context = groupContextKey, epoch = groupEpoch.current
    groupSaving.current = true
    setGroupError(null)
    startTransition(async () => {
      try {
        await navigator.locks.request(groupPublicationLockName(scope), async () => {
          if (epoch !== groupEpoch.current || context !== groupContext.current) return
          const persisted = persistGroupPublication(window.localStorage, scope, attempt)
          groupAttempt.current = persisted
          setGroupRecovery(persisted)
          setGroupReview(null)
          unwrapAction(await upsertSelectionGroupAction(persisted))
          if (epoch !== groupEpoch.current || context !== groupContext.current) return
          clearGroupPublication(window.localStorage, scope, persisted)
          groupAttempt.current = null
          setGroupRecovery(null)
          setGroupTarget(null)
          toast.success(attempt.id ? "Cutoff rule updated" : "Cutoff rule added")
          router.refresh()
        })
      } catch (error) {
        if (epoch !== groupEpoch.current || context !== groupContext.current) return
        try {
          const saved = readGroupPublication(window.localStorage, scope)
          if (saved) { groupAttempt.current = saved; setGroupRecovery(saved); setGroupReview(null);setGroupTarget({ group: saved.expectedGroup });setAnchor(saved.cutoffAnchor);setCategoryIds(saved.categoryIds) }
        } catch { setGroupRecoveryReady(false) }
        setGroupError(error instanceof Error ? error.message : "Could not confirm cutoff rule publication. Keep its original request")
      } finally { groupSaving.current = false }
    })
  }

  function openPackage(target: SelectionPackageDto | null, lifecycle: "archive" | "restore" | null = null, repair = false) {
    if (!canManage || archiveBrowsing.current || packageSaving.current || !recoveryChecked.current || packageAttempt.current || target && (target.is_archived && lifecycle !== "restore" && !repair || (target.community_id?.toLowerCase() ?? null) !== (communityId?.toLowerCase() ?? null))) return
    if (repair && (!target?.is_archived || lifecycle)) return
    setPackageRepair(repair)
    setPackageLifecycle(lifecycle)
    setPackageTarget(target ? { ...target, option_ids: [...target.option_ids] } : null)
    setPackageOptionIds([...(target?.option_ids ?? [])])
    setPackageAvailable(target?.is_available ?? true)
    setPackageKey(crypto.randomUUID())
    setPackageError(null)
    setPackageOpen(true)
  }

  function loadArchived(cursor: string | null) {
    if (!canManage || packageSaving.current || packageAttempt.current || archiveBrowsing.current) return
    archiveBrowsing.current = true
    setPackageError(null)
    startTransition(async () => {
      try { setArchivedPage(unwrapAction(await listArchivedCatalogPackagesAction({ expectedOrgId: orgId, expectedActorId: actorId, communityId: communityId ?? null, cursor }))) }
      catch (error) { setPackageError(error instanceof Error ? error.message : "Could not load archived packages") }
      finally { archiveBrowsing.current = false }
    })
  }

  function savePackage(formData: FormData) {
    if (!canManage || archiveBrowsing.current || packageSaving.current || !recoveryChecked.current) return
    if (packageTarget && (packageTarget.community_id?.toLowerCase() ?? null) !== (communityId?.toLowerCase() ?? null)) { setPackageError("Reopen this package in its original catalog scope."); return }
    if (!packageKey) { toast.error("Reopen the package form before saving"); return }
    const { cost_cents: reviewedCost, ...publicSource } = packageTarget ?? {}
    const canEditCost = !packageLifecycle && catalog.can_read_margin && (!packageTarget || reviewedCost !== undefined)
    const parsed = packageSchema.safeParse(packageAttempt.current ?? {
      requireAtomicPublication: true,
      publicationKey: packageKey, expectedOrgId: orgId, expectedActorId: actorId,
      ...(packageTarget ? { id: packageTarget.id, expectedPackage: { ...publicSource, ...(!packageLifecycle && catalog.can_read_margin && reviewedCost !== undefined ? { cost_cents: reviewedCost } : {}) }, imageUrl: packageTarget.image_url } : {}),
      communityId: communityId ?? null, name: packageLifecycle && packageTarget ? packageTarget.name : String(formData.get("name") ?? ""),
      description: packageLifecycle && packageTarget ? packageTarget.description : String(formData.get("description") ?? "") || null,
      priceCents: packageLifecycle && packageTarget ? packageTarget.price_cents : Math.round(Number(formData.get("price") ?? 0) * 100),
      ...(canEditCost ? { costCents: String(formData.get("cost") ?? "").trim() === "" ? null : Math.round(Number(formData.get("cost")) * 100) } : {}),
      ...(packageRepair ? { editArchived: true } : {}),
      ...(packageLifecycle ? { isArchived: packageLifecycle === "archive" } : {}),
      isAvailable: packageAvailable, sortOrder: packageTarget?.sort_order ?? catalog.packages.length, optionIds: packageOptionIds,
    })
    if (!parsed.success) { toast.error(parsed.error.issues[0]?.message ?? "Review the package values"); return }
    const attempt = parsed.data
    const recovering = packageAttempt.current !== null
    if (!navigator.locks) {
      setPackageError("This browser cannot protect package publication across tabs. Use a browser with Web Locks support.")
      return
    }
    packageSaving.current = true
    startTransition(async () => {
      try {
        const publish = async () => {
          persistPackagePublication(window.localStorage, scope, attempt)
          packageAttempt.current = attempt
          const result = await upsertPackageAction(attempt)
          if (!recovering && !result.success && result.code !== "CATALOG_PUBLICATION_UNCONFIRMED") {
            clearPackagePublication(window.localStorage, scope, attempt)
            packageAttempt.current = null
            setPackageRecovery(null)
          }
          if (!result.success && result.code === "CATALOG_PUBLICATION_UNCONFIRMED") setPackageRecovery(attempt)
          unwrapAction(result)
          clearPackagePublication(window.localStorage, scope, attempt)
          setPackageOpen(false)
          setPackageKey(null)
          packageAttempt.current = null
          setPackageRecovery(null)
          setPackageOptionIds([])
          setPackageError(null)
          setPackageTarget(null)
          setArchivedPage(null)
          setPackageLifecycle(null)
          setPackageRepair(false)
          toast.success(attempt.isArchived !== undefined ? (attempt.isArchived ? "Package archived" : "Package restored") : attempt.editArchived ? "Archived package updated" : attempt.id ? "Package updated" : "Package created")
          router.refresh()
        }
        await navigator.locks.request(packagePublicationLockName(scope), publish)
      } catch (error) {
        if (packageAttempt.current) setPackageRecovery(attempt)
        setPackageError(error instanceof Error ? error.message : "Could not confirm package publication")
        toast.error("Could not confirm the package save", {
          description: error instanceof Error ? error.message : undefined,
        })
      } finally {
        packageSaving.current = false
      }
    })
  }

  function cloneDefaults() {
    if (!communityId) return
    startTransition(async () => {
      try {
        unwrapAction(await cloneOrgGroupsAction(communityId))
        toast.success("Organization rules copied to this community")
        router.refresh()
      } catch (error) {
        toast.error("Could not copy the rules", {
          description: error instanceof Error ? error.message : undefined,
        })
      }
    })
  }

  const groupScope = groupCommunityId
  function toggleDiscoveredGroupCategory(id: string, members?: CatalogGroupCategoryPage["items"]) {
    if (!canManage || pending || groupSaving.current || groupAttempt.current || groupReview || groupRecovery) return
    const identity = id.toLowerCase(), metadata = new Map((members ?? []).map(row => [row.id.toLowerCase(), row]))
    setCategoryIds(previous => {
      if (previous.some(value => value.toLowerCase() === identity)) return previous.filter(value => value.toLowerCase() !== identity)
      const row = metadata.get(identity)
      if (!row?.available || !row.categoryKey) return previous
      const retained = previous.filter(value => metadata.get(value.toLowerCase())?.categoryKey !== row.categoryKey)
      return retained.length < 100 ? [...retained, id] : previous
    })
  }

  return (
    <StudioShell
      active="rules"
      action={
        canManage ? (
          <div className="flex items-center gap-1.5">
            {communityId && !groupCursor && groups.length === 0 && (
              <Button size="sm" variant="outline" className="h-8 rounded-none" disabled={pending} onClick={cloneDefaults}>
                Copy org rules
              </Button>
            )}
            <Button size="sm" className="h-8 rounded-none" disabled={pending || !groupRecoveryReady} onClick={() => openGroup(null)}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Cutoff rule
            </Button>
          </div>
        ) : null
      }
    >
      <div className="flex flex-col gap-8 p-5">
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-[15px] font-semibold tracking-tight">Cutoff rules</h2>
            <p className="max-w-[70ch] text-[13px] text-muted-foreground">
              Each rule groups categories into one buyer deadline, anchored to a schedule task so the date follows the
              build rather than a calendar. Every sold home in scope gets these groups automatically.
            </p>
          </div>
          {groupRecovery && <div className="flex flex-wrap items-center gap-3 border p-3 text-sm"><span>Recover the save for {groupRecovery.name} in its original scope.</span><Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => openGroup(groupRecovery.expectedGroup)}>Review pending rule</Button></div>}
          {groupError && !groupTarget && <p role="alert" className="text-sm text-destructive">{groupError}</p>}
          {groups.length === 0 ? (
            <div
              className="flex flex-col items-center gap-2 border px-6 py-16 text-center border-border"
            >
              <p className="text-sm font-medium">{groupCursor ? "No more cutoff rules" : "No cutoff rules yet"}</p>
              <p className="max-w-md text-[13px] text-muted-foreground">
                {groupCursor ? "Return to the first page to review current rules." : "Without a rule, a sold home gets no selection deadlines and nothing appears on the runway."}
              </p>
              {canManage && !groupCursor && (
                <Button size="sm" variant="outline" disabled={pending || !groupRecoveryReady} className="mt-2 h-8 rounded-none" onClick={() => openGroup(null)}>
                  Add the first rule
                </Button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto border border-border">
              <table className="w-full border-collapse text-[12.5px]">
                <thead>
                  <tr>
                    {["Group", "Categories", "Anchor task", "Cutoff", "Source", ""].map((heading, index) => (
                      <th
                        key={heading || index}
                        className="microlabel border-b px-3 py-2.5 text-left border-[var(--line-strong)]"
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => (
                    <tr key={group.id}>
                      <td className="border-b px-3 py-2.5 font-medium border-border">
                        {group.name}
                      </td>
                      <td className="border-b px-3 py-2.5 border-border">
                        {group.category_ids.map((id) => categoryById.get(id)?.name ?? `Unavailable category (${id})`).join(", ") || "—"}
                      </td>
                      <td className="font-mono tabular-nums border-b px-3 py-2.5 text-[11.5px] border-border">
                        {group.schedule_task_key}
                      </td>
                      <td className="border-b px-3 py-2.5 border-border">
                        {Math.abs(group.cutoff_offset_days)} days {group.cutoff_offset_days <= 0 ? "before" : "after"}{" "}
                        {group.cutoff_anchor}
                      </td>
                      <td className="border-b px-3 py-2.5 border-border">
                        <span className="studio-pill">{group.community_id ? "community" : "org"}</span>
                      </td>
                      <td className="border-b px-3 py-2.5 text-right border-border">
                        {canManage && (
                          <Button size="sm" variant="outline" disabled={pending || !groupRecoveryReady} className="h-6 rounded-none px-2 text-[11px]" onClick={() => openGroup(group)}>
                            <Edit className="mr-1 h-3 w-3" />
                            Edit
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(groupCursor || nextGroupCursor) && <nav aria-label="Cutoff rule pages" className="flex items-center gap-4 text-xs text-muted-foreground">
            <span>{groups.length} rules on this page · 25 per page</span>
            {groupCursor && <Link className="underline underline-offset-4" href={`/design-studio/rules${communityId ? `?community=${encodeURIComponent(communityId)}` : ""}`}>First rules</Link>}
            {nextGroupCursor && <Link className="underline underline-offset-4" href={`/design-studio/rules?${communityId ? `community=${encodeURIComponent(communityId)}&` : ""}groupsAfter=${encodeURIComponent(nextGroupCursor)}`}>Next rules</Link>}
          </nav>}
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="text-[15px] font-semibold tracking-tight">Packages</h2>
              <p className="max-w-[70ch] text-[13px] text-muted-foreground">
                A bundle a buyer takes in one click during an appointment. One option per category, priced as a whole.
              </p>
            </div>
            {canManage && (
              <Button size="sm" variant="outline" disabled={!recoveryReady || Boolean(packageRecovery)} className="h-8 rounded-none" onClick={() => openPackage(null)}>
                <Plus className="mr-1 h-3.5 w-3.5" />
                Package
              </Button>
            )}
          </div>
          {packageError && <p role="alert" className="text-sm text-destructive">{packageError}</p>}
          {packageRecovery && <div className="flex items-center gap-3 border p-3 text-sm"><span>Recover the save for {packageRecovery.name} ({money(packageRecovery.priceCents)}).</span><Button size="sm" variant="outline" onClick={() => setPackageOpen(true)}>Review pending package</Button></div>}
          {canManage && <section aria-label="Archived packages" className="space-y-2">
            <div className="flex items-center gap-2"><Button type="button" size="sm" variant="outline" disabled={pending || Boolean(packageRecovery)} onClick={() => loadArchived(null)}>Archived packages</Button>{archivedPage && <Button type="button" size="sm" variant="outline" disabled={pending || Boolean(packageRecovery) || !archivedPage.nextCursor} onClick={() => { if (archivedPage.nextCursor) loadArchived(archivedPage.nextCursor) }}>Next 25 archived packages</Button>}</div>
            {archivedPage && <><p className="text-xs text-muted-foreground">Archived packages in this scope · {archivedPage.packages.length} on this page. At most 25 per page.</p><ul className="divide-y">{archivedPage.packages.map(item => <li key={item.id} className="flex items-center justify-between gap-3 py-2 text-sm"><div><p>{item.name}</p><p className="font-mono text-xs text-muted-foreground">{item.id}</p></div><div className="flex items-center gap-2"><Button type="button" size="sm" variant="outline" disabled={pending || Boolean(packageRecovery)} onClick={() => openPackage(item, null, true)}>Edit archived contents</Button><Button type="button" size="sm" variant="outline" disabled={pending || Boolean(packageRecovery)} onClick={() => openPackage(item, "restore")}>Restore package</Button></div></li>)}</ul>{archivedPage.packages.length === 0 && <p className="text-sm text-muted-foreground">No archived packages on this page.</p>}</>}
          </section>}
          {catalog.packages.length === 0 ? (
            <div
              className="flex flex-col items-center gap-2 border px-6 py-12 text-center border-border"
            >
              <p className="text-[13px] text-muted-foreground">
                No packages configured.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto border border-border">
              <table className="w-full border-collapse text-[12.5px]">
                <thead>
                  <tr>
                    {["Package", "Scope", "Options", "Price", ...(catalog.can_read_margin ? ["Cost"] : []), ...(canManage ? ["Edit"] : [])].map((heading) => (
                      <th
                        key={heading}
                        className="microlabel border-b px-3 py-2.5 text-left border-[var(--line-strong)]"
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {catalog.packages.map((item) => (
                    <tr key={item.id}>
                      <td className="border-b px-3 py-2.5 border-border">
                        <span className="block font-medium">{item.name}</span>
                        {item.description && (
                          <span className="block text-[11.5px] text-muted-foreground">
                            {item.description}
                          </span>
                        )}
                      </td>
                      <td className="border-b px-3 py-2.5 border-border">
                        <span className="studio-pill">{item.community_id ? "community" : "org"}</span>
                      </td>
                      <td className="font-mono tabular-nums border-b px-3 py-2.5 border-border">
                        {item.option_ids.length}
                      </td>
                      <td className="font-mono tabular-nums border-b px-3 py-2.5 border-border">
                        {money(item.price_cents)}
                      </td>
                      {catalog.can_read_margin && (
                        <td className="font-mono tabular-nums border-b px-3 py-2.5 border-border">
                          {money(item.cost_cents)}
                        </td>
                      )}
                      {canManage && <td className="border-b px-3 py-2.5 border-border"><Button type="button" size="sm" variant="ghost" disabled={!recoveryReady || pending || Boolean(packageRecovery) || item.is_archived || (item.community_id?.toLowerCase() ?? null) !== (communityId?.toLowerCase() ?? null)} onClick={() => openPackage(item)}>Edit package</Button><Button type="button" size="sm" variant="ghost" disabled={!recoveryReady || pending || Boolean(packageRecovery) || item.is_archived || (item.community_id?.toLowerCase() ?? null) !== (communityId?.toLowerCase() ?? null)} onClick={() => openPackage(item, "archive")}>Archive package</Button>{(item.community_id?.toLowerCase() ?? null) !== (communityId?.toLowerCase() ?? null) && <p className="text-xs text-muted-foreground">Manage in its original catalog scope.</p>}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <Dialog open={Boolean(groupTarget)} onOpenChange={(open) => { if (!open && !(groupSaving.current && groupAttempt.current)) { groupEpoch.current++; setGroupReview(null); setGroupTarget(null) } }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto rounded-none">
          <form action={saveGroup}>
            <DialogHeader>
              <DialogTitle>{groupTarget?.group ? `Edit ${groupTarget.group.name}` : "Add a cutoff rule"}</DialogTitle>
              <DialogDescription>
                {groupTarget?.group && groupTarget.group.community_id === null ? "This organization rule is shared by communities that inherit it. Changes keep its organization scope." : "Anchor the deadline to a schedule task key so it moves when the build moves."}
              </DialogDescription>
            </DialogHeader>
            {groupError && <p role="alert" className="mt-3 text-sm text-destructive">{groupError}</p>}
            {groupReview && groupReview.contextKey === groupContextKey && <div className="mt-3"><CatalogPublicationReview publication={{ kind: "group", attempt: groupReview.attempt }} labels={groupReview.labels} canReadMargin={false} disabled={pending || !canManage} /></div>}
            {groupRecovery && <CatalogPublicationReconciliation key={groupRecovery.publicationKey} publication={{ kind: "group", attempt: groupRecovery }} allowRetry disabled={!canManage || pending} onReconciled={() => {
              groupAttempt.current = null;setGroupRecovery(null);setGroupReview(null);setGroupTarget(null);setGroupError(null);router.refresh()
            }} />}
            <fieldset disabled={!canManage || pending || Boolean(groupReview) || Boolean(groupRecovery) || !groupRecoveryReady} className="grid grid-cols-2 gap-3 py-4">
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="group-name">Name</Label>
                <Input id="group-name" name="name" required defaultValue={groupTarget?.group?.name ?? ""} className="rounded-none" />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="group-task">Schedule task key</Label>
                <Input
                  id="group-task"
                  name="scheduleTaskKey"
                  required
                  placeholder="drywall-start"
                  defaultValue={groupTarget?.group?.schedule_task_key ?? ""}
                  className="rounded-none"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="group-offset">Offset days</Label>
                <Input
                  id="group-offset"
                  name="cutoffOffsetDays"
                  type="number"
                  min="-365"
                  max="365"
                  defaultValue={groupTarget?.group?.cutoff_offset_days ?? -14}
                  className="rounded-none"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="group-anchor">Anchor</Label>
                <Select value={anchor} disabled={!canManage || pending || Boolean(groupReview) || Boolean(groupRecovery)} onValueChange={(value) => { if (canManage && !pending && !groupSaving.current && !groupReview && !groupRecovery) setAnchor(value === "end" ? "end" : "start") }}>
                  <SelectTrigger id="group-anchor" className="rounded-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="start">Task start</SelectItem>
                    <SelectItem value="end">Task end</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <CatalogMemberPicker domain="group" scope={{ expectedOrgId: orgId, expectedActorId: actorId, communityId: groupScope }} selectedIds={categoryIds} disabled={!canManage || pending || Boolean(groupReview) || Boolean(groupRecovery) || !groupRecoveryReady} onToggle={toggleDiscoveredGroupCategory} />

            </fieldset>
            <DialogFooter>
              {!groupRecovery && (groupReview ? <>
                <Button type="button" variant="outline" disabled={!canManage || pending} onClick={() => { if (!groupSaving.current && canManage) { groupEpoch.current++;setGroupReview(null);setGroupError(null) } }}>Edit reviewed values</Button>
                <Button type="button" disabled={!canManage || pending || !groupRecoveryReady} onClick={confirmGroup}>Confirm rule save</Button>
              </> : <Button type="submit" disabled={!canManage || pending || !groupRecoveryReady} className="rounded-none">
                Review rule
              </Button>)}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={packageOpen} onOpenChange={open => { if (!packageSaving.current) setPackageOpen(open) }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto rounded-none">
          <form key={packageKey} action={savePackage}>
            <DialogHeader>
              <DialogTitle>{packageRecovery ? "Review package save" : packageLifecycle ? (packageLifecycle === "archive" ? "Archive package" : "Restore package") : packageRepair ? "Edit archived package" : packageTarget ? "Edit package" : "New package"}</DialogTitle>
              <DialogDescription>{packageLifecycle === "archive" ? "Retire this package from new selections while preserving its original contents." : packageLifecycle === "restore" ? "Restore the original contents only if every member is currently eligible." : packageRepair ? "Replace obsolete members while keeping this package archived. Restoration is a separate reviewed step." : "Choose no more than one option from each category."}</DialogDescription>
            </DialogHeader>
            {packageRecovery && <p role="alert" className="mt-3 text-sm">The save for {packageRecovery.name} ({money(packageRecovery.priceCents)}) is unconfirmed. Retry the same request to recover it.</p>}
            {packageRecovery && !canManage && <p role="alert" className="mt-3 text-sm">Your catalog access has changed. This request remains saved for reconciliation.</p>}
            {packageError && <p role="alert" className="mt-3 text-sm text-destructive">{packageError}</p>}
            {packageRecovery && <CatalogPublicationReconciliation key={packageRecovery.publicationKey} publication={{ kind: "package", attempt: packageRecovery }} disabled={!canManage || pending} onReconciled={() => {
              packageAttempt.current=null;setPackageRecovery(null);setPackageKey(null);setPackageOptionIds([]);setPackageError(null);setPackageTarget(null);setPackageOpen(false);router.refresh()
            }} />}
            {!packageRecovery && packageLifecycle && packageTarget && <div className="space-y-2 py-4 text-sm"><p className="font-medium">{packageTarget.name}</p><p>{money(packageTarget.price_cents)} · {packageTarget.option_ids.length} members · {packageTarget.is_available ? "Available" : "Unavailable"}</p><p>{packageTarget.description}</p><p className="text-muted-foreground">The request preserves names, prices, availability, scope, members and hidden cost. {packageLifecycle === "restore" ? "Unavailable members prevent restoration." : "Existing selection records remain intact."}</p></div>}
            <fieldset disabled={!canManage || pending || Boolean(packageRecovery) || !recoveryReady} className="grid grid-cols-2 gap-3 py-4">
              {!packageRecovery && !packageLifecycle && <>
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="package-name">Name</Label>
                <Input id="package-name" name="name" defaultValue={packageTarget?.name ?? ""} required className="rounded-none" />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="package-description">Description</Label>
                <Input id="package-description" name="description" defaultValue={packageTarget?.description ?? ""} className="rounded-none" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="package-price">Price</Label>
                <Input id="package-price" name="price" type="number" min="0" step="0.01" defaultValue={packageTarget ? (packageTarget.price_cents / 100).toFixed(2) : "0"} className="rounded-none" />
              </div>
              {catalog.can_read_margin && (!packageTarget || packageTarget.cost_cents !== undefined) && (
                <div className="space-y-1.5">
                  <Label htmlFor="package-cost">Cost</Label>
                  <Input id="package-cost" name="cost" type="number" min="0" step="0.01" defaultValue={packageTarget ? (packageTarget.cost_cents == null ? "" : (packageTarget.cost_cents / 100).toFixed(2)) : "0"} className="rounded-none" />
                </div>
              )}
              <label className="col-span-2 flex items-center gap-2 text-sm"><Checkbox checked={packageAvailable} onCheckedChange={value => setPackageAvailable(value === true)} />Available for new selections</label>
              <p className="col-span-2 text-xs text-muted-foreground">{packageOptionIds.length} requested members. Leave cost blank to clear a recorded cost; existing signed selections retain their snapshots.</p>
              <PackageMemberPicker discoveryScope={{ expectedOrgId: orgId, expectedActorId: actorId, communityId: communityId ?? null }} categories={catalog.categories} selectedIds={packageOptionIds} disabled={!canManage || pending} onToggle={togglePackageOption} />
              </>}
            </fieldset>
            <DialogFooter>
              <Button type="submit" disabled={!canManage || pending || !recoveryReady} className="rounded-none">
                {packageRecovery ? "Retry package save" : packageLifecycle ? (packageLifecycle === "archive" ? "Confirm archive" : "Confirm restoration") : packageRepair ? "Save archived changes" : packageTarget ? "Save package changes" : "Create package"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </StudioShell>
  )
}
