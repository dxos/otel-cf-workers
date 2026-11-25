---
'@dxos/otel-cf-workers': patch
---

Remove a stray `console.log({ versionMeta })` from `createResource`. It printed one line on every instrumented request.
