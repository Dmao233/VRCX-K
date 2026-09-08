import type { Context } from "cordis"

export function apply(ctx: Context) {
  ctx.provide("heartbeat", { ok: true })
}
