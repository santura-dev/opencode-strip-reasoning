import type { TuiPlugin, TuiPluginApi, TuiCommand, TuiPluginMeta } from "@opencode-ai/plugin/tui";
import type { PluginOptions } from "@opencode-ai/plugin";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_PATH = join(homedir(), ".opencode-strip-reasoning.log");

function showStatsDialog(api: TuiPluginApi) {
  let calls = 0;
  let callsWithReasoning = 0;
  let totalReasoningCharsStripped = 0;
  let totalEstimatedTokensSaved = 0;
  let peakReasoningChars = 0;

  try {
    const logData = readFileSync(LOG_PATH, "utf-8");
    for (const line of logData.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.event !== "messages.transform") continue;
        if ((entry.reasoningCharsStripped ?? 0) === 0) continue;
        calls++;
        callsWithReasoning++;
        totalReasoningCharsStripped += entry.reasoningCharsStripped ?? 0;
        totalEstimatedTokensSaved += entry.estimatedTokensSaved ?? 0;
        const beforeRsn = entry.before?.reasoningChars ?? 0;
        if (beforeRsn > peakReasoningChars) peakReasoningChars = beforeRsn;
      } catch { continue; }
    }
  } catch {
    api.ui.dialog.replace(() => api.ui.DialogAlert({
      title: "Strip-Reasoning Stats",
      message: "No stats yet. Stats appear after the model makes at least one LLM call with prior reasoning in history. Try again after a few turns with a reasoning model.",
    }));
    return;
  }

  if (calls === 0) {
    api.ui.dialog.replace(() => api.ui.DialogAlert({
      title: "Strip-Reasoning Stats",
      message: "No strip-reasoning stats yet. Stats appear after the model makes at least one LLM call with prior reasoning in history.",
    }));
    return;
  }

  const avg = callsWithReasoning > 0 ? Math.round(totalEstimatedTokensSaved / callsWithReasoning) : 0;

  const lines = [
    `LLM calls processed: ${calls}`,
    `Calls with reasoning stripped: ${callsWithReasoning}`,
    `Reasoning chars stripped: ${totalReasoningCharsStripped.toLocaleString()}`,
    `Est. tokens saved: ${totalEstimatedTokensSaved.toLocaleString()}`,
    `Peak reasoning in one call: ${peakReasoningChars.toLocaleString()}`,
  ];
  if (callsWithReasoning > 0) {
    lines.push(`Avg tokens saved per strip: ${avg.toLocaleString()}`);
  }

  api.ui.dialog.replace(() => api.ui.DialogAlert({
    title: "Strip-Reasoning Stats",
    message: lines.join("\n"),
  }));
}

const tui: TuiPlugin = async (api: TuiPluginApi, _options: PluginOptions | undefined, _meta: TuiPluginMeta) => {
  api.command?.register(() => {
    const commands: TuiCommand[] = [
      {
        title: "Strip-Reasoning Stats",
        value: "strip-reasoning.stats",
        description: "Show reasoning token savings for the current session",
        category: "Strip-Reasoning",
        slash: {
          name: "strip-reasoning-stats",
        },
        onSelect: () => {
          showStatsDialog(api);
        },
      },
    ];
    return commands;
  });
};

export default { id: "opencode-strip-reasoning", tui };
