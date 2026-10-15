// In stdio mode stdout carries the MCP protocol: one stray console.log corrupts
// the stream. Imported FIRST by stdio.ts so every later log line goes to stderr.
console.log = console.error
console.info = console.error
console.debug = console.error
