import { Worker } from '@systemfsoftware/effect-cf'
import { applicationLayer, fetch } from './http'

export default Worker.make(applicationLayer, { fetch })
