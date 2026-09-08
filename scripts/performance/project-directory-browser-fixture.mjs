// Builds the actual before/after directory components with deterministic data.
// Only Next navigation, server actions, and network reads are replaced; UI code
// and its component dependencies are compiled unchanged, in production mode.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
const { build } = await import(
  process.env.ESBUILD_PACKAGE ??
    "/private/tmp/arc-projects-test/node_modules/esbuild/lib/main.js"
);
const root = process.cwd(),
  out = "/private/tmp/arc-projects-ui";
mkdirSync(out, { recursive: true });
const shim = `import React from 'react';
export function useSearchParams(){const value=React.useSyncExternalStore(cb=>{window.addEventListener('popstate',cb);return()=>window.removeEventListener('popstate',cb)},()=>location.search,()=>location.search);return React.useMemo(()=>new URLSearchParams(value),[value]);}
export function usePathname(){return '/projects'}
export function useRouter(){return {push:(url)=>history.pushState(null,'',url),replace:(url)=>history.replaceState(null,'',url),refresh:()=>{}}}
export const OptimisticLink=React.forwardRef(({prefetchOnIntent,prefetch,children,...props},ref)=><a {...props} ref={ref}>{children}</a>);
export default function dynamic(loader){const Component=React.lazy(()=>loader().then(m=>({default:m.default??m})));return props=><React.Suspense fallback={<p>Loading editor…</p>}><Component {...props}/></React.Suspense>}
`;
const actions = `const call=(name,data)=>{window.__actions.push(name);return Promise.resolve(data)};
export const listProjectQboClassesAction=()=>call('classes',[]);
export const getCostCodingSettingsAction=()=>call('costCodes',{costCodesEnabled:true});
export const searchProjectQboCustomersAction=()=>call('customers',{connected:false,customers:[]});
export const createProjectQboCustomerAction=()=>call('createCustomer',{success:false});
export const listProjectClientContactsAction=()=>call('contacts',[]);
export const getProjectDirectoryEditorAction=(id)=>call('editor',window.__projects.find(p=>p.id===id));
export const getProjectScheduleItemsAction=()=>call('scheduleItems',[]);
export const createProjectAction=(input)=>call('create',{success:true,data:{...input,id:crypto.randomUUID()}});
export const updateProjectAction=(id,input)=>call('update',{success:true,data:{...input,id}});
export const deleteProjectAction=()=>call('delete',{success:true});
`;
for (const mode of ["before", "after"]) {
  const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import {ProjectsClient} from 'fixture-component';import {useSearchParams} from 'fixture-shim';
  for(const method of ['pushState','replaceState']){const original=history[method].bind(history);history[method]=(...args)=>{original(...args);window.dispatchEvent(new PopStateEvent('popstate'))}}
  const n=Number(new URLSearchParams(location.search).get('size')||33);
  const id=i=>'00000000-0000-4000-8000-'+String(i).padStart(12,'0');
  const all=Array.from({length:n},(_,i)=>({id:id(i+1),org_id:id(999999),name:'Project '+String(i+1).padStart(5,'0'),status:i%3?'active':'completed',phase:'delivery',address:'Address '+i,client_name:'Client '+i,client_id:id(i+10000),total_value:100000+i,value_cents:10000000+i*100,summary:null,created_at:'2026-01-01',updated_at:'2026-01-01'}));
  const contacts=all.map(p=>({id:p.client_id,full_name:p.client_name,org_id:p.org_id}));
  const summaries=Object.fromEntries(all.map(p=>[p.id,{percent:40,total:10,completed:4,in_progress:3,upcoming:3}]));
  const communities=[{id:id(900001),name:'Community A'},{id:id(900002),name:'Community B'}];
  window.__projects=all;window.__actions=[];window.__requests=[];window.__delays={};
  window.fetch=async(url,{signal}={})=>{window.__requests.push(url);const u=new URL(url,location.origin);const q=u.searchParams;await new Promise((ok,no)=>{const t=setTimeout(ok,window.__delays[q.get('q')]??30);signal?.addEventListener('abort',()=>{clearTimeout(t);no(new DOMException('Aborted','AbortError'))},{once:true})});
    if(u.pathname.endsWith('/progress'))return new Response(JSON.stringify(Object.fromEntries((q.get('ids')||'').split(',').filter(Boolean).map(id=>[id,summaries[id]]))));
    let rows=all.filter(p=>(!q.get('q')||p.name.toLowerCase().includes(q.get('q').toLowerCase()))&&(!q.get('status')||q.get('status')==='all'||p.status===q.get('status')));
    if(q.get('community')===communities[0].id)rows=rows.slice(0,2);if(q.get('community')===communities[1].id)rows=rows.slice(-2);
    if(q.get('direction')==='desc')rows.reverse();const offset=Number(q.get('cursor')||0);return new Response(JSON.stringify({rows:rows.slice(offset,offset+50),nextCursor:rows.length>offset+50?String(offset+50):null}));};
  const base={q:'',status:'all',sort:'name',direction:'asc'};
  function App(){const params=useSearchParams();let rows=all;const community=params.get('community');if(community===communities[0].id)rows=all.slice(0,2);if(community===communities[1].id)rows=all.slice(-2);
    React.useEffect(()=>{requestAnimationFrame(()=>requestAnimationFrame(()=>{window.__ready=performance.now();window.__rowCount=document.querySelectorAll('tbody tr').length}))},[]);
    return <div style={{height:'95vh'}}><ProjectsClient ${mode === "before" ? "projects={rows} clientContacts={contacts} scheduleSummaries={summaries}" : 'initialPage={{rows:all.slice(0,50),nextCursor:all.length>50?"50":null}} initialQuery={base} canReadSchedule={true}'} productTier="residential" communities={communities} communityId={community||undefined}/></div>}
  window.__start=performance.now();createRoot(document.getElementById('root')).render(<App/>);`;
  const result = await build({
    stdin: { contents: entry, resolveDir: root, loader: "tsx" },
    bundle: true,
    format: "esm",
    splitting: true,
    outdir: out + "/" + mode,
    minify: true,
    metafile: true,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "fixture",
        setup(b) {
          b.onResolve({ filter: /^fixture-component$/ }, () => ({
            path: "component",
            namespace: "fixture",
          }));
          b.onLoad({ filter: /^component$/, namespace: "fixture" }, () => ({
            contents:
              mode === "before"
                ? execFileSync(
                    "git",
                    [
                      "show",
                      "94ec5e86de0faf3e14c924a38961545888ddb84f:app/(app)/projects/projects-client.tsx",
                    ],
                    { encoding: "utf8" },
                  )
                : readFileSync(
                    resolve(root, "app/(app)/projects/projects-client.tsx"),
                    "utf8",
                  ),
            loader: "tsx",
            resolveDir: resolve(root, "app/(app)/projects"),
          }));
          b.onResolve(
            {
              filter:
                /^(fixture-shim|next\/navigation|next\/dynamic|@\/lib\/navigation\/optimistic-pathname)$/,
            },
            () => ({ path: "shim", namespace: "fixture" }),
          );
          b.onLoad({ filter: /^shim$/, namespace: "fixture" }, () => ({
            contents: shim,
            loader: "tsx",
            resolveDir: root,
          }));
          b.onResolve({ filter: /actions$/ }, () => ({
            path: "actions",
            namespace: "fixture",
          }));
          b.onLoad({ filter: /^actions$/, namespace: "fixture" }, () => ({
            contents: actions,
            loader: "js",
            resolveDir: root,
          }));
          b.onResolve({ filter: /^@\// }, (args) => ({
            path:
              resolve(root, args.path.slice(2)) +
              ([".tsx", ".ts", ".js"].find((ext) => {
                try {
                  readFileSync(resolve(root, args.path.slice(2)) + ext);
                  return true;
                } catch {
                  return false;
                }
              }) ?? "/index.ts"),
          }));
        },
      },
    ],
  });
  writeFileSync(
    out + "/" + mode + "/meta.json",
    JSON.stringify(result.metafile, null, 2),
  );
  writeFileSync(
    out + "/" + mode + "/index.html",
    `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/${mode}/stdin.js"></script></body></html>`,
  );
}
console.log("Built before and after browser fixtures in " + out);
