---
'@dxos/otel-cf-workers': patch
---

Keep WorkerEntrypoint/DO RPC request contexts alive with `ctx.waitUntil` while OTEL span/metric export finishes, and fix `forceFlush()` without a traceId so it actually awaits pending flushes. This stops workerd's cross-request promise warning when application code ends spans inside short-lived entrypoint RPCs.
