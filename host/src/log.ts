// stdout is reserved for kkrpc/stdio. This patch only covers the host entry
// module graph. Include/loader plugins evaluate on a separate graph and must
// write to stderr themselves — console.log there still hits stdout.
console.log = (...args: unknown[]) => {
  console.error("[host]", ...args)
}
console.info = (...args: unknown[]) => {
  console.error("[host]", ...args)
}
console.debug = (...args: unknown[]) => {
  console.error("[host]", ...args)
}

export function log(...args: unknown[]) {
  console.error("[host]", ...args)
}
