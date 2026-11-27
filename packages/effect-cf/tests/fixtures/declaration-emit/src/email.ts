import { Email } from '@systemfsoftware/effect-cf'

export class Mail extends Email.Tag<Mail>()('Mail') {}

export const bindingLayer = Mail.layer({ binding: 'EMAIL' })
