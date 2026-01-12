import Link from "next/link"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { AlertTriangle } from "@/components/icons"

export default function UnauthorizedPage() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-muted/30 p-6">
      <Card className="max-w-lg w-full shadow-sm">
        <CardHeader className="flex flex-row items-center gap-3">
          <div className="p-2 rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-xl">Access denied</CardTitle>
            <p className="text-sm text-muted-foreground">You don&apos;t have permission to view this page.</p>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Please contact an administrator if you believe this is a mistake or need elevated access.
          </p>
          <div className="flex gap-2">
            <Button asChild>
              <Link href="/">Go home</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/settings">Settings</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}






