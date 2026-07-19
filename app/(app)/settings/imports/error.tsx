"use client"

import { Button } from "@/components/ui/button"

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) { return <div className="m-6 border p-6"><h2 className="font-semibold">Unable to load imports</h2><p className="mt-1 text-sm text-muted-foreground">Check your import permission or try loading the batches again.</p><Button className="mt-4" size="sm" variant="outline" onClick={reset}>Try again</Button></div> }
