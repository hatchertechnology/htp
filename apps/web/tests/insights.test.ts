import { expect, it } from 'vitest'
import { businessDays, businessTotal } from '../shared/utils/insights'
it('keeps absent local metrics distinct from zero and does not combine different actions', () => {
  const days = businessDays({ multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [
    { dailyMetric: 'CALL_CLICKS', timeSeries: { datedValues: [{ date: { year: 2026, month: 10, day: 1 }, value: '0' }, { date: { year: 2026, month: 10, day: 2 } }] } },
    { dailyMetric: 'WEBSITE_CLICKS', timeSeries: { datedValues: [{ date: { year: 2026, month: 10, day: 1 }, value: '5' }] } },
  ] }] })
  expect(businessTotal(days, 'CALL_CLICKS')).toBe(0)
  expect(businessTotal(days, 'WEBSITE_CLICKS')).toBe(5)
  expect(businessTotal(days, 'BUSINESS_DIRECTION_REQUESTS')).toBeNull()
  expect(days['2026-10-02']).toBeUndefined()
})
