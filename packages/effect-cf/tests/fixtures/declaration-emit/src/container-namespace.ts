import { ContainerNamespace } from '@systemfsoftware/effect-cf'

export class Containers extends ContainerNamespace.Tag<Containers>()('Containers') {}

export const bindingLayer = Containers.layer({ binding: 'CONTAINERS' })
