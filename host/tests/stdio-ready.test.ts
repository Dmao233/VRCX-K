import { afterEach, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { RPCChannel } from "kkrpc"
import { stdioJsonTransport } from "kkrpc/stdio"
import type { HostStdioAPI, ShellStdioAPI } from "../src/stdio"
import type { HostWsReady } from "../src/ws"

const hostDir = join(import.meta.dir, "..")

let child: ReturnType<typeof spawn> | undefined

afterEach(() => {
  child?.kill()
  child = undefined
})

test("host stdio ready then ping and stop", async () => {
  child = spawn("bun", ["src/index.ts"], {
    cwd: hostDir,
    env: { ...process.env, VRCXK_SHELL: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  })

  let resolveReady: (info: HostWsReady) => void
  const ready = new Promise<HostWsReady>((resolve, reject) => {
    resolveReady = resolve
    setTimeout(() => reject(new Error("shell ready was not called")), 10_000)
  })

  const transport = stdioJsonTransport({
    readable: child.stdout!,
    writable: child.stdin!,
    lifecycle: child.stdout!,
  })
  const channel = new RPCChannel<ShellStdioAPI, HostStdioAPI>(transport, {
    expose: {
      async ready(info) {
        resolveReady(info)
      },
    },
  })
  const host = channel.getAPI()

  const info = await ready
  expect(info.port).toBeGreaterThan(0)
  expect(info.token).toMatch(/^[0-9a-f]{64}$/)
  expect(await host.ping()).toBe("pong")
  expect(await host.stop()).toBe(true)

  const code = await new Promise<number | null>((resolve) => {
    child!.once("exit", (exitCode) => resolve(exitCode))
  })
  expect(code).toBe(0)
  channel.destroy()
})
