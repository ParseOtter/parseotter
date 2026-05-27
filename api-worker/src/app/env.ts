import type { AppHttpError } from './http/errors'
import type { ApiKeyRecord } from './security/api-key'

export interface AppVariables {
  requestId: string
  requestError: AppHttpError | null
  apiKeyRecord: ApiKeyRecord | null
}

export type AppEnv = {
  Bindings: CloudflareBindings
  Variables: AppVariables
}
