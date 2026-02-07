import { CheckCircle2, Download, Mail } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"

interface SuccessScreenProps {
  title: string
  signerEmail?: string | null
  signedAt: Date
  executedDocumentUrl?: string | null
}

export function SuccessScreen({ title, signerEmail, signedAt, executedDocumentUrl }: SuccessScreenProps) {
  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-4xl items-center justify-center px-4 py-12">
      <Card className="w-full max-w-2xl rounded-lg">
        <CardHeader className="items-center text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-emerald-300 bg-emerald-100 text-emerald-700">
            <CheckCircle2 className="h-8 w-8" />
          </div>
          <Badge className="bg-emerald-600 text-white">Signed</Badge>
          <CardTitle className="text-2xl">Document signed successfully</CardTitle>
        </CardHeader>

        <CardContent className="space-y-4 text-center">
          <p className="text-base font-medium">{title}</p>
          <p className="text-sm text-muted-foreground">
            Signed on {signedAt.toLocaleDateString()} at {signedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </p>

          {executedDocumentUrl ? (
            <Button asChild>
              <a href={executedDocumentUrl} target="_blank" rel="noreferrer">
                <Download className="mr-1.5 h-4 w-4" />
                Download signed document
              </a>
            </Button>
          ) : (
            <p className="rounded-md border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
              Signed copy will be available once all required signers complete the envelope.
            </p>
          )}

          {signerEmail?.trim() ? (
            <p className="flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
              <Mail className="h-4 w-4" />
              A copy will be sent to {signerEmail.trim()}.
            </p>
          ) : null}
        </CardContent>

        <CardFooter className="justify-center border-t">
          <p className="text-xs text-muted-foreground">You may now close this window.</p>
        </CardFooter>
      </Card>
    </div>
  )
}
