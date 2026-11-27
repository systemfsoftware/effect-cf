import { D1 } from '@systemfsoftware/effect-cf'

export class Database extends D1.Service<Database>()('Database', { binding: 'DB' }) {}

export const database = D1.make('DatabaseValue', { binding: 'DB' })
export const bindingLayer = Database.layer
export const sqlLayer = Database.sqlLayer()
