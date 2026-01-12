import { requireOrgContext } from "@/lib/services/context"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, XCircle, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { queueTileGenerationForExistingSheetsAction } from "@/app/(app)/drawings/actions"

export default async function DrawingsDebugPage() {
  const { supabase, orgId } = await requireOrgContext()

  // Get stats on drawing sheets
  const { data: sheetVersions } = await supabase
    .from("drawing_sheet_versions")
    .select(`
      id,
      drawing_sheet_id,
      thumbnail_url,
      tile_base_url,
      tile_manifest,
      image_width,
      image_height,
      tiles_generated_at,
      created_at,
      drawing_sheets!inner(
        org_id,
        sheet_number,
        sheet_title,
        project_id,
        projects!inner(name)
      )
    `)
    .eq("drawing_sheets.org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(50)

  const totalSheets = sheetVersions?.length || 0
  const sheetsWithTiles =
    sheetVersions?.filter((v: any) => !!v.tile_manifest && !!v.tile_base_url).length || 0
  const sheetsWithoutTiles = totalSheets - sheetsWithTiles

  // Get recent uploads
  const recentSheets = sheetVersions?.slice(0, 10) || []

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold mb-2">Drawings Performance Debug</h1>
        <p className="text-muted-foreground">
          Check if tile generation is working for your drawings
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Sheets</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalSheets}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">With Tiles</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-500">{sheetsWithTiles}</div>
            <p className="text-xs text-muted-foreground">
              {totalSheets > 0 ? Math.round((sheetsWithTiles / totalSheets) * 100) : 0}% tiled
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Without Tiles</CardTitle>
            <XCircle className="h-4 w-4 text-orange-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-500">{sheetsWithoutTiles}</div>
            <p className="text-xs text-muted-foreground">
              Showing placeholders / PDF fallback
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Status Message */}
      {sheetsWithoutTiles === totalSheets && totalSheets > 0 && (
        <Card className="border-orange-500">
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-orange-500" />
              <CardTitle>Tiles Not Generated Yet</CardTitle>
            </div>
            <CardDescription>
              None of your sheets have tiles yet. This usually means the outbox worker isn&apos;t running (cron not configured) or jobs are stuck.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-sm">
              <p className="font-semibold mb-2">Why this happens:</p>
              <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                <li>New uploads enqueue outbox jobs, but nothing processes them</li>
                <li>The cron endpoint may be blocked by missing/incorrect authorization</li>
                <li>Existing drawings need a one-time queue/migration</li>
              </ul>
            </div>
            <div className="text-sm">
              <p className="font-semibold mb-2">Solutions:</p>
              <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                <li>Enable a worker to process outbox jobs (Vercel cron hitting <code>/api/jobs/process-outbox</code>)</li>
                <li>Queue tile jobs for existing sheets (button below)</li>
              </ol>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Maintenance Actions</CardTitle>
          <CardDescription>
            Queue background tile generation for sheets missing tiles (up to 500 at a time).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form action={queueTileGenerationForExistingSheetsAction}>
            <Button type="submit" variant="default">
              Queue tile generation jobs
            </Button>
          </form>
          <p className="text-xs text-muted-foreground">
            After queueing, tiles are produced by the background worker (cron) and the list view will refresh.
          </p>
        </CardContent>
      </Card>

      {/* Recent Sheets */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Sheets (Last 10)</CardTitle>
          <CardDescription>
            Check if newly uploaded sheets have tiles generated
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {recentSheets.map((version: any) => {
              const sheet = version.drawing_sheets
              const project = sheet?.projects
              const hasTiles = !!version.tile_manifest && !!version.tile_base_url

              return (
                <div
                  key={version.id}
                  className="flex items-center justify-between p-3 border rounded-lg"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{sheet?.sheet_number}</p>
                      {sheet?.sheet_title && (
                        <p className="text-sm text-muted-foreground">{sheet.sheet_title}</p>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {project?.name} • Uploaded {new Date(version.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-4">
                    {hasTiles ? (
                      <>
                        <div className="text-right text-xs">
                          <p className="text-green-600 font-medium">Tiles Generated</p>
                          <p className="text-muted-foreground">
                            {version.image_width}x{version.image_height}
                          </p>
                        </div>
                        <Badge variant="default" className="bg-green-500">
                          <CheckCircle2 className="h-3 w-3 mr-1" />
                          Tiled
                        </Badge>
                      </>
                    ) : (
                      <Badge variant="secondary">
                        <XCircle className="h-3 w-3 mr-1" />
                        Not Tiled
                      </Badge>
                    )}
                  </div>
                </div>
              )
            })}
            {recentSheets.length === 0 && (
              <p className="text-center text-muted-foreground py-8">
                No sheets found. Upload a drawing set to test.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Sample Query */}
      <Card>
        <CardHeader>
          <CardTitle>Database Check</CardTitle>
          <CardDescription>
            Sample query to verify tile data is being stored
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="bg-muted p-4 rounded-lg text-xs overflow-x-auto">
{`SELECT
  ds.sheet_number,
  dsv.thumbnail_url,
  dsv.tile_base_url,
  dsv.tile_manifest,
  dsv.image_width,
  dsv.image_height,
  dsv.tiles_generated_at
FROM drawing_sheet_versions dsv
JOIN drawing_sheets ds ON ds.id = dsv.drawing_sheet_id
WHERE ds.org_id = '${orgId}'
ORDER BY dsv.created_at DESC
LIMIT 5;`}
          </pre>
        </CardContent>
      </Card>
    </div>
  )
}
