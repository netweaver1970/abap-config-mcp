import * as fs from "fs"
import * as path from "path"
import * as os from "os"

export interface ConnectionConfig {
  id: string
  url: string
  username: string
  password: string
  client?: string
  language?: string
  /** Accept self-signed / untrusted TLS certificates (common on SAP dev systems). */
  allowSelfSigned?: boolean
  /** Optional PEM CA certificate (string) to trust for HTTPS connections. */
  ca?: string
  /** Request timeout in milliseconds (default: library default). */
  timeout?: number
}

export interface ServerConfig {
  port?: number
  apiKey?: string
}

export interface Config {
  connections: ConnectionConfig[]
  /** Connection used when a tool call names none (default: the first one). Env ABAP_MCP_DEFAULT_CONNECTION overrides it. */
  defaultConnection?: string
  server?: ServerConfig
}

/** An env value, or undefined when blank or an unfilled `${user_config.x}` placeholder. */
function env(name: string): string | undefined {
  const v = process.env[name]?.trim()
  return v && !v.startsWith("${") ? v : undefined
}

/**
 * A single connection taken from SAP_* environment variables — how the Claude
 * Desktop extension passes the system entered in its install form. Used only
 * when no ABAP_MCP_CONFIG file is given.
 */
export function connectionFromEnv(): ConnectionConfig | null {
  const url = env("SAP_URL")
  if (!url) return null
  const username = env("SAP_USER")
  const password = env("SAP_PASSWORD")
  if (!username || !password) {
    console.error("SAP_URL is set but SAP_USER / SAP_PASSWORD are missing.")
    process.exit(1)
  }
  const timeout = parseInt(env("SAP_TIMEOUT_MS") ?? "", 10)
  return {
    id: env("SAP_ID") ?? "DEV",
    url: url.replace(/\/+$/, ""),
    username,
    password,
    client: env("SAP_CLIENT"),
    language: env("SAP_LANGUAGE") ?? "EN",
    allowSelfSigned: /^(1|true|yes)$/i.test(env("SAP_ALLOW_SELF_SIGNED") ?? ""),
    ...(timeout > 0 ? { timeout } : {}),
  }
}

function resolveConfigPath(): string {
  const explicit = env("ABAP_MCP_CONFIG")
  if (explicit) return explicit.replace(/^~(?=\/)/, os.homedir())

  const candidates = [
    path.join(process.cwd(), "connections.json"),
    path.join(os.homedir(), ".abap-mcp", "connections.json"),
    path.join(os.homedir(), ".config", "abap-mcp", "connections.json"),
  ]

  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }

  return candidates[0]
}

let _config: Config | null = null

export function loadConfig(): Config {
  if (_config) return _config

  if (!env("ABAP_MCP_CONFIG")) {
    const fromEnv = connectionFromEnv()
    if (fromEnv) {
      _config = { connections: [fromEnv] }
      return _config
    }
  }

  const configPath = resolveConfigPath()

  if (!fs.existsSync(configPath)) {
    console.error(`No config file found. Create one at: ${configPath}`)
    console.error(`See connections.example.json for the format.`)
    process.exit(1)
  }

  const raw = fs.readFileSync(configPath, "utf-8")
  _config = JSON.parse(raw) as Config

  if (!_config.connections || _config.connections.length === 0) {
    console.error("No connections defined in config file.")
    process.exit(1)
  }

  return _config
}

export function getServerConfig(): ServerConfig {
  return loadConfig().server ?? {}
}
