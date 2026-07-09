"use client"

import { useState } from "react"

import { endImpersonationAction } from "@/app/(app)/platform/actions"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Eye } from "@/components/icons"
import { ImpersonationPanel } from "@/components/platform/impersonation-panel"
import { unwrapAction } from "@/lib/action-result"

interface ActiveImpersonation {
  active: boolean
  target?: string | null
  expiresAt?: string | null
}

interface ImpersonationSheetProps {
  orgs: { id: string; name: string }[]
  session: ActiveImpersonation
}

export function ImpersonationSheet({ orgs, session }: ImpersonationSheetProps) {
  const [open, setOpen] = useState(false)

  async function endImpersonation() {
    unwrapAction(await endImpersonationAction())
  }

  return (
    <>
      <Button variant="outline" size="sm" className="h-8 rounded-none" onClick={() => setOpen(true)}>
        <Eye className="mr-1.5 h-3.5 w-3.5" />
        Impersonate
        {session.active ? <span className="ml-1.5 h-1.5 w-1.5 rounded-full bg-amber-500" /> : null}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          mobileFullscreen
          className="flex flex-col rounded-none p-0 shadow-2xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-md sm:rounded-none"
        >
          <SheetHeader className="border-b bg-muted/30 px-6 pb-4 pt-6">
            <SheetTitle>Impersonation</SheetTitle>
            <SheetDescription>
              Start an audited impersonation session for support and diagnostics.
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
            {session.active ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                <div className="text-sm">
                  <p className="font-medium text-amber-700 dark:text-amber-200">
                    Impersonating {session.target ?? "user"}
                  </p>
                  {session.expiresAt ? (
                    <p className="text-xs text-muted-foreground">
                      Expires {new Date(session.expiresAt).toLocaleString()}
                    </p>
                  ) : null}
                </div>
                <form action={endImpersonation}>
                  <Button size="sm" variant="destructive" type="submit">
                    End session
                  </Button>
                </form>
              </div>
            ) : null}

            <ImpersonationPanel orgs={orgs} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
