import { describe, expect, it } from 'vitest'
import { csvCell } from '../app/utils/forms-csv'

describe('inbox CSV export', () => {
  it('neutralizes formulas after whitespace or control characters and escapes quotes', () => {
    for (const value of ['=1', ' =1', '\t=1', '\r+1', '@x', '-1']) expect(csvCell(value)).toBe(`"'${value}"`)
    expect(csvCell('safe "text"')).toBe('"safe ""text"""')
  })
})
