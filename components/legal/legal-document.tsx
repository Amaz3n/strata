import { ArrowLeft } from "lucide-react"
import Image from "next/image"
import Link from "next/link"

interface LegalSection {
  title: string
  body: readonly string[]
}

interface LegalDocumentProps {
  title: string
  effectiveDate: string
  sections: readonly LegalSection[]
}

const companyName = "Arc Project Systems LLC"

function sectionId(title: string) {
  return title
    .toLowerCase()
    .replace(/^\d+\.\s*/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

function SectionLinks({ sections }: { sections: readonly LegalSection[] }) {
  return (
    <ol className="space-y-1">
      {sections.map((section) => (
        <li key={section.title}>
          <a
            href={`#${sectionId(section.title)}`}
            className="block border-l border-border py-1.5 pl-3 text-sm leading-5 text-muted-foreground transition-colors hover:border-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {section.title}
          </a>
        </li>
      ))}
    </ol>
  )
}

function LegalParagraph({ children }: { children: string }) {
  const email = "support@arcnaples.com"
  const emailStart = children.indexOf(email)

  if (emailStart === -1) return <p>{children}</p>

  return (
    <p>
      {children.slice(0, emailStart)}
      <a className="font-medium text-foreground underline underline-offset-4" href={`mailto:${email}`}>
        {email}
      </a>
      {children.slice(emailStart + email.length)}
    </p>
  )
}

export function LegalDocument({ title, effectiveDate, sections }: LegalDocumentProps) {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 lg:py-12">
        <header className="border-b border-border pb-7">
          <Link
            href="/"
            className="mb-7 inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
            Back to Arc
          </Link>
          <div className="flex items-center gap-5">
            <div className="flex size-16 shrink-0 items-center justify-center border border-border/60 bg-card shadow-sm">
              <Image src="/arc-logo2.svg" alt="Arc" width={44} height={44} className="size-11" priority />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {companyName}
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
              <p className="mt-2 text-sm text-muted-foreground">Effective {effectiveDate}</p>
            </div>
          </div>
        </header>

        <details className="my-6 border border-border/60 bg-card p-4 lg:hidden">
          <summary className="cursor-pointer text-sm font-semibold">On this page</summary>
          <nav aria-label={`${title} sections`} className="mt-3">
            <SectionLinks sections={sections} />
          </nav>
        </details>

        <div className="grid gap-12 pt-8 lg:grid-cols-[13rem_minmax(0,1fr)] lg:pt-10">
          <aside className="hidden lg:block">
            <nav aria-label={`${title} sections`} className="sticky top-8">
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                On this page
              </p>
              <SectionLinks sections={sections} />
            </nav>
          </aside>

          <article className="min-w-0 space-y-10">
            {sections.map((section) => (
              <section key={section.title} id={sectionId(section.title)} className="scroll-mt-8 space-y-3">
                <h2 className="text-lg font-semibold tracking-tight">{section.title}</h2>
                <div className="max-w-3xl space-y-3 text-sm leading-7 text-muted-foreground sm:text-[15px]">
                  {section.body.map((paragraph) => (
                    <LegalParagraph key={paragraph}>{paragraph}</LegalParagraph>
                  ))}
                </div>
              </section>
            ))}
          </article>
        </div>

        <footer className="mt-12 flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-6 text-sm text-muted-foreground lg:ml-[16rem]">
          <Link className="transition-colors hover:text-foreground" href="/privacy">
            Privacy
          </Link>
          <Link className="transition-colors hover:text-foreground" href="/terms">
            Terms
          </Link>
          <Link className="transition-colors hover:text-foreground" href="/esign-terms">
            Electronic signatures
          </Link>
        </footer>
      </div>
    </main>
  )
}
