import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { wrap, dispose } from "kkrpc"
import { webSocketClientTransport } from "kkrpc/ws"
import type { HostWsAPI } from "../src/api"
import { HOST_VERSION } from "../src/api"

const hostDir = join(import.meta.dir, "..")

type HostProc = ReturnType<typeof Bun.spawn>

let proc: HostProc | undefined

afterEach(() => {
  proc?.kill()
  proc = undefined
})

async function spawnHost() {
  proc = Bun.spawn(["bun", "src/index.ts"], {
    cwd: hostDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const ready = await readReady(proc.stderr)
  return { proc, ready }
}

async function readReady(stderr: ReadableStream<Uint8Array>) {
  const reader = stderr.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const match = buf.match(/\[host\] ready ({.*})/)
    if (match) {
      reader.releaseLock()
      return JSON.parse(match[1]) as { port: number; token: string; version: string }
    }
  }
  throw new Error(`host did not become ready\n${buf}`)
}

async function drain(stream: ReadableStream<Uint8Array>, ms = 200) {
  const reader = stream.getReader()
  let buf = ""
  const decoder = new TextDecoder()
  const timer = setTimeout(() => reader.cancel().catch(() => {}), ms)
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
    }
  } catch {
    // cancelled
  } finally {
    clearTimeout(timer)
  }
  return buf
}

test("host ws ping and getVersion", async () => {
  const { proc: child, ready } = await spawnHost()
  expect(ready.port).toBeGreaterThan(0)
  expect(ready.token).toMatch(/^[0-9a-f]{64}$/)
  expect(ready.version).toBe(HOST_VERSION)

  const stdout = await drain(child.stdout)
  expect(stdout).toBe("")

  const api = wrap<HostWsAPI>(
    webSocketClientTransport({
      url: `ws://127.0.0.1:${ready.port}?token=${ready.token}`,
    }),
  )
  expect(await api.ping()).toBe("pong")
  expect(await api.getVersion()).toBe(HOST_VERSION)
  dispose(api)
})

test("wrong cwd cannot assemble cordis.yml and exits non-zero", async () => {
  const tmp = await Bun.file(join(hostDir, "src/index.ts")).exists()
  expect(tmp).toBe(true)
  proc = Bun.spawn(["bun", join(hostDir, "src/index.ts")], {
    cwd: import.meta.dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const code = await proc.exited
  const stderr = await new Response(proc.stderr).text()
  expect(code).not.toBe(0)
  expect(stderr).toContain("fatal bootstrap error")
  expect(stderr).toMatch(/config file not found|heartbeat plugin failed/)
  proc = undefined
})

test("SIGTERM exits 0 after ready", async () => {
  proc = Bun.spawn(["bun", "src/index.ts"], {
    cwd: hostDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  await readReady(proc.stderr)
  proc.kill("SIGTERM")
  expect(await proc.exited).toBe(0)
  proc = undefined
})

test("host ws rejects a wrong token", async () => {
  const { ready } = await spawnHost()
  const socket = new WebSocket(`ws://127.0.0.1:${ready.port}?token=wrong`)
  const closed = await new Promise<{ code: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket did not close")), 5000)
    socket.addEventListener("close", (event) => {
      clearTimeout(timer)
      resolve({ code: event.code })
    })
    socket.addEventListener("error", () => {})
  })
  expect(closed.code).toBe(1008)
})
