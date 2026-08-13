import { Suspense } from "react"
import { notFound } from "next/navigation"
import { HelpArticlePage } from "@/components/help/help-article"
import {
  HelpCollectionDirectory,
  HelpTopicDirectory,
} from "@/components/help/help-directory"
import { HelpShell } from "@/components/help/help-shell"
import {
  getHelpNavigation,
  getHelpSearchItems,
  getHelpStaticParams,
  resolveHelpRoute,
} from "@/lib/help/catalog"
import HelpLoading from "../loading"

type HelpRoutePageProps = {
  params: Promise<{ slug: string[] }>
}

// The root Instant Navigation sample uses a scalar `slug` for report routes;
// this catch-all route needs its own array-shaped sample.
export const instant = {
  unstable_samples: [{ params: { slug: ["getting-started"] } }],
}

export const metadata = {
  title: "Help Center | Arc",
  description: "Find guides and answers for using Arc.",
}

export function generateStaticParams() {
  return getHelpStaticParams()
}

export default function HelpRoutePage(props: HelpRoutePageProps) {
  return (
    <Suspense fallback={<HelpLoading />}>
      <HelpRouteContent {...props} />
    </Suspense>
  )
}

async function HelpRouteContent({ params }: HelpRoutePageProps) {
  const { slug } = await params
  const route = resolveHelpRoute(slug)
  if (!route) notFound()

  const navigation = getHelpNavigation()
  const searchItems = getHelpSearchItems()

  return (
    <HelpShell navigation={navigation} searchItems={searchItems} activeSlugs={slug}>
      {route.type === "topic" ? (
        <HelpTopicDirectory topic={route.topic} />
      ) : route.type === "collection" ? (
        <HelpCollectionDirectory topic={route.topic} collection={route.collection} />
      ) : (
        <HelpArticlePage
          topic={route.topic}
          collection={route.collection}
          article={route.article}
        />
      )}
    </HelpShell>
  )
}
