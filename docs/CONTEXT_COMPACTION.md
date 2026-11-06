# Native Agent Context

Native runners use ADK Go v2.6.0 tail retention. Before a model call, ADK can replace older history with a rolling checkpoint and retain recent events plus the active user request. Original events remain in the JSONL transcript and audit log. Main agents and configured sub-agents use the same context runtime.

## Configuration

The existing `config.json` accepts:

```json
{
  "contextCompaction": {
    "enabled": true,
    "thresholdRatio": 0.8,
    "retainEvents": 12,
    "toolResultPrune": {
      "thresholdChars": 8192,
      "headChars": 4096,
      "tailChars": 1024
    }
  }
}
```

Omitting `enabled` enables context management. Set it to `false` to disable it. `retainEvents` counts ADK events, not tokens or complete user turns; ADK additionally protects the current request and tool-call/result boundaries.

The trigger is `thresholdRatio` times the selected model's `contextTokens`, capped to leave room for its configured output budget. When capacity is unknown, `maxContextChars / 4` is a heuristic fallback, defaulting to 50,000 tokens. Counts are approximate until a model reports prompt usage. A large system prompt or tool schema cannot be reduced by summarizing history.

Set `toolResultPrune.thresholdChars` to a negative number to disable automatic tool-result projection. The older `retainRatio`, `compactionRetries`, and `keepTailChars` settings remain readable for compatibility; they do not configure ADK's retained event count or add automatic summary retries.

## Manual Compaction

Send `/compact` as a standalone message to the Native Agent to compact history immediately, without waiting for the token threshold. It uses the same summarizer, `compact` plugin hook, retained event count, tool-call boundaries, and append-only checkpoints as automatic compaction. The command and its confirmation are persisted through the normal session pipeline; `/compact` does not start a conversational model call or run tools.

If there is no safe history window beyond the retained tail, the command reports that there is nothing to compact. When context management is disabled, it reports that compaction is disabled. Summary or persistence failures are returned as errors instead of falling through to an ordinary model response. External ACP agents continue to receive their own slash commands unchanged.

## Tool Results

Oversized top-level `result`, `text`, `stdout`, `stderr`, `output`, and string `content` fields are shortened by Unicode character count. Other fields, including errors, exit codes, and artifact references, remain intact. The original response and its chosen projection are persisted together in the tool event's state delta.

The runner reads a projected session view; the application continues to read full original results. Both shortened and unchanged decisions survive restart. Changing the budget does not retroactively shorten an already-seen result. Older logs receive decisions when first opened by a managed runner.

`read_tool_result` reads original results by `callId`, including after compaction or restart. `offset` and `limit` count Unicode characters in the response's JSON text. Pages default to 4,000 characters and are capped at 8,000. The reader checks the originating call's branch and isolation scope; it cannot retrieve a sibling task's output.

## Summary Requests and Cache Reuse

After request hooks, the model boundary records a bounded process-local snapshot of the request and observes its final serialized body. Up to 16 snapshots, totaling at most 16 MiB of request and wire data, are retained per context runtime.

When the selected summary region exactly matches a previously sent history prefix, the summary call retains the system instruction, tools, model and input envelope, and appends its directive as the last user message. The provider adapter verifies the serialized prefix before accepting this path. Chat Completions, Responses and Anthropic transports are covered.

Missing snapshots, non-prefix selections, changed request hooks, changed schemas, or different scopes fall back to ADK transcript summarization. Fallback summaries retain exact facts without truncating transcript parts. Both paths use a 60-second deadline, validate that the resulting checkpoint is shorter, honor the `compact` plugin hook, and leave history unchanged on failure. A failed attempt is not repeated within the same native invocation.

Prefix eligibility is not proof of a provider cache hit. Replacing old history still changes future requests from the first changed token. First-seen tool projections avoid repeatedly changing old outputs, while unchanged prefixes remain eligible for reuse.

## Diagnostics

With `LOOPRA_DEBUG=1`, the `context` logger records final request size, unchanged serialized message count, prompt/cache-read token usage, and elapsed time. Summary records include prefix eligibility or the fallback reason, input event count, usage, duration, and failure status. It does not log request text or credentials.

## Extension Boundary

Task workflows may wrap the native Agent for planning, execution and validation. Context management stays inside the native model/tool loop, so it runs between model steps rather than only between workflow nodes.
