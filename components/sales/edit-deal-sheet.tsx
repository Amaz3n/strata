"use client"

import { useRouter } from "next/navigation"
import { useEffect, useState, useTransition } from "react"

import { updateDealDetailsAction } from "@/app/(app)/sales/actions"
import { Field, Picker, Section, labelOptions } from "@/components/sales/registration-fields"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { unwrapAction } from "@/lib/action-result"
import {
  HEARD_ABOUT,
  PRICE_RANGES,
  TIMEFRAMES,
  withCurrent,
} from "@/lib/sales/registration-options"

const UNASSIGNED = "__unassigned"

/** Everything the registration card captured, as it stands on this deal today. */
export interface DealEditable {
  prospectId: string
  fullName: string
  phone: string | null
  email: string | null
  ownerUserId: string | null
  communityId: string | null
  source: string | null
  planInterest: string | null
  priceRange: string | null
  timeframe: string | null
  coopAgentName: string | null
  coopBrokerage: string | null
  notes: string | null
  /**
   * True once a lot is held: from then on the community is a fact about the lot,
   * not a preference on the lead, so it is shown but not editable here.
   */
  communityLocked: boolean
}

interface Option {
  id: string
  name: string
}

/**
 * The registration card, reopened.
 *
 * Deliberately the same sheet, the same sections and the same order as the card
 * that created the lead — a consultant correcting a price band should not have to
 * learn a second form, and anything the card can capture it must be possible to
 * fix. What is missing is missing on purpose: how they arrived and the day they
 * arrived moved that day's traffic tally, and re-writing them later would leave
 * the tally saying something the leads no longer support.
 */
export function EditDealSheet({
  deal,
  teamMembers,
  communities,
  open,
  onOpenChange,
}: {
  deal: DealEditable
  teamMembers: Option[]
  communities: Option[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()

  const [fullName, setFullName] = useState(deal.fullName)
  const [phone, setPhone] = useState(deal.phone ?? "")
  const [email, setEmail] = useState(deal.email ?? "")
  const [ownerId, setOwnerId] = useState(deal.ownerUserId ?? UNASSIGNED)
  const [communityId, setCommunityId] = useState(deal.communityId ?? "")
  const [source, setSource] = useState(deal.source ?? "")
  const [planInterest, setPlanInterest] = useState(deal.planInterest ?? "")
  const [priceRange, setPriceRange] = useState(deal.priceRange ?? "")
  const [timeframe, setTimeframe] = useState(deal.timeframe ?? "")
  const [coopAgentName, setCoopAgentName] = useState(deal.coopAgentName ?? "")
  const [coopBrokerage, setCoopBrokerage] = useState(deal.coopBrokerage ?? "")
  const [notes, setNotes] = useState(deal.notes ?? "")

  // Reset from the record every time it opens, so a cancelled edit leaves nothing
  // behind and a refreshed deal is what the form shows.
  useEffect(() => {
    if (!open) return
    setFullName(deal.fullName)
    setPhone(deal.phone ?? "")
    setEmail(deal.email ?? "")
    setOwnerId(deal.ownerUserId ?? UNASSIGNED)
    setCommunityId(deal.communityId ?? "")
    setSource(deal.source ?? "")
    setPlanInterest(deal.planInterest ?? "")
    setPriceRange(deal.priceRange ?? "")
    setTimeframe(deal.timeframe ?? "")
    setCoopAgentName(deal.coopAgentName ?? "")
    setCoopBrokerage(deal.coopBrokerage ?? "")
    setNotes(deal.notes ?? "")
  }, [open, deal])

  const save = () => {
    startTransition(async () => {
      try {
        unwrapAction(
          await updateDealDetailsAction(deal.prospectId, {
            fullName: fullName.trim(),
            phone: phone.trim() || null,
            email: email.trim() || null,
            ownerUserId: ownerId === UNASSIGNED ? null : ownerId,
            communityId: communityId || null,
            source: source || null,
            planInterest: planInterest.trim() || null,
            priceRange: priceRange || null,
            timeframe: timeframe || null,
            coopAgentName: coopAgentName.trim() || null,
            coopBrokerage: coopBrokerage.trim() || null,
            notes: notes.trim() || null,
          }),
        )
        toast({ title: "Deal updated" })
        onOpenChange(false)
        router.refresh()
      } catch (error) {
        toast({ title: "Could not update the deal", description: (error as Error).message })
      }
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" mobileFullscreen className="flex w-full flex-col gap-0 rounded-none p-0 sm:max-w-md">
        <SheetHeader className="space-y-1 border-b px-5 py-4 text-left">
          <SheetTitle className="text-base font-semibold">Edit deal</SheetTitle>
          <SheetDescription className="text-xs">
            The buyer as they should appear everywhere this deal is read.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="divide-y">
            <Section title="Buyer">
              <Field label="Name" htmlFor="edit-deal-name" required>
                <Input
                  id="edit-deal-name"
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                  placeholder="First and last name"
                  className="h-9 rounded-none"
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Phone" htmlFor="edit-deal-phone">
                  <Input
                    id="edit-deal-phone"
                    type="tel"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    className="h-9 rounded-none tabular-nums"
                  />
                </Field>
                <Field label="Email" htmlFor="edit-deal-email">
                  <Input
                    id="edit-deal-email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    className="h-9 rounded-none"
                  />
                </Field>
              </div>
            </Section>

            <Section
              title="Visit"
              hint={
                deal.communityLocked
                  ? "The community follows the held lot. How they arrived is set at registration, where it counted toward that day's traffic."
                  : "How they arrived is set at registration, where it counted toward that day's traffic."
              }
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Community">
                  <Picker
                    value={communityId}
                    onChange={setCommunityId}
                    placeholder="Not set"
                    disabled={deal.communityLocked}
                    options={communities.map(({ id, name }) => ({ value: id, label: name }))}
                  />
                </Field>
                <Field label="How they heard">
                  <Picker
                    value={source}
                    onChange={setSource}
                    placeholder="Not set"
                    options={labelOptions(withCurrent(HEARD_ABOUT, deal.source))}
                  />
                </Field>
              </div>
            </Section>

            <Section title="What they want">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Plan of interest" htmlFor="edit-deal-plan">
                  <Input
                    id="edit-deal-plan"
                    value={planInterest}
                    onChange={(event) => setPlanInterest(event.target.value)}
                    placeholder="e.g. Sycamore B"
                    className="h-9 rounded-none"
                  />
                </Field>
                <Field label="Price range">
                  <Picker
                    value={priceRange}
                    onChange={setPriceRange}
                    placeholder="Not set"
                    options={labelOptions(withCurrent(PRICE_RANGES, deal.priceRange))}
                  />
                </Field>
              </div>
              <Field label="Timeframe">
                <Picker
                  value={timeframe}
                  onChange={setTimeframe}
                  placeholder="Not set"
                  options={labelOptions(withCurrent(TIMEFRAMES, deal.timeframe))}
                />
              </Field>
            </Section>

            <Section title="Co-op agent" hint="Clear the name to take the broker off this deal.">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Agent" htmlFor="edit-deal-agent">
                  <Input
                    id="edit-deal-agent"
                    value={coopAgentName}
                    onChange={(event) => setCoopAgentName(event.target.value)}
                    className="h-9 rounded-none"
                  />
                </Field>
                <Field label="Brokerage" htmlFor="edit-deal-brokerage">
                  <Input
                    id="edit-deal-brokerage"
                    value={coopBrokerage}
                    onChange={(event) => setCoopBrokerage(event.target.value)}
                    className="h-9 rounded-none"
                  />
                </Field>
              </div>
            </Section>

            <Section title="Notes">
              <Field label="Owner">
                <Picker
                  value={ownerId === UNASSIGNED ? "" : ownerId}
                  onChange={(value) => setOwnerId(value || UNASSIGNED)}
                  placeholder="Unassigned"
                  options={teamMembers.map(({ id, name }) => ({ value: id, label: name }))}
                />
              </Field>
              <Field label="Anything worth remembering" htmlFor="edit-deal-notes">
                <Textarea
                  id="edit-deal-notes"
                  rows={3}
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Wants a corner lot, relocating in June…"
                  className="resize-none rounded-none text-[13px]"
                />
              </Field>
            </Section>
          </div>
        </ScrollArea>

        <SheetFooter className="flex-row justify-end gap-2 border-t px-5 py-3">
          <Button variant="outline" size="sm" className="rounded-none" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" className="rounded-none" onClick={save} disabled={pending || fullName.trim().length < 2}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
