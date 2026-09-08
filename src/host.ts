import { RPCChannel } from "kkrpc"
import { webSocketClientTransport } from "kkrpc/ws"

export type HostReady = {
  port: number
  token: string
}

export type HostWsAPI = {
  ping(): Promise<string>
  getVersion(): Promise<string>
}

export function hostWsUrl(ready: HostReady) {
  return `ws://127.0.0.1:${ready.port}?token=${ready.token}`
}

export function connectHostWs(ready: HostReady, onClose: () => void) {
  const channel = new RPCChannel<object, HostWsAPI>(
    webSocketClientTransport({ url: hostWsUrl(ready) }),
    { onClose: () => onClose() },
  )
  return {
    api: channel.getAPI(),
    close() {
      channel.destroy()
    },
  }
}
