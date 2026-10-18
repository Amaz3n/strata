#!/usr/bin/env node
const {
  GOLDEN_SCENARIOS,
  parseArgs,
  execute,
} = require("./books-acceptance/runtime.cjs");
const { SCENARIO_MODULES } = require("./books-acceptance/scenario-runner.cjs");
async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (config.list) {
    console.log(
      JSON.stringify(
        [
          {
            id: "SCHEMA-01",
            implementation:
              "Current isolated schema identity and complete pgTAP runner",
          },
          ...GOLDEN_SCENARIOS.map((id) => ({
            id,
            implementation: SCENARIO_MODULES[id]
              ? `scripts/books-acceptance/scenario-runner.cjs (subcases listed in scripts/books-acceptance/expected/${id}.json)`
              : "NOT_IMPLEMENTED",
          })),
        ],
        null,
        2,
      ),
    );
    return;
  }
  const record = await execute(config);
  console.log(
    `${record.scenario}: ${record.status}; ${record.assertions} assertions; evidence ${config.evidenceDir}`,
  );
}
if (require.main === module)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
