/**
 * The engine as an abapGit repository (spec 001, phase 3).
 *
 * Built from the same ABAP sources the server deploys over ADT, with the version filled in, so
 * the abapGit files can never drift from what engine_deploy installs. `npm run abapgit` writes
 * them to abapgit/ (an abapGit repository with its own .abapgit.xml, to link as an online repo
 * or zip for an offline import); tests check the committed folder is current.
 *
 * The metadata files follow abapGit 1.133's own serializers byte for byte (taken from an export
 * of the deployed engine on S4: BOM, one-space indent, LF), including the SICF file names, whose
 * second part is abapGit's hash of the node's URL.
 *
 * Contents: ZCL_MCP_CUST_ENGINE with its ABAP Unit tests, report ZMCP_CUST_WRITE, SICF node
 * /sap/bc/zmcp_cust, the optional classes ZCL_MCP_SCOPE_BATCH (SAP_BASIS 7.50+; on 7.40 it does
 * not activate and the engine counts one table at a time) and ZCL_MCP_BW_ENGINE (BW objects;
 * activates on any system), and the read-only diagnostics ZCL_MCP_DIAG with /sap/bc/zmcp_diag.
 */
import { getEngineSource, getEngineTestSource, ENGINE_VERSION } from "./zcl_mcp_cust_engine"
import { getWriterSource } from "./zmcp_cust_write"
import { getScopeBatchSource } from "./zcl_mcp_scope_batch"
import { getBwEngineSource } from "./zcl_mcp_bw_engine"
import { getDiagSource } from "./zcl_mcp_diag"
import { deflateRawSync } from "zlib"

const BOM = "﻿"
const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const lf = (s: string) => s.replace(/\r\n/g, "\n").replace(/\n*$/, "\n")

function wrap(serializer: string, values: string): string {
  return `${BOM}<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="${serializer}" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
${values}
  </asx:values>
 </asx:abap>
</abapGit>
`
}

function clasXml(name: string, descript: string, withTests = false): string {
  return wrap("LCL_OBJECT_CLAS", `   <VSEOCLASS>
    <CLSNAME>${name}</CLSNAME>
    <LANGU>E</LANGU>
    <DESCRIPT>${xmlEsc(descript)}</DESCRIPT>
    <STATE>1</STATE>
    <CLSCCINCL>X</CLSCCINCL>
    <FIXPT>X</FIXPT>
    <UNICODE>X</UNICODE>${withTests ? "\n    <WITH_UNIT_TESTS>X</WITH_UNIT_TESTS>" : ""}
   </VSEOCLASS>`)
}

function progXml(name: string, title: string): string {
  return wrap("LCL_OBJECT_PROG", `   <PROGDIR>
    <NAME>${name}</NAME>
    <DBAPL>S</DBAPL>
    <SUBC>1</SUBC>
    <FIXPT>X</FIXPT>
    <LDBNAME>D$S</LDBNAME>
    <UCCHECK>X</UCCHECK>
   </PROGDIR>
   <TPOOL>
    <item>
     <ID>R</ID>
     <ENTRY>${xmlEsc(title)}</ENTRY>
     <LENGTH>${title.length}</LENGTH>
    </item>
   </TPOOL>`)
}

function sicfXml(node: string, docu: string, handler: string): string {
  return wrap("LCL_OBJECT_SICF", `   <URL>/sap/bc/${node}/</URL>
   <ICFSERVICE>
    <ICF_NAME>${node}</ICF_NAME>
    <ORIG_NAME>${node}</ORIG_NAME>
   </ICFSERVICE>
   <ICFDOCU>
    <ICF_NAME>${node}</ICF_NAME>
    <ICF_LANGU>E</ICF_LANGU>
    <ICF_DOCU>${xmlEsc(docu)}</ICF_DOCU>
   </ICFDOCU>
   <ICFHANDLER_TABLE>
    <ICFHANDLER>
     <ICF_NAME>${node}</ICF_NAME>
     <ICFORDER>01</ICFORDER>
     <ICFTYP>A</ICFTYP>
     <ICFHANDLER>${handler}</ICFHANDLER>
    </ICFHANDLER>
   </ICFHANDLER_TABLE>`)
}

/** abapGit's file name of a SICF node: the name padded to 15, then its hash of the node's URL. */
const SICF_FILES: Record<string, string> = {
  ZMCP_CUST: "zmcp_cust      dd2dfdb0307b18c123fe7b4c4.sicf.xml",
  ZMCP_DIAG: "zmcp_diag      ab7cc8abc3283e2318866f423.sicf.xml",
}

export const DOT_ABAPGIT = `${BOM}<?xml version="1.0" encoding="utf-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
 <asx:values>
  <DATA>
   <MASTER_LANGUAGE>E</MASTER_LANGUAGE>
   <STARTING_FOLDER>/src/</STARTING_FOLDER>
   <FOLDER_LOGIC>PREFIX</FOLDER_LOGIC>
  </DATA>
 </asx:values>
</asx:abap>
`

/** .abapgit.xml at the root of this Git repository, so the repository itself can be linked in abapGit as an online repo. */
export const ROOT_DOT_ABAPGIT = DOT_ABAPGIT.replace("<STARTING_FOLDER>/src/</STARTING_FOLDER>", "<STARTING_FOLDER>/abapgit/src/</STARTING_FOLDER>")

/** The repository's files, path → content, paths relative to the repository root. */
export function buildAbapGitFiles(): Map<string, string> {
  const f = new Map<string, string>()
  f.set(".abapgit.xml", DOT_ABAPGIT)
  f.set("src/zcl_mcp_cust_engine.clas.abap", lf(getEngineSource()))
  f.set("src/zcl_mcp_cust_engine.clas.testclasses.abap", lf(getEngineTestSource()))
  f.set("src/zcl_mcp_cust_engine.clas.xml", clasXml("ZCL_MCP_CUST_ENGINE", "MCP Customizing Engine", true))
  f.set("src/zmcp_cust_write.prog.abap", lf(getWriterSource()))
  f.set("src/zmcp_cust_write.prog.xml", progXml("ZMCP_CUST_WRITE", "MCP Customizing Engine — batch write worker"))
  f.set(`src/${SICF_FILES.ZMCP_CUST}`, sicfXml("ZMCP_CUST", "MCP customizing engine", "ZCL_MCP_CUST_ENGINE"))
  f.set("src/zcl_mcp_scope_batch.clas.abap", lf(getScopeBatchSource()))
  f.set("src/zcl_mcp_scope_batch.clas.xml", clasXml("ZCL_MCP_SCOPE_BATCH", "MCP engine: batched row counts (7.50+)"))
  f.set("src/zcl_mcp_bw_engine.clas.abap", lf(getBwEngineSource()))
  f.set("src/zcl_mcp_bw_engine.clas.xml", clasXml("ZCL_MCP_BW_ENGINE", "MCP engine: BW objects"))
  f.set("src/zcl_mcp_diag.clas.abap", lf(getDiagSource()))
  f.set("src/zcl_mcp_diag.clas.xml", clasXml("ZCL_MCP_DIAG", "MCP read-only diagnostics"))
  f.set(`src/${SICF_FILES.ZMCP_DIAG}`, sicfXml("ZMCP_DIAG", "MCP read-only diagnostics", "ZCL_MCP_DIAG"))
  return f
}

export const ABAPGIT_ENGINE_VERSION = ENGINE_VERSION

// ─── a zip abapGit's offline import reads (deflated, like abapGit's own) ─────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
function crc32(b: Buffer): number { let c = 0xffffffff; for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

/** A zip of the files (deflated), with a fixed date so the same files give the same bytes. */
export function zipFiles(files: Map<string, string>): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0
  const dosTime = 0, dosDate = (2026 - 1980) << 9 | 1 << 5 | 1
  for (const [path, content] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const name = Buffer.from(path, "utf8"); const raw = Buffer.from(content, "utf8"); const crc = crc32(raw)
    const data = deflateRawSync(raw, { level: 9 })
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8)
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28)
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10)
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24)
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42)
    locals.push(lh, name, data); centrals.push(ch, name); offset += 30 + name.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}
