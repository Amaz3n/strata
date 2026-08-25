"use client"

import { useState } from "react"
import { toast } from "sonner"

import type { ProjectCorrespondenceInbox } from "@/lib/services/correspondence"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Check, Copy, Plus } from "@/components/icons"

/**
 * The only way mail enters this log.
 *
 * Arc does not send correspondence — a message gets here because a person
 * forwarded or BCC'd it to the project's address, exactly like the payables
 * bills inbox. So "add" is one thing: the address to forward to. It lives
 * behind a menu rather than in a banner because it is needed once, when someone
 * sets up their forwarding, and never again.
 *
 * There is no step before the address: every project is given one when it is
 * created, so the menu opens straight onto the thing you came for.
 */
export function CorrespondenceAddMenu({ inbox }: { inbox: ProjectCorrespondenceInbox }) {
  const [copied, setCopied] = useState(false)

  const copy = () => {
    void navigator.clipboard.writeText(inbox.address ?? "").then(
      () => {
        setCopied(true)
        toast.success("Address copied — forward mail here to file it")
        window.setTimeout(() => setCopied(false), 2000)
      },
      () => toast.error("Could not copy the address"),
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" />
          Add
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-96">
        <DropdownMenuLabel className="font-normal text-muted-foreground">
          Forward or BCC mail to this address and it lands in the log below, with attachments filed to the
          project.
        </DropdownMenuLabel>

        {inbox.address ? (
          <DropdownMenuItem
            // Copying is the whole point of opening this, so the menu stays put
            // and reports back rather than closing on the first click.
            onSelect={(event) => {
              event.preventDefault()
              copy()
            }}
            className="gap-2"
          >
            {copied ? <Check className="size-4 shrink-0 text-success" /> : <Copy className="size-4 shrink-0" />}
            <span className="min-w-0 flex-1 font-mono text-xs break-all">{inbox.address}</span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled className="whitespace-normal">
            Email filing isn&apos;t switched on for Arc yet. It is connected once for the whole installation, by
            whoever runs your deployment.
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
