"use client"

import { useRouter } from "next/navigation"
import { useEffect, useState, useTransition } from "react"

import { registerInquiryAction } from "@/app/(app)/sales/actions"
import { Plus } from "@/components/icons"
import { Field, Picker, Section, labelOptions } from "@/components/sales/registration-fields"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useToast } from "@/hooks/use-toast"
import { unwrapAction } from "@/lib/action-result"
import {
  INQUIRY_CHANNELS,
  INQUIRY_CHANNEL_LABELS,
  isInquiryChannel,
  type InquiryChannel,
} from "@/lib/sales/activity"
import { HEARD_ABOUT, PRICE_RANGES, TIMEFRAMES } from "@/lib/sales/registration-options"

interface Option {
  id: string
  name: string
}

interface NewInquirySheetProps {
  communities: Option[]
  teamMembers: Option[]
  /** The community lens, so the model-home consultant never picks their own. */
  defaultCommunityId?: string
}

function localDay(): string {
  const now = new Date()
  const offset = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offset).toISOString().slice(0, 10)
}

/**
 * The model-home registration card, not a generic lead form. It captures what a
 * clipboard captures — how they arrived, what they want, who brought them — and
 * the arrival itself moves the community's traffic count for the day, so the
 * Monday traffic number stays honest without anyone doing double entry.
 */
export function NewInquirySheet({ communities, teamMembers, defaultCommunityId }: NewInquirySheetProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  const [buyerName, setBuyerName] = useState("")
  const [phone, setPhone] = useState("")
  const [email, setEmail] = useState("")
  const [channel, setChannel] = useState<InquiryChannel>("walk_in")
  const [communityId, setCommunityId] = useState(defaultCommunityId ?? "")
  const [ownerId, setOwnerId] = useState("")
  const [source, setSource] = useState("")
  const [planInterest, setPlanInterest] = useState("")
  const [priceRange, setPriceRange] = useState("")
  const [timeframe, setTimeframe] = useState("")
  const [coopAgentName, setCoopAgentName] = useState("")
  const [coopBrokerage, setCoopBrokerage] = useState("")
  const [notes, setNotes] = useState("")

  useEffect(() => {
    if (open) return
    setBuyerName("")
    setPhone("")
    setEmail("")
    setChannel("walk_in")
    setCommunityId(defaultCommunityId ?? "")
    setOwnerId("")
    setSource("")
    setPlanInterest("")
    setPriceRange("")
    setTimeframe("")
    setCoopAgentName("")
    setCoopBrokerage("")
    setNotes("")
  }, [open, defaultCommunityId])

  const submit = () => {
    if (buyerName.trim().length < 2) {
      toast({ title: "Buyer name is required" })
      return
    }
    startTransition(async () => {
      try {
        unwrapAction(
          await registerInquiryAction({
            buyerName: buyerName.trim(),
            phone: phone.trim() || null,
            email: email.trim() || null,
            communityId: communityId || null,
            ownerUserId: ownerId || null,
            channel,
            source: source || null,
            planInterest: planInterest.trim() || null,
            priceRange: priceRange || null,
            timeframe: timeframe || null,
            coopAgentName: coopAgentName.trim() || null,
            coopBrokerage: coopBrokerage.trim() || null,
            notes: notes.trim() || null,
            loggedDate: localDay(),
          }),
        )
        toast({
          title: `${buyerName.trim()} registered`,
          description: communityId
            ? `Added to the board and counted in today's traffic.`
            : "Added to the board.",
        })
        setOpen(false)
        router.refresh()
      } catch (error) {
        toast({ title: "Could not register the inquiry", description: (error as Error).message })
      }
    })
  }

  return (
    <>
      <Button size="sm" className="rounded-none" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        New inquiry
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" mobileFullscreen className="flex w-full flex-col gap-0 rounded-none p-0 sm:max-w-md">
          <SheetHeader className="space-y-1 border-b px-5 py-4 text-left">
            <SheetTitle className="text-base font-semibold">Registration card</SheetTitle>
            <SheetDescription className="text-xs">
              What the clipboard captures. Walk-ins and appointments also move today&apos;s traffic count.
            </SheetDescription>
          </SheetHeader>

          <ScrollArea className="min-h-0 flex-1">
            <div className="divide-y">
              <Section title="Buyer">
                <Field label="Name" htmlFor="inquiry-name" required>
                  <Input
                    id="inquiry-name"
                    autoFocus
                    value={buyerName}
                    onChange={(event) => setBuyerName(event.target.value)}
                    placeholder="First and last name"
                    className="h-9 rounded-none"
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Phone" htmlFor="inquiry-phone">
                    <Input
                      id="inquiry-phone"
                      type="tel"
                      value={phone}
                      onChange={(event) => setPhone(event.target.value)}
                      className="h-9 rounded-none tabular-nums"
                    />
                  </Field>
                  <Field label="Email" htmlFor="inquiry-email">
                    <Input
                      id="inquiry-email"
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      className="h-9 rounded-none"
                    />
                  </Field>
                </div>
              </Section>

              <Section title="Visit">
                <Field label="How they arrived">
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    value={channel}
                    onValueChange={(value) => isInquiryChannel(value) && setChannel(value)}
                    className="w-full rounded-none"
                  >
                    {INQUIRY_CHANNELS.map((value) => (
                      <ToggleGroupItem key={value} value={value} className="h-9 rounded-none text-xs">
                        {INQUIRY_CHANNEL_LABELS[value]}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Community">
                    <Picker
                      value={communityId}
                      onChange={setCommunityId}
                      placeholder="Not set"
                      options={communities.map(({ id, name }) => ({ value: id, label: name }))}
                    />
                  </Field>
                  <Field label="How they heard">
                    <Picker
                      value={source}
                      onChange={setSource}
                      placeholder="Not set"
                      options={labelOptions(HEARD_ABOUT)}
                    />
                  </Field>
                </div>
              </Section>

              <Section title="What they want">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Plan of interest" htmlFor="inquiry-plan">
                    <Input
                      id="inquiry-plan"
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
                      options={labelOptions(PRICE_RANGES)}
                    />
                  </Field>
                </div>
                <Field label="Timeframe">
                  <Picker
                    value={timeframe}
                    onChange={setTimeframe}
                    placeholder="Not set"
                    options={labelOptions(TIMEFRAMES)}
                  />
                </Field>
              </Section>

              <Section title="Co-op agent" hint="Left blank for an unrepresented buyer.">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Agent" htmlFor="inquiry-agent">
                    <Input
                      id="inquiry-agent"
                      value={coopAgentName}
                      onChange={(event) => setCoopAgentName(event.target.value)}
                      className="h-9 rounded-none"
                    />
                  </Field>
                  <Field label="Brokerage" htmlFor="inquiry-brokerage">
                    <Input
                      id="inquiry-brokerage"
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
                    value={ownerId}
                    onChange={setOwnerId}
                    placeholder="Me"
                    options={teamMembers.map(({ id, name }) => ({ value: id, label: name }))}
                  />
                </Field>
                <Field label="Anything worth remembering" htmlFor="inquiry-notes">
                  <Textarea
                    id="inquiry-notes"
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
            <Button variant="outline" size="sm" className="rounded-none" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button size="sm" className="rounded-none" onClick={submit} disabled={pending || buyerName.trim().length < 2}>
              {pending ? "Registering…" : "Register"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  )
}
