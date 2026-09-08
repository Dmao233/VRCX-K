import { randomBytes } from "node:crypto"
import type { AddressInfo } from "node:net"
import { expose } from "kkrpc"
import { webSocketTransport } from "kkrpc/ws"
import { WebSocketServer } from "ws"
import type { Context } from "cordis"
import { hostWsAPI } from "./api"

export type HostWsReady = {
  port: number
  token: string
}

export async function listenHostWs(ctx: Context): Promise<HostWsReady> {
  const token = randomBytes(32).toString("hex")
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 })

  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve())
    wss.once("error", reject)
  })

  const address = wss.address()
  if (!address || typeof address === "string") {
    wss.close()
    throw new Error("host ws failed to bind 127.0.0.1:0")
  }
  const { port } = address as AddressInfo

  wss.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.searchParams.get("token") !== token) {
      socket.close(1008, "invalid token")
      return
    }
    const controller = expose(hostWsAPI, webSocketTransport(socket))
    socket.once("close", () => controller.dispose())
  })

  ctx.effect(() => () => {
    wss.close()
  })

  return { port, token }
}
