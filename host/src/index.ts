import "./log"
import { pathToFileURL } from "node:url"
import { Context } from "cordis"
import Include from "@cordisjs/plugin-include"
import Loader from "@cordisjs/plugin-loader"
import { HOST_VERSION } from "./api"
import { log } from "./log"
import { listenHostWs } from "./ws"

export const EXIT_RESTART = 51

async function bootstrap() {
  log("starting Cordis...")
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(process.cwd()).href + "/"

  await ctx.plugin(Loader)
  await ctx.plugin(Include, { path: "./cordis.yml", enableLogs: false })

  if (!ctx.get("heartbeat")) {
    throw new Error("heartbeat plugin failed to assemble")
  }

  const ready = await listenHostWs(ctx)
  log(`ready ${JSON.stringify({ ...ready, version: HOST_VERSION })}`)
}

let stopping = false
process.stdin?.resume()
// TODO(M1-4): kkrpc/stdio 桥接管 stdin 后此处理移至桥内
process.stdin?.on("data", (chunk) => {
  const line = chunk.toString().trim()
  if (line === "stop" && !stopping) {
    stopping = true
    log("stop requested via stdin — exiting 0")
    process.exit(0)
  }
})

process.on("SIGTERM", () => {
  if (stopping) return
  stopping = true
  log("SIGTERM — exiting 0")
  process.exit(0)
})

process.on("SIGINT", () => process.exit(0))

try {
  await bootstrap()
} catch (err) {
  console.error("[host] fatal bootstrap error", err)
  process.exit(1)
}

await new Promise(() => {})
