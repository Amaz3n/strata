import { createRequire } from "node:module";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
const require = createRequire(import.meta.url);
import { resolve } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
const target = process.argv[2];
if (!target) throw Error("Pass a temporary output directory");
await mkdir(target, { recursive: true });
const drafts = process.argv[3] === "intake-drafts";
const intake = process.argv[3] === "intake" || drafts;
const entry = drafts
  ? `import {createRoot} from 'react-dom/client';import {PayrollRegisterIntake} from '${resolve("components/time/payroll-register-intake.tsx")}';import {PayrollDraftWorkspace} from '${resolve("components/time/payroll-draft-workspace.tsx")}';import {loadProjectPayrollDraftAction} from '@/app/(app)/projects/[id]/time/payroll/actions';fetch('/seed').then(r=>r.json()).then(async initial=>{const id=new URLSearchParams(location.search).get('draft');const detail=id?await loadProjectPayrollDraftAction({projectId:initial.projectId,importId:id}):null;createRoot(document.getElementById('root')).render(<><PayrollRegisterIntake projectId={initial.projectId}/><PayrollDraftWorkspace initial={initial.drafts} initialDetail={detail?.success?detail.data:null}/></>)});`
  : intake
    ? `import {createRoot} from 'react-dom/client';import {PayrollRegisterIntake} from '${resolve("components/time/payroll-register-intake.tsx")}';fetch('/seed').then(r=>r.json()).then(initial=>createRoot(document.getElementById('root')).render(<PayrollRegisterIntake projectId={initial.projectId}/>));`
    : `import {createRoot} from 'react-dom/client';import {PayrollCorrectionWorkspace} from '${resolve("components/time/payroll-correction-workspace.tsx")}';fetch('/seed').then(r=>r.json()).then(initial=>createRoot(document.getElementById('root')).render(<PayrollCorrectionWorkspace initial={initial}/>));`;
const actions = [
  "loadProjectPayrollPaymentWorkspaceAction",
  "reviewProjectPayrollPaymentAttributionAction",
  "withdrawProjectPayrollPaymentAttributionAction",
  "loadProjectPayrollSupportVersionsAction",
  "previewProjectPayrollPaymentReviewAction",
  "prepareProjectPayrollPaymentReviewAction",
  "loadProjectPayrollDraftsAction",
  "loadProjectPayrollDraftAction",
  "reviewProjectPayrollDraftAction",
  "withdrawProjectPayrollDraftAction",
  "previewProjectPayrollAllocationAction",
  "prepareProjectPayrollAllocationAction",
  "loadProjectPayrollWorkersAction",
  "previewProjectPayrollWorkerLaborAction",
  "prepareProjectPayrollUploadAction",
  "inspectProjectPayrollUploadAction",
  "loadProjectPayrollCorrectionsAction",
  "loadProjectPayrollCorrectionAction",
  "previewProjectPayrollPlacementAction",
  "reviewProjectPayrollSourceAction",
  "withdrawProjectPayrollSourceAction",
  "prepareProjectPayrollProposalAction",
  "reviewProjectPayrollProposalAction",
  "withdrawProjectPayrollProposalAction",
  "postProjectPayrollProposalAction",
];
await writeFile(resolve(target, "entry.tsx"), entry);
const result = await Bun.build({
  entrypoints: [resolve(target, "entry.tsx")],
  outdir: target,
  target: "browser",
  plugins: [
    {
      name: "payroll-isolated-ui",
      setup(build) {
        build.onResolve({ filter: /^(react|react-dom)(\/|$)/ }, (args) => ({
          path: require.resolve(args.path),
        }));
        build.onResolve({ filter: /^payroll-fixture-entry$/ }, () => ({
          path: "entry.tsx",
          namespace: "fixture",
        }));
        build.onResolve({ filter: /^next\/link$/ }, () => ({
          path: "link.tsx",
          namespace: "fixture",
        }));
        build.onResolve(
          {
            filter:
              /^@\/app\/\(app\)\/projects\/\[id\]\/time\/payroll\/actions$/,
          },
          () => ({ path: "actions.js", namespace: "fixture" }),
        );
        build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          loader: path.endsWith(".tsx") ? "tsx" : "js",
          resolveDir: process.cwd(),
          contents:
            path === "entry.tsx"
              ? entry
              : path === "link.tsx"
                ? `export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>}`
                : actions
                    .map(
                      (name) =>
                        `export async function ${name}(...args){const r=await fetch('/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:${JSON.stringify(name)},args})});return r.json()}`,
                    )
                    .join("\n"),
        }));
      },
    },
  ],
});
if (!result.success) throw Error(result.logs.join("\n"));
console.log(result.outputs[0].path);

const css = await postcss([tailwindcss()]).process(
  await readFile(resolve("app/globals.css"), "utf8"),
  { from: resolve("app/globals.css") },
);
await writeFile(resolve(target, "style.css"), css.css);
