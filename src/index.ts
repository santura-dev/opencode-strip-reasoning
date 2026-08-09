import type { Plugin, Hooks, PluginOptions } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Mode = "strip" | "summarize" | "keep-last";

const LOG_PATH = join(homedir(), ".opencode-strip-reasoning.log");

const sessionStats = new Map<string, {
  calls: number;
  callsWithReasoning: number;
  totalReasoningCharsStripped: number;
  totalEstimatedTokensSaved: number;
  peakReasoningChars: number;
  byCall: {
    reasoningCharsBefore: number;
    reasoningCharsAfter: number;
    tokensSaved: number;
    textChars: number;
  }[];
}>();

function log(entry: Record<string, unknown>) {
  const line = JSON.stringify({ ts: Date.now(), ...entry }) + "\n";
  try {
    appendFileSync(LOG_PATH, line);
  } catch {}
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3.5);
}

function getOrCreateStats(sessionID: string) {
  if (!sessionStats.has(sessionID)) {
    sessionStats.set(sessionID, {
      calls: 0,
      callsWithReasoning: 0,
      totalReasoningCharsStripped: 0,
      totalEstimatedTokensSaved: 0,
      peakReasoningChars: 0,
      byCall: [],
    });
  }
  return sessionStats.get(sessionID)!;
}

function formatStatsReport(sessionID: string): string {
  const stats = sessionStats.get(sessionID);

  let calls = stats?.calls ?? 0;
  let callsWithReasoning = stats?.callsWithReasoning ?? 0;
  let totalReasoningCharsStripped = stats?.totalReasoningCharsStripped ?? 0;
  let totalEstimatedTokensSaved = stats?.totalEstimatedTokensSaved ?? 0;
  let peakReasoningChars = stats?.peakReasoningChars ?? 0;

  if (calls === 0) {
    try {
      const logData = readFileSync(LOG_PATH, "utf-8");
      for (const line of logData.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.event !== "messages.transform") continue;
          if (((entry.reasoningCharsStripped as number) ?? 0) === 0) continue;
          calls++;
          callsWithReasoning++;
          totalReasoningCharsStripped += (entry.reasoningCharsStripped as number) ?? 0;
          totalEstimatedTokensSaved += (entry.estimatedTokensSaved as number) ?? 0;
          const beforeRsn = (entry.before as Record<string, number>)?.reasoningChars ?? 0;
          if (beforeRsn > peakReasoningChars) peakReasoningChars = beforeRsn;
        } catch { continue; }
      }
    } catch { return "No strip-reasoning stats yet. The plugin will track stats after the model makes LLM calls with prior reasoning in history. Try again after a few turns with a reasoning model (GLM-5, DeepSeek-R1, Macaron)."; }
  }

  if (calls === 0) {
    return "No strip-reasoning stats yet. Stats appear after the model makes at least one LLM call with prior reasoning in history.";
  }

  const lines: string[] = [];
  lines.push("┌──────────────────────────────────────────────────────────┐");
  lines.push("│       STRIP-REASONING STATS — THIS SESSION              │");
  lines.push("├──────────────────────────────────────────────────────────┤");
  lines.push(`│  LLM calls processed:            ${calls.toString().padStart(8)}              │`);
  lines.push(`│  Calls with reasoning stripped:   ${callsWithReasoning.toString().padStart(8)}              │`);
  lines.push(`│  Reasoning chars stripped:     ${totalReasoningCharsStripped.toLocaleString().padStart(9)}             │`);
  lines.push(`│  Est. tokens saved:            ${totalEstimatedTokensSaved.toLocaleString().padStart(9)}             │`);
  lines.push(`│  Peak reasoning in one call:   ${peakReasoningChars.toLocaleString().padStart(9)}             │`);

  if (callsWithReasoning > 0) {
    const avg = Math.round(totalEstimatedTokensSaved / callsWithReasoning);
    lines.push(`│  Avg tokens saved per strip:   ${avg.toLocaleString().padStart(9)}             │`);
  }

  if (stats && stats.byCall.length > 0) {
    lines.push("├──────────────────────────────────────────────────────────┤");
    lines.push("│  RECENT CALLS                                           │");
    const recent = stats.byCall.slice(-5);
    for (const call of recent) {
      if (call.reasoningCharsBefore > 0) {
        const pct = (call.textChars + call.reasoningCharsBefore) > 0
          ? ((call.reasoningCharsBefore - call.reasoningCharsAfter) / (call.reasoningCharsBefore + call.textChars) * 100).toFixed(0)
          : "100";
        lines.push(`│   ${call.tokensSaved.toLocaleString().padStart(5)} tokens saved (${pct}% of context)              │`);
      } else {
        lines.push(`│       0 tokens saved (no reasoning)                     │`);
      }
    }
  }

  lines.push("└──────────────────────────────────────────────────────────┘");

  return lines.join("\n");
}

const plugin: Plugin = async (_input, options) => {
  const mode: Mode = (options?.mode as Mode) ?? "strip";
  const keepCount: number = (options?.keepCount as number) ?? 0;

  const hooks: Hooks = {
    "experimental.chat.messages.transform": async (_input, output) => {
      const sessionID = output.messages[0]?.parts[0]?.sessionID ?? "unknown";
      const stats = getOrCreateStats(sessionID);

      const before = {
        messages: output.messages.length,
        totalParts: 0,
        reasoningParts: 0,
        reasoningChars: 0,
        textParts: 0,
        textChars: 0,
        toolParts: 0,
      };

      for (const msg of output.messages) {
        for (const part of msg.parts) {
          before.totalParts++;
          if (part.type === "reasoning") {
            before.reasoningParts++;
            before.reasoningChars += (part as { text: string }).text?.length ?? 0;
          } else if (part.type === "text") {
            before.textParts++;
            before.textChars += (part as { text: string }).text?.length ?? 0;
          } else if (part.type === "tool") {
            before.toolParts++;
          }
        }
      }

      if (mode === "strip") {
        for (const msg of output.messages) {
          const kept = msg.parts.filter((part) => part.type !== "reasoning");
          msg.parts.splice(0, msg.parts.length, ...kept);
        }
      } else if (mode === "summarize") {
        for (const msg of output.messages) {
          for (let i = 0; i < msg.parts.length; i++) {
            const part = msg.parts[i]!;
            if (part.type === "reasoning") {
              (part as { type: "reasoning"; text: string }).text =
                "[reasoning omitted]";
            }
          }
        }
      } else if (mode === "keep-last") {
        let totalReasoning = 0;
        for (const msg of output.messages) {
          for (const part of msg.parts) {
            if (part.type === "reasoning") totalReasoning++;
          }
        }

        let reasoningSeen = 0;
        for (const msg of output.messages) {
          const kept = msg.parts.filter((part) => {
            if (part.type !== "reasoning") return true;
            reasoningSeen++;
            return reasoningSeen > totalReasoning - keepCount;
          });
          msg.parts.splice(0, msg.parts.length, ...kept);
        }
      }

      const nonEmpty = output.messages.filter(
        (msg) => msg.parts.length > 0,
      );
      output.messages.splice(0, output.messages.length, ...nonEmpty);

      const after = {
        messages: output.messages.length,
        reasoningParts: 0,
        reasoningChars: 0,
        textParts: 0,
        textChars: 0,
      };

      for (const msg of output.messages) {
        for (const part of msg.parts) {
          if (part.type === "reasoning") {
            after.reasoningParts++;
            after.reasoningChars += (part as { text: string }).text?.length ?? 0;
          } else if (part.type === "text") {
            after.textParts++;
            after.textChars += (part as { text: string }).text?.length ?? 0;
          }
        }
      }

      const savedChars = before.reasoningChars - after.reasoningChars;
      const estimatedTokensSaved = estimateTokens(savedChars);

      stats.calls++;
      if (savedChars > 0) {
        stats.callsWithReasoning++;
        stats.totalReasoningCharsStripped += savedChars;
        stats.totalEstimatedTokensSaved += estimatedTokensSaved;
      }
      if (before.reasoningChars > stats.peakReasoningChars) {
        stats.peakReasoningChars = before.reasoningChars;
      }
      stats.byCall.push({
        reasoningCharsBefore: before.reasoningChars,
        reasoningCharsAfter: after.reasoningChars,
        tokensSaved: estimatedTokensSaved,
        textChars: before.textChars,
      });

      log({
        event: "messages.transform",
        mode,
        before,
        after,
        reasoningCharsStripped: savedChars,
        estimatedTokensSaved,
        estimatedTokensSavedPercent: before.reasoningChars > 0
          ? ((savedChars / (before.reasoningChars + before.textChars + before.toolParts * 100)) * 100).toFixed(1) + "%"
          : "0%",
      });
    },

    "command.execute.before": async (input, output) => {
      if (input.command !== "strip-reasoning-stats") return;
      const stats = sessionStats.get(input.sessionID);
      const report = formatStatsReport(input.sessionID);
      output.parts.push({
        type: "text" as const,
        id: `strip-stats-${Date.now()}`,
        sessionID: input.sessionID,
        messageID: "",
        text: report,
      });
    },

    tool: {
      strip_reasoning_stats: tool({
        description: "Show reasoning token savings for the current session. Displays how many reasoning tokens were stripped from conversation history by the strip-reasoning plugin.",
        args: {},
        async execute(_args, ctx) {
          ctx.metadata({ title: "Strip-Reasoning Stats" });
          return formatStatsReport(ctx.sessionID);
        },
      }),
    },
  };

  return hooks;
};

export default { id: "opencode-strip-reasoning", server: plugin };
