require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module"),
  React = require("react"),
  { renderToStaticMarkup } = require("react-dom/server");
test("embedded ownership controls render without executing server actions or importing Node accounting dependencies into the client graph", () => {
  const path = require.resolve("../components/books/project-owner"),
    original = Module._load,
    loaded = [];
  let C;
  try {
    Module._load = function (name, ...args) {
      loaded.push(name);
      if (name === "@/app/(app)/books/actions")
        return new Proxy(
          {},
          {
            get: () => () => {
              throw Error("Server action called during render");
            },
          },
        );
      return original.call(this, name, ...args);
    };
    delete require.cache[path];
    C = require(path).ProjectBooksOwner;
  } finally {
    Module._load = original;
  }
  const id = "88200000-0000-4000-8000-000000000001";
  const html = renderToStaticMarkup(
    React.createElement(C, {
      orgId: id,
      actorId: id,
      projectId: id,
      today: "2026-10-05",
    }),
  );
  assert.match(html, /Project accounting ownership/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Review ownership/);
  assert.ok(
    !loaded.some((n) =>
      ["node:crypto", "node:fs", "./project-entity-archive"].includes(n),
    ),
  );
});
