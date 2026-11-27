import { Artifacts } from '@systemfsoftware/effect-cf'

export class Repositories extends Artifacts.Tag<Repositories>()('Repositories') {}

export const bindingLayer = Repositories.layer({ binding: 'ARTIFACTS' })
