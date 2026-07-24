---
'@dxos/otel-cf-workers': patch
---

Make span export context-safe: never let an export promise float past the invocation that created it.

- `BatchTraceSpanProcessor` no longer flushes fire-and-forget from `onEnd`, no longer retains export promises in long-lived state, and no longer force-ends in-progress spans of concurrent invocations on flush — it exports exactly the ended spans of the flushed trace and keeps the rest pending. Settled traces are dropped from the processor (fixes unbounded growth in long-lived Durable Objects).
- Durable Object wrappers (fetch/alarm/webSocket handlers/RPC methods) now `await` the export inside the invocation instead of scheduling it on `DurableObjectState#waitUntil`, which is a documented no-op. The floating chain introduced in rc.63 made local workerd kill the isolate with `Fatal uncaught kj::Exception: … JavaScript heap objects must not contain KJ I/O objects`, severing every hibernatable WebSocket with a 1006 ~1ms after upgrade. Note: with a network exporter (OTLP) this adds export latency to DO invocations; with synchronous exporters it is negligible.
- `WorkerEntrypoint` wrappers keep using the real `ctx.waitUntil`, now scoped to the invocation's trace and run inside the config context.
- `RpcTarget` methods now flush ended spans (awaited) — previously their spans only left the process via the floating auto-flush.
- `exportSpans(traceId?, tracker?)` is unified (traceId now optional), never rejects, and keeps the rc.63 `forceFlush()` fix that actually awaits pending flushes.
- Added an e2e regression test (`pnpm test:e2e`): instrumented entry handler + instrumented DO WebSocket echo + instrumented entrypoint RPC under `wrangler dev` must survive sustained traffic with spans exported and no kj fatals or cross-request promise warnings.
