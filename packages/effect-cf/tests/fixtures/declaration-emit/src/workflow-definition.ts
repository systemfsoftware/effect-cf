import { WorkflowDefinition } from '@systemfsoftware/effect-cf'
import { Schema } from 'effect'

export class Api extends WorkflowDefinition.Tag<Api>()('Api', {
  payload: Schema.String,
  result: Schema.String,
}) {}

export const bindingLayer = Api.layer({ binding: 'API' })
export const created = Api.create('hello')
export const create = Api.create
export const createBatch = Api.createBatch
