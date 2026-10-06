const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
require("../../../scripts/register-ts-node-test");
const root = path.resolve(__dirname, "../../..");
// Unknown application dependencies fail on use rather than loading credentials.
function loadHandler(relativePath, overrides = {}, exports = []) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = (id) => {
    if (Object.hasOwn(overrides, id)) return overrides[id];
    if (id === "server-only") return {};
    if (id.startsWith("@/lib/drawings/") || id.startsWith("@/lib/validation/"))
      return require(id);
    if (id.startsWith("@/"))
      return new Proxy(
        {},
        {
          get: (_, name) => {
            throw new Error(
              `Missing fixture dependency: ${id}.${String(name)}`,
            );
          },
        },
      );
    if (/^(?:node:)?(?:https?|net|tls|dns)$/.test(id))
      throw new Error(`Blocked network module: ${id}`);
    return require(id);
  };
  const source =
    fs.readFileSync(filename, "utf8") +
    (exports.length ? `\nexport { ${exports.join(",")} };` : "");
  mod._compile(
    ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );
  return mod.exports;
}
function fakeClock(start = 0) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
}
function blockNetwork(t, routes = {}) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    const key = String(url);
    calls.push(key);
    if (!Object.hasOwn(routes, key))
      throw new Error(`Non-fixture URL blocked: ${key}`);
    return routes[key](options);
  };
  t.after(() => {
    global.fetch = original;
  });
  return calls;
}
function database(
  tables = {},
  rpc = async () => {
    throw new Error("Missing fixture RPC");
  },
) {
  const counts = { databaseCalls: 0 };
  const faults = new Map();
  const field = (row, key) =>
    key.split(/->>?/).reduce((value, part) => value?.[part], row);
  const client = {
    rpc: async (...args) => {
      counts.databaseCalls++;
      return rpc(...args);
    },
    from(table) {
      const filters = [];
      let mutation,
        one = false,
        limit = Infinity,
        count = false;
      const q = {
        select: (_, options) => {
          count = !!options?.count;
          return q;
        },
        eq: (k, v) => {
          filters.push((r) => field(r, k) === v);
          return q;
        },
        neq: (k, v) => {
          filters.push((r) => field(r, k) !== v);
          return q;
        },
        in: (k, v) => {
          filters.push((r) => v.includes(field(r, k)));
          return q;
        },
        gte: (k, v) => {
          filters.push((r) => field(r, k) >= v);
          return q;
        },
        lt: (k, v) => {
          filters.push((r) => field(r, k) < v);
          return q;
        },
        lte: (k, v) => {
          filters.push((r) => field(r, k) <= v);
          return q;
        },
        is: (k, v) => {
          filters.push((r) => (field(r, k) ?? null) === v);
          return q;
        },
        not: (k, _, v) => {
          filters.push((r) => (field(r, k) ?? null) !== v);
          return q;
        },
        contains: (k, v) => {
          filters.push((r) =>
            Object.entries(v).every(([key, value]) => r[k]?.[key] === value),
          );
          return q;
        },
        order: () => q,
        limit: (n) => {
          limit = n;
          return q;
        },
        single: () => {
          one = true;
          return q;
        },
        maybeSingle: () => {
          one = true;
          return q;
        },
        insert: (value) => {
          mutation = { kind: "insert", value };
          return q;
        },
        update: (value) => {
          mutation = { kind: "update", value };
          return q;
        },
        delete: () => {
          mutation = { kind: "delete" };
          return q;
        },
        then(resolve, reject) {
          return Promise.resolve()
            .then(() => {
              counts.databaseCalls++;
              if (!Object.hasOwn(tables, table))
                throw new Error(`Missing fixture table: ${table}`);
              const fault = faults.get(
                `${table}:${mutation?.kind ?? "select"}`,
              );
              if (fault) return { data: null, error: { message: fault } };
              let rows = tables[table]
                .filter((r) => filters.every((f) => f(r)))
                .slice(0, limit);
              if (mutation?.kind === "insert") {
                rows = [mutation.value]
                  .flat()
                  .map((value) => ({
                    id: `${table}-${tables[table].length}`,
                    ...structuredClone(value),
                  }));
                tables[table].push(...rows);
              }
              if (mutation?.kind === "update")
                rows.forEach((r) =>
                  Object.assign(r, structuredClone(mutation.value)),
                );
              if (mutation?.kind === "delete")
                tables[table] = tables[table].filter((r) => !rows.includes(r));
              return {
                data: structuredClone(one ? (rows[0] ?? null) : rows),
                error: null,
                count: count ? rows.length : null,
              };
            })
            .then(resolve, reject);
        },
      };
      return q;
    },
  };
  return { client, tables, counts, faults };
}
module.exports = { loadHandler, fakeClock, blockNetwork, database };
