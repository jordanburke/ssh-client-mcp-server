import type { Option } from "functype"
import { type Either, Left, Right } from "functype"
import { Fs, Path } from "functype-os"
import { type ConnectConfig } from "ssh2"

export type ResolveAuthOptions = Readonly<{
  password: Option<string>
  keyPath: Option<string>
  keyEnvVar: Option<string>
  useAgent: boolean
}>

// Auth precedence: password → key file → key from env var → ssh-agent → empty.
export const resolveAuth = async (options: ResolveAuthOptions): Promise<Either<string, Partial<ConnectConfig>>> => {
  if (options.password.isSome()) {
    return Right<string, Partial<ConnectConfig>>({ password: options.password.value })
  }
  if (options.keyPath.isSome()) {
    const expandResult = Path.expand(options.keyPath.value)
    if (expandResult.isLeft()) {
      return Left<string, Partial<ConnectConfig>>(
        `Invalid SSH key path ${options.keyPath.value}: ${expandResult.value.message}`,
      )
    }
    const expanded = expandResult.value
    const result = await Fs.readFile(expanded)
    return result.fold<Either<string, Partial<ConnectConfig>>>(
      (err) => Left<string, Partial<ConnectConfig>>(`Failed to read SSH key ${expanded}: ${err.message}`),
      (contents) => Right<string, Partial<ConnectConfig>>({ privateKey: contents }),
    )
  }
  if (options.keyEnvVar.isSome()) {
    const varName = options.keyEnvVar.value
    const keyValue = process.env[varName]
    if (!keyValue) {
      return Left<string, Partial<ConnectConfig>>(`key-env ${varName} but environment variable is not set or empty`)
    }
    return Right<string, Partial<ConnectConfig>>({ privateKey: keyValue })
  }
  if (options.useAgent) {
    const sock = process.env.SSH_AUTH_SOCK
    if (!sock) {
      return Left<string, Partial<ConnectConfig>>("agent set but SSH_AUTH_SOCK is not set")
    }
    return Right<string, Partial<ConnectConfig>>({ agent: sock })
  }
  return Right<string, Partial<ConnectConfig>>({})
}
