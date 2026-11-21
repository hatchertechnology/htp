import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../app/components/WebsiteForms.vue', import.meta.url), 'utf8')
const declaration = source.match(/function csvCell\(value: unknown\) \{[^\n]+/)?.[0]
if (!declaration) throw new Error('Inbox CSV encoder not found')
const csvCell = Function(`${declaration.replace(': unknown', '')}; return csvCell`)() as (value: unknown) => string

describe('inbox CSV export', () => {
  it('neutralizes formulas after whitespace or control characters and escapes quotes', () => {
    for (const value of ['=1', ' =1', '\t=1', '\r+1', '@x', '-1']) expect(csvCell(value)).toBe(`"'${value}"`)
    expect(csvCell('safe "text"')).toBe('"safe ""text"""')
  })
})
