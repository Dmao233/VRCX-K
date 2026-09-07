// VRCX-K host entry — Cordis runtime (the "brain").
// M1 skeleton: structure + lifecycle primitives.
//   - L0: Cordis + loader bootstrap (M0)
//   - L1: lifecycle signals for the shell supervisor (M1-3): exit code 51 = restart,
//         SIGTERM/stop = graceful shutdown
//   - L2: kkrpc/stdio bridge endpoint + dynamic ws port reporting land in M1-4
//
// NB: stdout is reserved for the kkrpc/stdio protocol channel (see D1 findings).
//     All host logging MUST go through the `log` helper (stderr) once the bridge
//     is live. Until then, keep stdout clean anyway.

import { Context } from 'cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@cordisjs/plugin-loader'

// --- lifecycle: exit codes -------------------------------------------------
// 0  = clean exit (stop requested)
// 51 = request restart (koishi daemon semantics) — shell supervisor restarts us
export const EXIT_RESTART = 51

const log = (...args: unknown[]) => console.error('[host]', ...args)

async function bootstrap() {
  log('starting Cordis...')
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

  await ctx.plugin(Loader)

  // TODO(M1-3): dynamic ws port: bind 127.0.0.1:0, report port over stdio bridge
  // TODO(M1-3): graceful stop: handle stop command -> dispose fibers -> exit 0
  // TODO(M1-4): kkrpc/stdio bridge: expose host services to the Rust shell;
  //             also answer Rust's reverse calls (system events, tray commands)

  log('ready. host services exposed via kkrpc/ws (M1 skeleton).')
}

// stdin "stop" line = graceful stop request from the shell (supervisor writes
// this before killing, or as the M1-3 stop protocol). Exit 0 on clean stop.
// TODO(M1-4): once the kkrpc/stdio bridge owns stdin, this moves into the bridge.
let stopping = false
process.stdin?.resume()
process.stdin?.on('data', (chunk) => {
  const line = chunk.toString().trim()
  if (line === 'stop' && !stopping) {
    stopping = true
    log('stop requested via stdin — exiting 0')
    process.exit(0)
  }
})

process.on('SIGTERM', () => {
  if (stopping) return
  stopping = true
  log('SIGTERM — exiting 0')
  process.exit(0)
})

// Keep alive until stopped.
process.on('SIGINT', () => process.exit(0))

bootstrap().catch((err) => {
  console.error('[host] fatal bootstrap error', err)
  process.exit(1)
})

await new Promise(() => {}) // keep alive (bootstrap above runs async)
