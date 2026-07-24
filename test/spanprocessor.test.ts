import { ExportResultCode } from '@opentelemetry/core'
import { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { Span } from '@opentelemetry/api'
import { beforeEach, describe, expect, test } from 'vitest'
import { BatchTraceSpanProcessor } from '../src/spanprocessor'

class CapturingExporter implements SpanExporter {
	batches: ReadableSpan[][] = []

	export(spans: ReadableSpan[], resultCallback: (result: { code: ExportResultCode }) => void): void {
		this.batches.push(spans)
		resultCallback({ code: ExportResultCode.SUCCESS })
	}

	async shutdown(): Promise<void> {}
}

class FailingExporter implements SpanExporter {
	attempts = 0

	export(_spans: ReadableSpan[], resultCallback: (result: { code: ExportResultCode; error?: Error }) => void): void {
		this.attempts++
		resultCallback({ code: ExportResultCode.FAILED, error: new Error('export failed') })
	}

	async shutdown(): Promise<void> {}
}

const makeSpan = (traceId: string, spanId: string): Span =>
	({
		spanContext: () => ({ traceId, spanId, traceFlags: 1 }),
	}) as unknown as Span

const asReadable = (span: Span): ReadableSpan => span as unknown as ReadableSpan

describe('BatchTraceSpanProcessor', () => {
	let exporter: CapturingExporter
	let processor: BatchTraceSpanProcessor

	beforeEach(() => {
		exporter = new CapturingExporter()
		processor = new BatchTraceSpanProcessor(exporter)
	})

	test('does not export on span end without an explicit flush', async () => {
		const span = makeSpan('trace-a', 'span-1')
		processor.onStart(span, undefined as any)
		processor.onEnd(asReadable(span))

		// Give any (buggy) fire-and-forget flush a chance to run.
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(exporter.batches).toHaveLength(0)
	})

	test('forceFlush(traceId) exports the ended spans of that trace', async () => {
		const span = makeSpan('trace-a', 'span-1')
		processor.onStart(span, undefined as any)
		processor.onEnd(asReadable(span))

		await processor.forceFlush('trace-a')
		expect(exporter.batches).toHaveLength(1)
		expect(exporter.batches[0]).toHaveLength(1)
	})

	test('forceFlush(traceId) leaves other traces untouched', async () => {
		const spanA = makeSpan('trace-a', 'span-1')
		const spanB = makeSpan('trace-b', 'span-2')
		processor.onStart(spanA, undefined as any)
		processor.onStart(spanB, undefined as any)
		processor.onEnd(asReadable(spanA))
		processor.onEnd(asReadable(spanB))

		await processor.forceFlush('trace-a')
		expect(exporter.batches).toHaveLength(1)
		expect(exporter.batches[0]![0]!.spanContext().spanId).toBe('span-1')

		await processor.forceFlush()
		expect(exporter.batches).toHaveLength(2)
		expect(exporter.batches[1]![0]!.spanContext().spanId).toBe('span-2')
	})

	test('in-progress spans stay pending instead of being force-ended, and export once ended', async () => {
		const rootSpan = makeSpan('trace-a', 'root')
		const childSpan = makeSpan('trace-a', 'child')
		processor.onStart(rootSpan, undefined as any)
		processor.onStart(childSpan, undefined as any)
		processor.onEnd(asReadable(childSpan))

		// The root span is still running (e.g. it belongs to another invocation in this isolate).
		await processor.forceFlush('trace-a')
		expect(exporter.batches).toHaveLength(1)
		expect(exporter.batches[0]).toHaveLength(1)
		expect(exporter.batches[0]![0]!.spanContext().spanId).toBe('child')

		processor.onEnd(asReadable(rootSpan))
		await processor.forceFlush('trace-a')
		expect(exporter.batches).toHaveLength(2)
		expect(exporter.batches[1]![0]!.spanContext().spanId).toBe('root')
	})

	test('flush with nothing ended exports nothing', async () => {
		const span = makeSpan('trace-a', 'span-1')
		processor.onStart(span, undefined as any)

		await processor.forceFlush('trace-a')
		await processor.forceFlush()
		expect(exporter.batches).toHaveLength(0)
	})

	test('export failures are swallowed, not propagated to the invocation', async () => {
		const failing = new FailingExporter()
		const failingProcessor = new BatchTraceSpanProcessor(failing)
		const span = makeSpan('trace-a', 'span-1')
		failingProcessor.onStart(span, undefined as any)
		failingProcessor.onEnd(asReadable(span))

		await expect(failingProcessor.forceFlush('trace-a')).resolves.toBeUndefined()
		expect(failing.attempts).toBe(1)
	})

	test('settled traces are removed from the processor to avoid unbounded growth', async () => {
		const span = makeSpan('trace-a', 'span-1')
		processor.onStart(span, undefined as any)
		processor.onEnd(asReadable(span))

		await processor.forceFlush('trace-a')
		expect(Object.keys((processor as any).traces)).toHaveLength(0)
	})

	test('traces with in-progress spans are kept across flushes', async () => {
		const span = makeSpan('trace-a', 'span-1')
		processor.onStart(span, undefined as any)

		await processor.forceFlush('trace-a')
		expect(Object.keys((processor as any).traces)).toContain('trace-a')
	})
})
