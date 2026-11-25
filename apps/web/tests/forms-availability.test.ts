import { expect, it } from 'vitest'
import { formsSurface } from '../shared/utils/forms-availability'

it('reports no Forms surface while every flag is off', () => {
  expect(formsSurface({})).toEqual({ enabled: false })
  expect(formsSurface({ rolloutForms: false, rolloutFormsPilot: false })).toEqual({ enabled: false })
  expect(formsSurface(undefined)).toEqual({ enabled: false })
  expect(formsSurface(null)).toEqual({ enabled: false })
})

it('lets the authenticated pilot win over the legacy flag', () => {
  expect(formsSurface({ rolloutForms: true })).toEqual({ enabled: true, mode: 'legacy' })
  expect(formsSurface({ rolloutFormsPilot: true })).toEqual({ enabled: true, mode: 'pilot' })
  expect(formsSurface({ rolloutForms: true, rolloutFormsPilot: true })).toEqual({ enabled: true, mode: 'pilot' })
})

it('treats non-boolean truthy values as off', () => {
  for (const value of ['true', 1, {}, [], 'yes']) {
    expect(formsSurface({ rolloutForms: value })).toEqual({ enabled: false })
    expect(formsSurface({ rolloutFormsPilot: value })).toEqual({ enabled: false })
  }
})
