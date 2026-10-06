#!/usr/bin/env node
const fs = require("node:fs");
const { stage, read, execute } = require("./books-acceptance/bootstrap.cjs");
function main() {
  const args = process.argv.slice(2);
  let workspace,
    port,
    baselineFile,
    run = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--run") run = true;
    else if (args[i] === "--workspace" && !workspace) workspace = args[++i];
    else if (args[i] === "--db-port" && port === undefined)
      port = Number(args[++i]);
    else if (args[i] === "--baseline-file" && !baselineFile)
      baselineFile = args[++i];
    else
      throw Error(
        "Use --workspace NEW_DIRECTORY --db-port PORT [--baseline-file MIGRATION_LIST] [--run]; an existing STAGED directory may use --workspace DIRECTORY --run",
      );
  }
  if (!workspace) throw Error("An explicit new isolated workspace is required");
  const baseline = baselineFile
    ? fs.readFileSync(baselineFile, "utf8").split("\n").filter(Boolean)
    : undefined;
  const job =
    port === undefined
      ? read(workspace)
      : stage(workspace, port, undefined, baseline);
  if (run) execute(job);
  console.log(
    `${job.status}: ${job.projectId}; evidence ${job.workspace}/bootstrap.json`,
  );
}
if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
