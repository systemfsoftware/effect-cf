import { Kv } from '@systemfsoftware/effect-cf'
import { Schema } from 'effect'

export class Settings extends Kv.Tag<Settings>()('Settings', {
  key: Schema.String,
  value: Schema.Struct({ name: Schema.String }),
}) {}

export const bindingLayer = Settings.layer({ binding: 'SETTINGS' })
