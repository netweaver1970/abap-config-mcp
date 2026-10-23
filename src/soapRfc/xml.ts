/**
 * The little XML a SOAP RFC exchange needs: escaping values for the request, and
 * a tree reader for the response. SAP's /sap/bc/soap/rfc answers are regular
 * (elements, <item> rows, text; no mixed content), so a full XML library is not
 * needed. Namespace prefixes are dropped from element names; attributes are
 * ignored; text is kept exactly (leading and trailing blanks are data in an
 * RFC_READ_TABLE row).
 */

export interface XmlNode {
  name: string
  children: XmlNode[]
  text: string
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|lt|gt|amp|quot|apos);/gi, (_, e: string) => {
    const k = e.toLowerCase()
    if (k === "lt") return "<"
    if (k === "gt") return ">"
    if (k === "amp") return "&"
    if (k === "quot") return "\""
    if (k === "apos") return "'"
    const code = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : `&${e};`
  })
}

const localName = (qname: string) => qname.slice(qname.indexOf(":") + 1)

/** Parse an XML document into a tree; returns a synthetic root named "#document". */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#document", children: [], text: "" }
  const stack: XmlNode[] = [root]
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const top = stack[stack.length - 1]
    if (m[1] !== undefined) top.text += m[1]
    else if (m[2] !== undefined) {
      const name = localName(m[2])
      if (stack.length === 1 || top.name !== name) throw new Error(`Malformed XML: unexpected </${m[2]}>`)
      stack.pop()
    } else if (m[3] !== undefined) {
      const node: XmlNode = { name: localName(m[3]), children: [], text: "" }
      top.children.push(node)
      if (m[5] !== "/") stack.push(node)
    } else if (m[6] !== undefined) top.text += decodeEntities(m[6])
  }
  if (stack.length !== 1) throw new Error(`Malformed XML: <${stack[stack.length - 1].name}> is not closed`)
  return root
}

export const child = (n: XmlNode | undefined, name: string): XmlNode | undefined => n?.children.find(c => c.name === name)

/** First descendant (depth-first) with this local name. */
export function find(n: XmlNode | undefined, name: string): XmlNode | undefined {
  if (!n) return undefined
  for (const c of n.children) {
    if (c.name === name) return c
    const deep = find(c, name)
    if (deep) return deep
  }
  return undefined
}
