import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { NodeStructure } from "abap-adt-api"
import { ensureConnected } from "../connections"
import { resolveWorkbenchTransport } from "./write"

function formatNodeStructure(pkg: string, structure: NodeStructure): string {
  const { nodes } = structure
  if (nodes.length === 0) return `Package ${pkg} is empty.`

  // Group by object type for readability
  const byType = new Map<string, typeof nodes>()
  for (const n of nodes) {
    const label = n.OBJECT_TYPE
    if (!byType.has(label)) byType.set(label, [])
    byType.get(label)!.push(n)
  }

  const sections: string[] = []
  for (const [type, items] of byType) {
    const rows = items.map(n => {
      const desc = n.DESCRIPTION ? `  — ${n.DESCRIPTION}` : ""
      const sub = n.EXPANDABLE === "X" ? " ▶" : ""
      return `    ${n.OBJECT_NAME.padEnd(40)}${sub}${desc}`
    })
    sections.push(`  ${type} (${items.length}):\n${rows.join("\n")}`)
  }

  return `Package ${pkg} — ${nodes.length} object(s):\n\n${sections.join("\n\n")}`
}

export async function handleBrowsePackage(args: {
  packageName: string
  includeSubPackages?: boolean
  connectionId?: string
}) {
  const client = await ensureConnected(args.connectionId)
  const structure = await client.nodeContents("DEVC/K", args.packageName)
  const text = formatNodeStructure(args.packageName, structure)

  if (!args.includeSubPackages) {
    return { content: [{ type: "text" as const, text }] }
  }

  // Find sub-packages (type DEVC/K that are expandable) and fetch each
  const subPkgs = structure.nodes.filter(n => n.OBJECT_TYPE === "DEVC/K")
  if (subPkgs.length === 0) {
    return { content: [{ type: "text" as const, text }] }
  }

  const subResults = await Promise.allSettled(
    subPkgs.map(async sub => {
      const s = await client.nodeContents("DEVC/K", sub.OBJECT_NAME)
      return formatNodeStructure(sub.OBJECT_NAME, s)
    })
  )

  const subTexts = subResults
    .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
    .map(r => r.value)

  return {
    content: [{
      type: "text" as const,
      text: [text, ...subTexts].join("\n\n" + "─".repeat(60) + "\n\n")
    }]
  }
}

export async function handleCreatePackage(args: {
  name: string
  description: string
  parentPackage: string
  packageType?: "development" | "structure" | "main"
  swComponent?: string
  transportLayer?: string
  transport?: string
  createTransport?: boolean
  workItem?: string
  connectionId?: string
}, extra?: { sessionId?: string }) {
  const client = await ensureConnected(args.connectionId)
  const parentPath = `/sap/bc/adt/packages/${args.parentPackage}`

  const t = await resolveWorkbenchTransport(
    client, `/sap/bc/adt/packages/${encodeURIComponent(args.name.toLowerCase())}`, args.name, "I", args, extra?.sessionId,
    `creating package ${args.name}`, `MCP create package ${args.name}`)
  if (t.prompt) return { content: [{ type: "text" as const, text: t.prompt }] }

  await client.createObject({
    objtype: "DEVC/K",
    name: args.name,
    parentName: args.parentPackage,
    description: args.description,
    parentPath,
    transport: t.transport,
    // Package-specific fields
    swcomp: args.swComponent ?? "",
    transportLayer: args.transportLayer ?? "",
    packagetype: args.packageType ?? "development",
  } as any)

  return {
    content: [{
      type: "text" as const,
      text: `✅ Package ${args.name} created.\n` +
        `Description:  ${args.description}\n` +
        `Parent:       ${args.parentPackage}\n` +
        `Type:         ${args.packageType ?? "development"}\n` +
        (args.swComponent ? `SW component: ${args.swComponent}\n` : "") +
        (args.transportLayer ? `Transp. layer:${args.transportLayer}\n` : "") +
        (t.transport ? `Transport:    ${t.transport}\n` : "") +
        (t.note ? `${t.note}\n` : "") +
        `\nUse create_abap_object with packageName "${args.name}" to add objects to it.`
    }]
  }
}

export function registerPackageTools(server: McpServer): void {
  server.registerTool(
    "browse_package",
    {
      title: "Browse Package",
      description:
        "List all development objects inside an ABAP package (development class). " +
        "Results are grouped by object type. Sub-packages are marked with ▶ and can be expanded " +
        "by setting includeSubPackages to true.",
      inputSchema: {
        packageName: z.string().describe("Package name to browse (e.g. ZCAR_MM, $TMP)"),
        includeSubPackages: z.boolean().optional()
          .describe("Also fetch and display the contents of any sub-packages found. Default: false"),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleBrowsePackage
  )

  server.registerTool(
    "create_package",
    {
      title: "Create Package",
      description:
        "Create a new ABAP development package (development class / DEVC). " +
        "Packages are the containers that group related development objects and control transport behaviour.",
      inputSchema: {
        name: z.string().describe("Package name (e.g. ZCAR_MM_REPORTS)"),
        description: z.string().describe("Short description of the package"),
        parentPackage: z.string().describe("Parent package this package lives under (e.g. ZCAR_MM)"),
        packageType: z.enum(["development", "structure", "main"]).optional()
          .describe("Package type: development (default, contains objects), structure (grouping only), main (top-level)"),
        swComponent: z.string().optional()
          .describe("Software component (e.g. HOME, LOCAL, or a custom component). Leave empty for local packages."),
        transportLayer: z.string().optional()
          .describe("Transport layer (e.g. Z, SAP). Controls which transport route is used."),
        transport: z.string().optional()
          .describe("Workbench request to record into. Checked before use; becomes the transport for this piece of work."),
        workItem: z.string().optional().describe("Name of the piece of work (e.g. HPM, a ticket). Keeps using the same transport for it across calls and sessions until you pass another."),
        createTransport: z.boolean().optional().describe("Create a NEW Workbench request (only when you mean it; existing requests are preferred)."),
        connectionId: z.string().optional().describe("SAP system connection ID")
      }
    },
    handleCreatePackage
  )
}
