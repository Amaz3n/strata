import { AlertTriangle } from "lucide-react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

interface SubPortalSetupRequiredProps {
  tokenId: string
}

/**
 * Shown when a link points at this portal but was minted without the company it
 * belongs to. The reader is the subcontractor, who cannot fix it — so this
 * explains the situation and carries a reference the builder can search on,
 * rather than the configuration steps it used to print.
 */
export function SubPortalSetupRequired({ tokenId }: SubPortalSetupRequiredProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-warning/15">
            <AlertTriangle className="size-6 text-warning" />
          </div>
          <CardTitle>This link isn&apos;t ready yet</CardTitle>
          <CardDescription>
            It was created before your company was attached to it, so there is nothing here to show
            you.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Reply to the email that sent you here and ask for a new link — the builder can issue one
            in a moment. Nothing you have already submitted is affected.
          </p>
          <div className="border-t border-border pt-3">
            <p className="text-center text-xs text-muted-foreground">
              Reference {tokenId.slice(0, 8)}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
