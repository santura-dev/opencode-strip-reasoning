import type { TuiPlugin, TuiPluginApi, TuiCommand, TuiPluginMeta } from "@opencode-ai/plugin/tui"
import type { PluginOptions } from "@opencode-ai/plugin"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const LOG_PATH = join(homedir(), ".opencode-strip-reasoning.log")

type Stats = {
  calls: number
  callsWithReasoning: number
  totalReasoningCharsStripped: number
  totalEstimatedTokensSaved: number
  peakReasoningChars: number
}

function readAllTimeStats(): Stats | undefined {
  const stats: Stats = {
    calls: 0,
    callsWithReasoning: 0,
    totalReasoningCharsStripped: 0,
    totalEstimatedTokensSaved: 0,
    peakReasoningChars: 0,
  }
  try {
    const logData = readFileSync(LOG_PATH, "utf-8")
    for (const line of logData.split("\n")) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (entry.event !== "messages.transform") continue
        if ((entry.reasoningCharsStripped ?? 0) === 0) continue
        stats.calls++
        stats.callsWithReasoning++
        stats.totalReasoningCharsStripped += entry.reasoningCharsStripped ?? 0
        stats.totalEstimatedTokensSaved += entry.estimatedTokensSaved ?? 0
        const beforeRsn = entry.before?.reasoningChars ?? 0
        if (beforeRsn > stats.peakReasoningChars) stats.peakReasoningChars = beforeRsn
      } catch {
        continue
      }
    }
  } catch {
    return undefined
  }
  if (stats.calls === 0) return undefined
  return stats
}

function statsToast(api: TuiPluginApi) {
  const stats = readAllTimeStats()
  if (!stats) {
    api.ui.toast({
      variant: "info",
      title: "strip-reasoning",
      message: "no stats yet, try again after a few turns with a reasoning model",
    })
    return
  }

  const avg =
    stats.callsWithReasoning > 0
      ? Math.round(stats.totalEstimatedTokensSaved / stats.callsWithReasoning)
      : 0

  api.ui.toast({
    variant: "success",
    title: "strip-reasoning",
    message: [
      `${stats.calls.toLocaleString()} calls processed`,
      `${stats.totalEstimatedTokensSaved.toLocaleString()} tokens saved`,
      `${stats.peakReasoningChars.toLocaleString()} peak reasoning chars`,
      `${avg.toLocaleString()} avg tokens per strip`,
    ].join("\n"),
  })
}

function statsText(stats: Stats): string {
  const avg =
    stats.callsWithReasoning > 0
      ? Math.round(stats.totalEstimatedTokensSaved / stats.callsWithReasoning)
      : 0
  const lines: string[] = []
  lines.push("**strip-reasoning** (all time)")
  lines.push("")
  lines.push("| metric | value |")
  lines.push("|---|---|")
  lines.push(`| LLM calls processed | ${stats.calls.toLocaleString()} |`)
  lines.push(`| Calls with reasoning stripped | ${stats.callsWithReasoning.toLocaleString()} |`)
  lines.push(`| Reasoning chars stripped | ${stats.totalReasoningCharsStripped.toLocaleString()} |`)
  lines.push(`| Est. tokens saved | ${stats.totalEstimatedTokensSaved.toLocaleString()} |`)
  lines.push(`| Peak reasoning in one call | ${stats.peakReasoningChars.toLocaleString()} |`)
  lines.push(`| Avg tokens saved per strip | ${avg.toLocaleString()} |`)
  return lines.join("\n")
}

async function statsToChat(api: TuiPluginApi) {
  const route = api.route.current
  const sessionID = route.name === "session" ? String(route.params?.sessionID ?? "") : ""
  if (!sessionID) {
    api.ui.toast({
      variant: "warning",
      title: "strip-reasoning",
      message: "open a session first, the stats table renders in chat",
    })
    return
  }

  const stats = readAllTimeStats()
  const text = stats
    ? statsText(stats)
    : "No strip-reasoning stats yet. They appear after the model makes at least one LLM call with prior reasoning in history."

  try {
    await api.client.session.prompt({
      sessionID,
      parts: [{ type: "text", text }],
      noReply: true,
    })
  } catch (error) {
    api.ui.toast({
      variant: "error",
      title: "strip-reasoning",
      message: `failed to print stats to chat: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

const tui: TuiPlugin = async (
  _api: TuiPluginApi,
  _options: PluginOptions | undefined,
  _meta: TuiPluginMeta,
) => {
  const api = _api
  if (!api.command) return
  api.command.register(() => {
    const commands: TuiCommand[] = [
      {
        title: "Strip-Reasoning Stats",
        value: "strip-reasoning.stats",
        description: "Toast with reasoning token savings",
        category: "Strip-Reasoning",
        slash: {
          name: "strip-reasoning-stats",
        },
        onSelect: () => {
          statsToast(api)
        },
      },
      {
        title: "Strip-Reasoning Full Stats",
        value: "strip-reasoning.stats.full",
        description: "Print the full stats table in chat",
        category: "Strip-Reasoning",
        slash: {
          name: "strip-reasoning-full",
        },
        onSelect: () => {
          void statsToChat(api)
        },
      },
    ]
    return commands
  })
}

export default { id: "opencode-strip-reasoning", tui }
