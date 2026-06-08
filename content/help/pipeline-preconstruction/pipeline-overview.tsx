import Link from "next/link"

export default function PipelineOverviewArticle() {
  return (
    <>
      <p>
        Pipeline and Preconstruction help teams manage opportunities before they become
        active projects.
      </p>
      <h2>Track prospects</h2>
      <p>
        Open <Link href="/pipeline">Pipeline</Link> to review opportunities, status,
        follow-ups, and activity. Use the prospect record to keep the sales and
        preconstruction context together.
      </p>
      <h2>Follow-ups</h2>
      <p>
        Follow-ups help the team record the next action and identify work that is due or
        overdue.
      </p>
      <h2>Estimates and proposals</h2>
      <p>
        Estimates structure proposed scope and pricing. Signature workflows can be used
        for supported proposals and execution documents.
      </p>
      <h2>Preconstruction bids</h2>
      <p>
        Prospect bid packages can be used to invite vendors and collect pricing before the
        opportunity is converted into a project.
      </p>
    </>
  )
}
