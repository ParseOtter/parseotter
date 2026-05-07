import type { AppHttpError } from './http/errors'

export interface AppVariables {
  requestId: string
  requestError: AppHttpError | null
}

export type AppEnv = {
  Bindings: CloudflareBindings
  Variables: AppVariables
}
