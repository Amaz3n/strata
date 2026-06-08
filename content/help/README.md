# Arc Help Center Content

The Help Center uses this hierarchy:

```text
Help Center
└── Topic
    └── Collection
        └── Article
```

URLs are generated from the hierarchy:

```text
/help/getting-started
/help/getting-started/arc-overview
/help/getting-started/arc-overview/what-is-arc
```

## Add an article

1. Create a TSX file for the article body:

```tsx
export default function WhatIsArcArticle() {
  return (
    <>
      <p>Article introduction.</p>
      <h2>Section heading</h2>
      <p>Section content.</p>
    </>
  )
}
```

2. Import it in `catalog.ts`.
3. Add it under the correct topic and collection:

```tsx
import WhatIsArcArticle from "./getting-started/what-is-arc"

export const helpTopics: HelpTopic[] = [
  {
    slug: "getting-started",
    title: "Getting started with Arc",
    description: "Learn the basics and set up your workspace.",
    collections: [
      {
        slug: "arc-overview",
        title: "Arc overview",
        description: "Understand Arc and its core workflows.",
        articles: [
          {
            slug: "what-is-arc",
            title: "What is Arc?",
            description: "A quick introduction to Arc.",
            updatedAt: "2026-06-06",
            content: WhatIsArcArticle,
          },
        ],
      },
    ],
  },
]
```

The home directory, sidebar, breadcrumbs, search, topic page, collection page,
article page, metadata, and previous/next article navigation update
automatically.
