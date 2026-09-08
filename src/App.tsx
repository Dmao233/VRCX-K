import { invoke, isTauri } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { useEffect, useRef, useState } from "react"
import "./App.css"
import { connectHostWs, type HostReady, type HostWsAPI } from "./host"

type Status = "connecting" | "connected" | "reconnecting"

function statusLabel(status: Status, version: string | null) {
  if (status === "connected" && version) return `已连接（${version}）`
  if (status === "reconnecting") return "重连中"
  return "连接中"
}

function App() {
  const [status, setStatus] = useState<Status>("connecting")
  const [version, setVersion] = useState<string | null>(null)
  const [pingMsg, setPingMsg] = useState("")
  const apiRef = useRef<HostWsAPI | null>(null)
  const closeRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let current: HostReady | null = null
    let generation = 0
    let attachedKey: string | null = null
    let attachChain = Promise.resolve()

    const sessionKey = (ready: HostReady) => `${ready.port}:${ready.token}`

    const detach = () => {
      closeRef.current?.()
      closeRef.current = null
      apiRef.current = null
      attachedKey = null
    }

    const attach = (ready: HostReady) => {
      attachChain = attachChain.then(() => attachOne(ready))
    }

    const attachOne = async (ready: HostReady) => {
      const key = sessionKey(ready)
      if (attachedKey === key && apiRef.current) return
      const gen = ++generation
      current = ready
      detach()
      if (cancelled) return
      const session = connectHostWs(ready, () => {
        if (cancelled || gen !== generation) return
        attachedKey = null
        setStatus("reconnecting")
        setVersion(null)
        retry = setTimeout(() => {
          if (current) attach(current)
        }, 1000)
      })
      if (gen !== generation) {
        session.close()
        return
      }
      closeRef.current = session.close
      apiRef.current = session.api
      attachedKey = key
      try {
        const nextVersion = await session.api.getVersion()
        if (cancelled || gen !== generation) return
        setVersion(nextVersion)
        setStatus("connected")
        setPingMsg("")
      } catch {
        if (!cancelled && gen === generation) setStatus("reconnecting")
      }
    }

    if (!isTauri()) {
      return () => {
        cancelled = true
      }
    }

    void invoke<HostReady | null>("get_host_ready")
      .then((ready) => {
        if (ready && !cancelled) attach(ready)
      })
      .catch(() => {})

    void listen<HostReady>("host-ready", (event) => {
      if (!cancelled) attach(event.payload)
    }).then((fn) => {
      unlisten = fn
    })

    return () => {
      cancelled = true
      unlisten?.()
      if (retry) clearTimeout(retry)
      detach()
    }
  }, [])

  async function ping() {
    const api = apiRef.current
    if (!api) return
    try {
      setPingMsg(await api.ping())
    } catch (err) {
      setPingMsg(String(err))
      setStatus("reconnecting")
    }
  }

  return (
    <main className="container">
      <h1>VRCX-K</h1>
      <p className="status">{statusLabel(status, version)}</p>
      <button type="button" disabled={status !== "connected"} onClick={() => void ping()}>
        ping
      </button>
      {pingMsg ? <p className="ping">{pingMsg}</p> : null}
    </main>
  )
}

export default App
