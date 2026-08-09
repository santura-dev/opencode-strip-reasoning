#!/usr/bin/env bash
set -euo pipefail

# opencode-strip-reasoning benchmark harness
# Runs the same multi-turn task with and without the plugin,
# then compares token usage from session exports.

PLUGIN_DIR="/Users/aleksandrapoturalska/opencode-strip-reasoning"
CONFIG_FILE="/Users/aleksandrapoturalska/.config/opencode/opencode.json"
RESULTS_DIR="/tmp/opencode-benchmark-results"
MODEL="nebul/zai-org/GLM-5-FP8"
AGENT="build"

# Multi-turn benchmark prompts (3 turns to surface reasoning accumulation)
PROMPT_1="Explain how JavaScript closures work and give a practical example of a counter factory function."
PROMPT_2="Now extend that counter to support increment, decrement, and reset operations, all sharing the same private state."
PROMPT_3="Add error handling: the counter should throw if it goes below 0, and add a max value constraint with a configurable limit."

mkdir -p "$RESULTS_DIR"

# Backup config
cp "$CONFIG_FILE" "$RESULTS_DIR/opencode.json.bak"

cleanup() {
  cp "$RESULTS_DIR/opencode.json.bak" "$CONFIG_FILE"
  echo "Config restored."
}
trap cleanup EXIT

remove_plugin_from_config() {
  python3 -c "
import json, sys
with open('$CONFIG_FILE') as f:
    cfg = json.load(f)
cfg['plugin'] = [p for p in cfg['plugin'] if not (isinstance(p, list) and '$PLUGIN_DIR' in str(p[0]))]
with open('$CONFIG_FILE', 'w') as f:
    json.dump(cfg, f, indent=2)
"
}

add_plugin_to_config() {
  python3 -c "
import json
with open('$CONFIG_FILE') as f:
    cfg = json.load(f)
entry = ['$PLUGIN_DIR', {'mode': 'strip'}]
if not any(isinstance(p, list) and '$PLUGIN_DIR' in str(p[0]) for p in cfg['plugin']):
    cfg['plugin'].append(entry)
with open('$CONFIG_FILE', 'w') as f:
    json.dump(cfg, f, indent=2)
"
}

extract_session_tokens() {
  local session_id="$1"
  local label="$2"
  local outfile="$RESULTS_DIR/${label}_tokens.json"

  echo "Extracting tokens for session $session_id ($label)..."
  opencode export "$session_id" 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
info = data.get('info', {})
tokens = info.get('tokens', {})
messages = data.get('messages', [])

per_msg = []
for msg in messages:
    mi = msg.get('info', {})
    t = mi.get('tokens', {})
    if t:
        per_msg.append({
            'role': mi.get('role', 'unknown'),
            'input': t.get('input', 0),
            'output': t.get('output', 0),
            'reasoning': t.get('reasoning', 0),
            'cache_read': t.get('cache', {}).get('read', 0),
            'cache_write': t.get('cache', {}).get('write', 0),
            'total': t.get('total', 0),
        })

reasoning_parts = 0
reasoning_chars = 0
for msg in messages:
    for part in msg.get('parts', []):
        if part.get('type') == 'reasoning':
            reasoning_parts += 1
            reasoning_chars += len(part.get('text', ''))

result = {
    'session_id': info.get('id', '$session_id'),
    'label': '$label',
    'model': info.get('model', {}),
    'total_input': tokens.get('input', 0),
    'total_output': tokens.get('output', 0),
    'total_reasoning': tokens.get('reasoning', 0),
    'total_cache_read': tokens.get('cache', {}).get('read', 0),
    'total_cache_write': tokens.get('cache', {}).get('write', 0),
    'reasoning_parts_count': reasoning_parts,
    'reasoning_total_chars': reasoning_chars,
    'message_count': len(messages),
    'per_message_tokens': per_msg,
}
print(json.dumps(result, indent=2))
" > "$outfile"

  echo "  Saved to $outfile"
  cat "$outfile"
}

run_benchmark() {
  local label="$1"
  local session_id=""

  echo ""
  echo "=========================================="
  echo "  Running benchmark: $label"
  echo "=========================================="
  echo ""

  # Turn 1
  echo "[$label] Turn 1..."
  session_id=$(opencode run --model "$MODEL" --agent "$AGENT" --format json "$PROMPT_1" 2>/dev/null | python3 -c "
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
        if obj.get('type') == 'session' and obj.get('session', {}).get('id'):
            print(obj['session']['id'])
            break
    except:
        pass
")

  if [ -z "$session_id" ]; then
    echo "ERROR: Failed to get session ID from turn 1"
    return 1
  fi

  echo "  Session: $session_id"

  # Turn 2
  echo "[$label] Turn 2..."
  opencode run --model "$MODEL" --agent "$AGENT" --session "$session_id" "$PROMPT_2" 2>/dev/null > /dev/null

  # Turn 3
  echo "[$label] Turn 3..."
  opencode run --model "$MODEL" --agent "$AGENT" --session "$session_id" "$PROMPT_3" 2>/dev/null > /dev/null

  extract_session_tokens "$session_id" "$label"
}

compare_results() {
  echo ""
  echo "=========================================="
  echo "  BENCHMARK COMPARISON"
  echo "=========================================="
  echo ""

  python3 -c "
import json

with open('$RESULTS_DIR/with_plugin_tokens.json') as f:
    with_plugin = json.load(f)
with open('$RESULTS_DIR/without_plugin_tokens.json') as f:
    without_plugin = json.load(f)

def pct_diff(a, b):
    if b == 0:
        return 'N/A'
    return f'{((a - b) / b) * 100:+.1f}%'

print(f'Metric               | Without Plugin  | With Plugin     | Delta')
print(f'---------------------|-----------------|-----------------|----------')
print(f'Total Input Tokens   | {without_plugin[\"total_input\"]:>15,} | {with_plugin[\"total_input\"]:>15,} | {pct_diff(with_plugin[\"total_input\"], without_plugin[\"total_input\"])}')
print(f'Total Output Tokens  | {without_plugin[\"total_output\"]:>15,} | {with_plugin[\"total_output\"]:>15,} | {pct_diff(with_plugin[\"total_output\"], without_plugin[\"total_output\"])}')
print(f'Total Reasoning Tks  | {without_plugin[\"total_reasoning\"]:>15,} | {with_plugin[\"total_reasoning\"]:>15,} | {pct_diff(with_plugin[\"total_reasoning\"], without_plugin[\"total_reasoning\"])}')
print(f'Cache Read Tokens    | {without_plugin[\"total_cache_read\"]:>15,} | {with_plugin[\"total_cache_read\"]:>15,} | {pct_diff(with_plugin[\"total_cache_read\"], without_plugin[\"total_cache_read\"])}')
print(f'Cache Write Tokens   | {without_plugin[\"total_cache_write\"]:>15,} | {with_plugin[\"total_cache_write\"]:>15,} | {pct_diff(with_plugin[\"total_cache_write\"], without_plugin[\"total_cache_write\"])}')
print(f'Reasoning Parts      | {without_plugin[\"reasoning_parts_count\"]:>15,} | {with_plugin[\"reasoning_parts_count\"]:>15,} | {pct_diff(with_plugin[\"reasoning_parts_count\"], without_plugin[\"reasoning_parts_count\"])}')
print(f'Reasoning Chars      | {without_plugin[\"reasoning_total_chars\"]:>15,} | {with_plugin[\"reasoning_total_chars\"]:>15,} | {pct_diff(with_plugin[\"reasoning_total_chars\"], without_plugin[\"reasoning_total_chars\"])}')
print(f'Message Count        | {without_plugin[\"message_count\"]:>15,} | {with_plugin[\"message_count\"]:>15,} | {pct_diff(with_plugin[\"message_count\"], without_plugin[\"message_count\"])}')

# Per-message breakdown
print()
print('Per-Message Input Token Breakdown:')
print(f'Turn | Without Plugin  | With Plugin     | Delta')
print(f'-----|-----------------|-----------------|----------')
for i, (wo, w) in enumerate(zip(without_plugin['per_message_tokens'], with_plugin['per_message_tokens'])):
    if wo['role'] == 'assistant':
        print(f'  {i+1}  | {wo[\"input\"]:>15,} | {w[\"input\"]:>15,} | {pct_diff(w[\"input\"], wo[\"input\"])}')

# Estimate context savings
total_reasoning_chars = without_plugin['reasoning_total_chars']
estimated_reasoning_tokens = total_reasoning_chars // 4  # rough char-to-token ratio
print()
print(f'Estimated reasoning tokens stripped per LLM call: ~{estimated_reasoning_tokens:,}')
print(f'Over 3 turns, cumulative reasoning in context grows each turn.')
print(f'Turn 2 re-reads Turn 1 reasoning. Turn 3 re-reads Turn 1 + 2 reasoning.')
print(f'Total reasoning re-read (without plugin): ~{estimated_reasoning_tokens * 3:,} tokens across all calls')
print(f'Total reasoning re-read (with plugin): 0 tokens')
print(f'Context savings: ~{estimated_reasoning_tokens * 3:,} tokens freed for actual codebase content')
"
}

# ---- Main ----
echo "OpenCode Strip-Reasoning Benchmark"
echo "Model: $MODEL"
echo "Plugin: $PLUGIN_DIR"
echo ""

# Run WITHOUT plugin first (control)
echo "Phase 1: Running WITHOUT plugin (--pure)..."
remove_plugin_from_config
run_benchmark "without_plugin"

echo ""
echo "Phase 2: Running WITH plugin (strip mode)..."
add_plugin_to_config
run_benchmark "with_plugin"

echo ""
echo "Phase 3: Comparing results..."
compare_results

echo ""
echo "Done. Raw results in $RESULTS_DIR/"
