import { describe, it, expect } from "vitest"
import * as fs from "fs"
import * as path from "path"
import { inflateRawSync } from "zlib"
import { buildAbapGitFiles, zipFiles, ROOT_DOT_ABAPGIT } from "../src/abap/abapgitRepo"
import { ENGINE_VERSION } from "../src/abap/zcl_mcp_cust_engine"

const root = path.resolve(__dirname, "..", "abapgit")

describe("the engine's abapGit repository", () => {
  it("abapgit/ is current: run npm run abapgit after changing the ABAP or the engine version", () => {
    const files = buildAbapGitFiles()
    for (const [rel, content] of files) {
      expect(fs.readFileSync(path.join(root, rel), "utf8"), rel).toBe(content)
    }
    const onDisk = fs.readdirSync(path.join(root, "src")).map(f => `src/${f}`)
    expect(onDisk.sort()).toEqual([...files.keys()].filter(k => k.startsWith("src/")).sort())
    expect(fs.readFileSync(path.join(root, "..", ".abapgit.xml"), "utf8")).toBe(ROOT_DOT_ABAPGIT)
    expect(ROOT_DOT_ABAPGIT).toContain("<STARTING_FOLDER>/abapgit/src/</STARTING_FOLDER>")
  })

  it("carries the engine version and the test classes", () => {
    const files = buildAbapGitFiles()
    expect(files.get("src/zcl_mcp_cust_engine.clas.abap")).toContain(`c_version TYPE string VALUE '${ENGINE_VERSION}'`)
    expect(files.get("src/zcl_mcp_cust_engine.clas.abap")).not.toContain("{{")
    expect(files.get("src/zcl_mcp_cust_engine.clas.testclasses.abap")).toContain("FOR TESTING")
    expect(files.get("src/zcl_mcp_cust_engine.clas.xml")).toContain("<WITH_UNIT_TESTS>X</WITH_UNIT_TESTS>")
    for (const [k, v] of files) if (k.endsWith(".xml")) expect(v.startsWith("﻿<?xml"), k).toBe(true)
  })

  it("the zip holds exactly the files, deflated", () => {
    const files = buildAbapGitFiles()
    const zip = zipFiles(files)
    expect(zip.equals(zipFiles(files))).toBe(true)            // same files, same bytes
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    expect(zip.readUInt16LE(end + 10)).toBe(files.size)
    let p = zip.readUInt32LE(end + 16)
    for (let i = 0; i < files.size; i++) {
      const nlen = zip.readUInt16LE(p + 28), off = zip.readUInt32LE(p + 42), csize = zip.readUInt32LE(p + 20)
      const name = zip.subarray(p + 46, p + 46 + nlen).toString("utf8")
      const ds = off + 30 + zip.readUInt16LE(off + 26) + zip.readUInt16LE(off + 28)
      expect(zip.readUInt16LE(p + 10)).toBe(8)
      expect(inflateRawSync(zip.subarray(ds, ds + csize)).toString("utf8")).toBe(files.get(name))
      p += 46 + nlen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32)
    }
  })
})
