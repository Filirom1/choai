import { createSignal } from "solid-js"
import { Err, Ok, type Result } from "~/core/lib/monad"

const SCOPE = "https://www.googleapis.com/auth/drive"
const SCRIPT = "https://accounts.google.com/gsi/client"

interface TokenResponse {
  readonly access_token?: string
  readonly expires_in?: number
  readonly error?: string
}

interface TokenClient {
  requestAccessToken: (options?: { readonly prompt?: string }) => void
}

interface GoogleIdentity {
  readonly accounts?: {
    readonly oauth2?: {
      initTokenClient: (options: {
        readonly client_id: string
        readonly scope: string
        readonly callback: (response: TokenResponse) => void
        readonly error_callback: () => void
      }) => TokenClient
    }
  }
}

declare global {
  interface Window {
    google?: GoogleIdentity
  }
}

const [session, setSession] = createSignal<{ readonly accessToken: string; readonly clientId: string; readonly expiresAt: number } | undefined>()
let loading: Promise<Result<void, AuthFailure>> | undefined

export type AuthFailure = { readonly at: "script" } | { readonly at: "denied" } | { readonly at: "client-id" }

export const loadIdentity = (): Promise<Result<void, AuthFailure>> => {
  if (window.google?.accounts?.oauth2 !== undefined) return Promise.resolve(Ok(undefined))
  if (loading !== undefined) return loading
  loading = new Promise<Result<void, AuthFailure>>((resolve) => {
    Array.from(document.scripts).filter(({ src }) => src === SCRIPT).forEach((script) => script.remove())
    const script = document.createElement("script")
    const finish = (result: Result<void, AuthFailure>): void => {
      window.clearTimeout(timeout)
      resolve(result)
    }
    const timeout = window.setTimeout(() => finish(Err({ at: "script" })), 15_000)
    script.src = SCRIPT
    script.async = true
    script.defer = true
    script.onload = () => finish(window.google?.accounts?.oauth2 === undefined ? Err({ at: "script" }) : Ok(undefined))
    script.onerror = () => finish(Err({ at: "script" }))
    document.head.append(script)
  }).then((result) => {
    loading = undefined
    return result
  })
  return loading!
}

export const accessToken = (clientId: string): Promise<Result<string, AuthFailure>> => {
  const saved = session()
  const id = clientId.trim()
  if (saved !== undefined && saved.clientId === id && saved.expiresAt > Date.now() + 30_000) return Promise.resolve(Ok(saved.accessToken))
  if (id === "") return Promise.resolve(Err({ at: "client-id" }))
  const identity = window.google?.accounts?.oauth2
  if (identity === undefined) return Promise.resolve(Err({ at: "script" }))

  return new Promise((resolve) => {
    const client = identity.initTokenClient({
      client_id: id,
      scope: SCOPE,
      callback: (response) => {
        if (response.access_token === undefined) {
          resolve(Err({ at: "denied" }))
          return
        }
        const value = response.access_token
        setSession({ accessToken: value, clientId: id, expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000 })
        resolve(Ok(value))
      },
      error_callback: () => {
        resolve(Err({ at: "denied" }))
      },
    })
    client.requestAccessToken({ prompt: "" })
  })
}

export const sessionToken = (clientId: string): string | undefined => {
  const saved = session()
  return saved !== undefined && saved.clientId === clientId.trim() && saved.expiresAt > Date.now() + 30_000
    ? saved.accessToken
    : undefined
}

export const forgetSession = (): void => setSession(undefined)
