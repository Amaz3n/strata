const assert = require("node:assert/strict")
const { test } = require("node:test")

require("../scripts/register-ts-node-test")
const React = require("react")
const { renderToStaticMarkup } = require("react-dom/server")

const { QueuePagination } = require("@/components/layout/queue-pagination")

const links = (props) =>
  [...renderToStaticMarkup(React.createElement(QueuePagination, props)).matchAll(/href="([^"]+)"/g)].map(
    ([, href]) => href.replaceAll("&amp;", "&"),
  )

test("paging one queue keeps the other queue's page and the scope filters", () => {
  const props = {
    page: 2,
    pageSize: 50,
    total: 151,
    href: "/safety?observationsPage=3&division=d",
    pageParam: "incidentsPage",
  }
  assert.deepEqual(links(props), [
    "/safety?observationsPage=3&division=d&incidentsPage=1",
    "/safety?observationsPage=3&division=d&incidentsPage=3",
  ])
})
