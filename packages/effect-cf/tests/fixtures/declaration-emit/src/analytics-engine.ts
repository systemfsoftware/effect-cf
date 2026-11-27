import { AnalyticsEngine } from '@systemfsoftware/effect-cf'
import { Redacted } from 'effect'

export class Analytics extends AnalyticsEngine.Tag<Analytics>()('Analytics') {}

export const bindingLayer = Analytics.layer({ binding: 'ANALYTICS' })

export class AnalyticsQuery extends AnalyticsEngine.QueryTag<AnalyticsQuery>()('AnalyticsQuery') {}

export const queryLayer = AnalyticsQuery.layer({
  accountId: 'example-account',
  apiToken: Redacted.make('fixture-not-a-token'),
})
