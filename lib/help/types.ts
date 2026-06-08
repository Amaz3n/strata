import type { ComponentType } from "react"

export type HelpArticle = {
  slug: string
  title: string
  description: string
  updatedAt?: string
  content: ComponentType
}

export type HelpCollection = {
  slug: string
  title: string
  description: string
  articles: HelpArticle[]
}

export type HelpTopic = {
  slug: string
  title: string
  description: string
  collections: HelpCollection[]
}

export type HelpNavigationArticle = Omit<HelpArticle, "content">

export type HelpNavigationCollection = Omit<HelpCollection, "articles"> & {
  articles: HelpNavigationArticle[]
}

export type HelpNavigationTopic = Omit<HelpTopic, "collections"> & {
  collections: HelpNavigationCollection[]
}

export type HelpSearchItem = {
  title: string
  description: string
  href: string
  topicTitle: string
  collectionTitle?: string
  type: "topic" | "collection" | "article"
}

export type HelpRoute =
  | { type: "topic"; topic: HelpTopic }
  | { type: "collection"; topic: HelpTopic; collection: HelpCollection }
  | {
      type: "article"
      topic: HelpTopic
      collection: HelpCollection
      article: HelpArticle
    }
