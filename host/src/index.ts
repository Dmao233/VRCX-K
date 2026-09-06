// VRCX-K host entry — Cordis runtime (the "brain")
// M0 PoC: bootstrap Cordis + loader + include, then expose host services.
import { Context } from 'cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@cordisjs/plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

console.log('[host] starting Cordis...')
await ctx.plugin(Loader)

console.log('[host] ready. host services exposed via kkrpc/ws (M0 skeleton).')
// TODO(M0): wire kkrpc/ws server; expose VRChat API / friend / world services.

await new Promise(() => {}) // keep alive
