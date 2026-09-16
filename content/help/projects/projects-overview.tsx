import Link from "next/link"

export default function ProjectsOverviewArticle() {
  return (
    <>
      <p>
        Projects are the main containers for job-specific work in Arc. Each project brings
        together its team, documents, correspondence, field operations, financials, and closeout records.
      </p>
      <h2>Open the project directory</h2>
      <p>
        Go to <Link href="/projects">Projects</Link> to create a project, search existing
        jobs, filter by status, or open a project.
      </p>
      <h2>Inside a project</h2>
      <p>
        The Overview summarizes the job and provides project actions. The remaining tools
        are grouped under Plan, Build, Financials, and Close.
      </p>
      <h2>Keep the communication record with the job</h2>
      <p>
        Use <Link href="/help/projects/project-management/project-correspondence">Project Correspondence</Link>
        {" "}to file and search project email alongside the records it relates to. The project inbox is for
        work communication that should be available to the team, not a replacement for sensitive channels.
      </p>
      <h2>Project access</h2>
      <p>
        Organization membership and project assignment are separate. Administrators can
        invite someone to Arc, then add that teammate to the projects where they should
        work.
      </p>
      <h2>Project settings</h2>
      <p>
        Project settings control core details such as status, dates, address, client,
        contract structure, billing model, and accounting links. Financial settings should
        be reviewed carefully before transactions are entered.
      </p>
    </>
  )
}
