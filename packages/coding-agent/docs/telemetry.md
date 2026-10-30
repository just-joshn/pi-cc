# Telemetry

pi-cc never sends telemetry, feature-flag, or error-reporting traffic to Anthropic or its vendors. It has no client for any of them.

## Local gates

These Claude Code variables are accepted with the same meaning where pi-cc has an equivalent.

| Variable | Effect in pi-cc |
|---|---|
| `DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DO_NOT_TRACK` | Forces off pi's install-count ping and provider attribution headers. `enableInstallTelemetry` is off by default. |
| `DISABLE_BUG_COMMAND`, `DISABLE_FEEDBACK_COMMAND`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `/bug` refuses to run and names the variable. |
| `DISABLE_ERROR_REPORTING`, `DISABLE_GROWTHBOOK` | Accepted. pi-cc has no remote error reporting and no feature-flag service, so there is nothing to turn off. |

None of these gates the OpenTelemetry export below. Claude Code 2.1.312 behaves the same way.

## Upstream network calls

pi-cc makes no call to hosts its upstream project owns unless asked. These are off by default and come on only with `PI_CC_ALLOW_UPSTREAM_NETWORK=1`, and never under the gates above.

- The pi.dev model catalog refresh.
- The GitHub release download of `fd` and `rg`. Install them with your package manager.

The install-count ping to pi.dev needs `enableInstallTelemetry` (or `PI_TELEMETRY=1`) and respects the gates. `/share`, `/bug` uploads, and the model client run only when you invoke them.

## OpenTelemetry export to your own collector

Set `CLAUDE_CODE_ENABLE_TELEMETRY=1` and an exporter per signal. The `env` block of a settings file works too.

```
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

Supported: `http/json` and `http/protobuf` (`OTEL_EXPORTER_OTLP_PROTOCOL` and the per-signal forms), `OTEL_EXPORTER_OTLP_HEADERS` and the per-signal forms, `OTEL_EXPORTER_OTLP_{METRICS,LOGS}_ENDPOINT`, `OTEL_METRIC_EXPORT_INTERVAL`, `OTEL_LOGS_EXPORT_INTERVAL`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`, and `OTEL_METRICS_INCLUDE_SESSION_ID` and `OTEL_METRICS_INCLUDE_VERSION`.

Metrics: `claude_code.session.count`, `token.usage`, `cost.usage`, `active_time.total`, `code_edit_tool.decision`, `lines_of_code.count`, `commit.count`, `pull_request.count`.
Events: `user_prompt`, `api_request`, `assistant_response`, `api_error`, `tool_decision`, `tool_result`.

Prompt, reply, and tool text are redacted until opted in. `OTEL_LOG_USER_PROMPTS` shows the prompt and the reply, `OTEL_LOG_ASSISTANT_RESPONSES` shows the reply, and `OTEL_LOG_TOOL_DETAILS` adds `tool_parameters`, `tool_input`, and the error text to tool events. `OTEL_LOG_TOOL_CONTENT` only affects trace spans, which pi-cc does not export.

Not supported, and the signal is left without an exporter: `grpc`, the `console` and `prometheus` exporters, traces, and `otelHeadersHelper`.
