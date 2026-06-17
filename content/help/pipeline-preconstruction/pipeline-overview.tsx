import Link from "next/link"

export default function PipelineOverviewArticle() {
  return (
    <>
      <p>
        Pipeline &amp; Preconstruction tools allow builders and contractors to track potential sales opportunities, 
        coordinate subcontractor pricing, generate estimates, send proposals, and promote won deals into active projects 
        without losing any historical information.
      </p>

      <h2>Core Modules in Pipeline &amp; Preconstruction</h2>
      <p>
        Preconstruction is comprised of four key workflows. Click the detailed guides below to learn how to manage 
        each phase:
      </p>

      <h3>1. Prospects &amp; CRM Funnel</h3>
      <p>
        Track sales inquiries, categorize lead priorities and budget ranges, record follow-ups, and manage opportunities 
        through the CRM funnel stages.
        {" "}
        <Link href="/help/pipeline-and-preconstruction/pipeline-basics/prospects">
          Read the Prospects Guide
        </Link>
        .
      </p>

      <h3>2. Estimates &amp; Proposals</h3>
      <p>
        Structure preconstruction cost estimates, markup pricing, configure client-selectable optional upgrades, and draft 
        contracts with terms ready for client signature.
        {" "}
        <Link href="/help/pipeline-and-preconstruction/pipeline-basics/estimates-proposals">
          Read the Estimates &amp; Proposals Guide
        </Link>
        .
      </p>

      <h3>3. Preconstruction Bidding</h3>
      <p>
        Issue bid packages to subcontractors during the bidding phase, distribute plans, collect early trade proposals, 
        and tie subcontractor pricing into your estimates.
        {" "}
        <Link href="/help/pipeline-and-preconstruction/pipeline-basics/preconstruction-bidding">
          Read the Preconstruction Bidding Guide
        </Link>
        .
      </p>

      <h3>4. Project Conversion &amp; Promotion</h3>
      <p>
        Convert executing prospects into active projects. Automate contact directory promotions, migrate drawings and files, 
        and initialize budgets and contracts.
        {" "}
        <Link href="/help/pipeline-and-preconstruction/pipeline-basics/project-conversion">
          Read the Project Conversion Guide
        </Link>
        .
      </p>
    </>
  )
}
