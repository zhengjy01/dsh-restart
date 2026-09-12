/**
 * A stand-in DSH host for tests.
 *
 * Mounts the real dsh-restart route table on a free port and does nothing else.
 * The handoff test runs two generations of this process to exercise the whole
 * feature end to end: restart request → old process exits → detached helper
 * relaunches the same command → the port answers again → the page reconnects.
 *
 *   node tests/fixtures/fake-host.mjs <port>
 */

import { createServer } from 'node:http'

import { makeRoutes } from '../../lib/index.js'

const port = Number(process.argv[2])
if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  console.error('[fake-host] usage: fake-host.mjs <port>')
  process.exit(2)
}

const deps = { port, host: '127.0.0.1', url: `http://127.0.0.1:${port}` }
const table = new Map(makeRoutes(deps).map((route) => [route.path, route.handler]))

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  const handler = table.get(path)
  if (handler === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  Promise.resolve()
    .then(() => handler(req, res))
    .catch((error) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('route failed: ' + String(error))
    })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[fake-host] listening on ${port} pid=${process.pid}`)
})

process.on('SIGTERM', () => {
  console.log('[fake-host] SIGTERM received, exiting')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 500).unref()
})
