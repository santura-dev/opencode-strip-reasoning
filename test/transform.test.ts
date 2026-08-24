import { describe, it, expect } from "vitest"
import type { Hooks } from "@opencode-ai/plugin"

type Part = { type: string; text?: string; sessionID?: string }

function makeMessages(): { info: unknown; parts: Part[] }[] {
  return [
    { info: {}, parts: [{ type: "text", text: "hello" }] },
    {
      info: {},
      parts: [
        { type: "reasoning", text: " ".repeat(1000) },
        { type: "text", text: "answer one" },
      ],
    },
    { info: {}, parts: [{ type: "tool" }] },
    {
      info: {},
      parts: [
        { type: "reasoning", text: " ".repeat(500) },
        { type: "text", text: "answer two" },
      ],
    },
  ]
}

async function runHook(hooks: Hooks) {
  const messages = makeMessages()
  const output = { messages }
  await hooks["experimental.chat.messages.transform"]!({} as never, output as never)
  return messages
}

async function loadPlugin(mode: string, keepCount = 0): Promise<Hooks> {
  const mod = await import("../src/index.js")
  const plugin = (mod.default as { server: unknown }).server as (
    input: unknown,
    options: unknown,
  ) => Promise<Hooks>
  return plugin({}, { mode, keepCount, log: false })
}

describe("strip mode", () => {
  it("removes all reasoning parts", async () => {
    const hooks = await loadPlugin("strip")
    const messages = await runHook(hooks)
    for (const msg of messages) {
      for (const part of msg.parts) {
        expect(part.type).not.toBe("reasoning")
      }
    }
  })

  it("keeps text and tool parts", async () => {
    const hooks = await loadPlugin("strip")
    const messages = await runHook(hooks)
    const types = messages.flatMap((m) => m.parts.map((p) => p.type))
    expect(types.length).toBe(4)
    expect(types.filter((t) => t === "text").length).toBe(3)
    expect(types.filter((t) => t === "tool").length).toBe(1)
  })

  it("drops messages left empty by stripping", async () => {
    const hooks = await loadPlugin("strip")
    const output = { messages: [{ info: {}, parts: [{ type: "reasoning", text: "x" }] }] }
    await hooks["experimental.chat.messages.transform"]!({} as never, output as never)
    expect(output.messages.length).toBe(0)
  })
})

describe("summarize mode", () => {
  it("replaces reasoning text but keeps the parts", async () => {
    const hooks = await loadPlugin("summarize")
    const messages = await runHook(hooks)
    const reasoning = messages.flatMap((m) => m.parts).filter((p) => p.type === "reasoning")
    expect(reasoning.length).toBe(2)
    for (const part of reasoning) {
      expect((part as { text?: string }).text).toBe("[reasoning omitted]")
    }
  })
})

describe("keep-last mode", () => {
  it("keeps the N most recent reasoning parts", async () => {
    const hooks = await loadPlugin("keep-last", 1)
    const messages = await runHook(hooks)
    const reasoning = messages.flatMap((m) => m.parts).filter((p) => p.type === "reasoning")
    expect(reasoning.length).toBe(1)
  })

  it("keepCount 0 behaves like strip", async () => {
    const hooks = await loadPlugin("keep-last", 0)
    const messages = await runHook(hooks)
    const reasoning = messages.flatMap((m) => m.parts).filter((p) => p.type === "reasoning")
    expect(reasoning.length).toBe(0)
  })

  it("keepCount larger than total keeps everything", async () => {
    const hooks = await loadPlugin("keep-last", 10)
    const messages = await runHook(hooks)
    const reasoning = messages.flatMap((m) => m.parts).filter((p) => p.type === "reasoning")
    expect(reasoning.length).toBe(2)
  })
})

describe("option validation", () => {
  it("invalid mode falls back to strip", async () => {
    const hooks = await loadPlugin("typo-mode")
    const messages = await runHook(hooks)
    const reasoning = messages.flatMap((m) => m.parts).filter((p) => p.type === "reasoning")
    expect(reasoning.length).toBe(0)
  })
})
