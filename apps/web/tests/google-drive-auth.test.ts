import { describe, expect, test } from "bun:test"

import { forgetSession, sessionToken } from "../src/core/google-drive/auth"

describe("Google Drive session tokens", () => {
  test("reads an unexpired token from the browser session cache only for its client", () => {
    const items = new Map<string, string>()
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
      removeItem: (key: string) => { items.delete(key) },
    }
    const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage })
    try {
      items.set("choai:gdrive:session", JSON.stringify({
        accessToken: "cached-token",
        clientId: "client",
        expiresAt: Date.now() + 60_000,
      }))
      expect(sessionToken("client")).toBe("cached-token")
      expect(sessionToken("another-client")).toBeUndefined()
      forgetSession()
      items.set("choai:gdrive:session", JSON.stringify({
        accessToken: "expired-token",
        clientId: "client",
        expiresAt: Date.now() - 1,
      }))
      expect(sessionToken("client")).toBeUndefined()
    } finally {
      forgetSession()
      if (previous === undefined) Reflect.deleteProperty(globalThis, "sessionStorage")
      else Object.defineProperty(globalThis, "sessionStorage", previous)
    }
  })
})
