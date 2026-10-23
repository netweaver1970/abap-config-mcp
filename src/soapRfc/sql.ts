/**
 * SQL for RFC_READ_TABLE: it takes a table name, a field list and a WHERE clause
 * as lines of at most 72 characters (OPTIONS) — not a statement. So a WHERE
 * clause is cut into such lines at blanks outside literals, and execute_data_query
 * accepts the single-table SELECT that maps onto those three inputs, refusing
 * anything RFC_READ_TABLE cannot do (joins, sorting, grouping, aggregates).
 */

export const OPTIONS_LINE_MAX = 72

/** The statement with every literal's content replaced by "x" (same length), so keywords can be searched for safely. */
export function maskLiterals(sql: string): string {
  let out = "", quote: string | null = null
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (quote) {
      if (ch === quote) {
        if (sql[i + 1] === quote) { out += "xx"; i++; continue }   // '' / `` escapes the quote
        quote = null
        out += ch
      } else out += "x"
    } else {
      if (ch === "'" || ch === "`") quote = ch
      out += ch
    }
  }
  if (quote) throw new Error("The SQL has an unclosed string literal.")
  return out
}

/**
 * Cut a WHERE clause into OPTIONS lines (≤72 chars), at blanks outside literals.
 * Continuation lines start with a blank. A subquery is refused: RFC_READ_TABLE
 * checks the authorization for its own table only, so a subquery could read a
 * table the user may not display.
 */
export function whereToOptions(where: string): string[] {
  const masked = maskLiterals(where)
  if (/\bSELECT\b/i.test(masked)) throw new Error("A subquery cannot be used on a SOAP RFC connection: RFC_READ_TABLE takes a WHERE clause on its one table only.")
  const words: string[] = []
  let start = -1
  for (let i = 0; i <= where.length; i++) {
    const blank = i === where.length || /\s/.test(masked[i])
    if (blank) { if (start >= 0) words.push(where.slice(start, i)); start = -1 } else if (start < 0) start = i
  }
  const lines: string[] = []
  let row = ""
  for (const w of words) {
    if (w.length > OPTIONS_LINE_MAX - 1) {
      throw new Error(`"${w.slice(0, 40)}…" is longer than ${OPTIONS_LINE_MAX - 1} characters: RFC_READ_TABLE takes the WHERE clause in ${OPTIONS_LINE_MAX}-character lines and cannot split one token or literal.`)
    }
    const next = row ? `${row} ${w}` : (lines.length ? ` ${w}` : w)
    if (next.length > OPTIONS_LINE_MAX) { lines.push(row); row = ` ${w}` } else row = next
  }
  if (row) lines.push(row)
  return lines
}

export interface SimpleSelect {
  table: string
  /** "*" or field names, upper case */
  fields: "*" | string[]
  where?: string
  maxRows?: number
}

const REFUSED: Array<[RegExp, string]> = [
  [/\bJOIN\b/i, "joins"],
  [/\bUNION\b/i, "UNION"],
  [/\bORDER\s+BY\b/i, "ORDER BY"],
  [/\bGROUP\s+BY\b/i, "GROUP BY"],
  [/\bHAVING\b/i, "HAVING"],
  [/\bDISTINCT\b/i, "DISTINCT"],
  [/\bINTO\b/i, "INTO"],
  [/\bFOR\s+ALL\s+ENTRIES\b/i, "FOR ALL ENTRIES"],
  [/\bOFFSET\b/i, "OFFSET"],
  [/\bFIELDS\b/i, "the FIELDS clause"],
  [/\b(COUNT|SUM|MIN|MAX|AVG|CAST|COALESCE|CONCAT|SUBSTRING|UPPER|LOWER)\s*\(/i, "functions and aggregates"],
  [/@/, "host variables"],
]

/**
 * Parse the single-table SELECT a SOAP RFC connection can run:
 *   SELECT [SINGLE] * | f1[,] f2 … FROM table [AS a] [UP TO n ROWS] [WHERE cond] [UP TO n ROWS]
 * Field names may carry an alias prefix (a~f). Anything else is refused with the reason.
 */
export function parseSimpleSelect(sql: string): SimpleSelect {
  let src = sql.trim().replace(/[.;]\s*$/, "")
  let masked = maskLiterals(src)
  const notHere = (what: string) => new Error(
    `${what} cannot run on a SOAP RFC connection: RFC_READ_TABLE reads one table with a field list and a WHERE clause. ` +
    `Use SELECT <fields|*> FROM <table> [WHERE …] [UP TO n ROWS].`)

  if ((masked.match(/\bSELECT\b/gi) ?? []).length > 1) throw notHere("A subquery")
  for (const [re, what] of REFUSED) if (re.test(masked)) throw notHere(what)

  let maxRows: number | undefined
  const upTo = /\bUP\s+TO\s+(\d+)\s+ROWS\b/i.exec(masked)
  if (upTo) {
    maxRows = parseInt(upTo[1], 10)
    src = src.slice(0, upTo.index) + " " + src.slice(upTo.index + upTo[0].length)
    masked = masked.slice(0, upTo.index) + " " + masked.slice(upTo.index + upTo[0].length)
  }

  const head = /^SELECT\s+(SINGLE\s+)?([\s\S]*?)\s+FROM\s+([A-Z0-9_/]+)(?:\s+AS\s+([A-Z0-9_]+))?(?=\s|$)/i.exec(masked)
  if (!head) throw notHere("This statement")
  if (head[1]) maxRows = 1
  const rest = masked.slice(head[0].length)
  let where: string | undefined
  if (rest.trim()) {
    const w = /^\s*WHERE\s+/i.exec(rest)
    if (!w) throw notHere(`"${src.slice(head[0].length).trim().slice(0, 30)}"`)
    const at = head[0].length + w[0].length
    where = src.slice(at)
    // An alias prefix (a~f) on a single table is the table's own field; dropped outside literals only.
    if (head[4]) {
      const wm = masked.slice(at), re = new RegExp(`\\b${head[4]}~`, "gi")
      let out = "", last = 0, m: RegExpExecArray | null
      while ((m = re.exec(wm)) !== null) { out += where.slice(last, m.index); last = m.index + m[0].length }
      where = out + where.slice(last)
    }
    where = where.trim()
    if (!where) throw notHere("An empty WHERE clause")
  }

  const list = head[2].trim()
  let fields: "*" | string[]
  if (list === "*") fields = "*"
  else {
    fields = list.split(/[\s,]+/).filter(Boolean).map(f => f.replace(/^[A-Z0-9_]+~/i, "").toUpperCase())
    const bad = fields.find(f => !/^[A-Z0-9_/]+$/.test(f))
    if (bad) throw notHere(`The field expression "${bad}"`)
  }
  return { table: head[3].toUpperCase(), fields, where, maxRows }
}
