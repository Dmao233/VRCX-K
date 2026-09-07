import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { HOST_VERSION } from "../src/api"

const hostDir = join(import.meta.dir, "..")
const outfile = join(hostDir, "dist/host-compile-smoke")

let proc: ReturnType<typeof Bun.spawn> | undefined

afterEach(() => {
  proc?.kill()
  proc = undefined
})

async function readReady(stderr: ReadableStream<Uint8Array>) {
  const reader = stderr.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const deadline = Date.now() + 15_000
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
  throw new Error(`compiled host did not become ready\n${buf}`)
}

test("compiled host finds cordis.yml via cwd", async () => {
  const compile = Bun.spawn(["bun", "build", "--compile", "src/index.ts", "--outfile", outfile], {
    cwd: hostDir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const compileCode = await compile.exited
  const compileErr = await new Response(compile.stderr).text()
  expect(compileCode, compileErr).toBe(0)
  expect(await Bun.file(outfile).exists()).toBe(true)

  proc = Bun.spawn([outfile], {
    cwd: hostDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const ready = await readReady(proc.stderr)
  expect(ready.port).toBeGreaterThan(0)
  expect(ready.token).toMatch(/^[0-9a-f]{64}$/)
  expect(ready.version).toBe(HOST_VERSION)

  const stdout = await drain(proc.stdout)
  expect(stdout).toBe("")
}, 90_000)

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
  } finally {
    clearTimeout(timer)
  }
  return buf
}
