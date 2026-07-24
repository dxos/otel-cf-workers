import { Context, Span } from '@opentelemetry/api'
import { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { ExportResultCode } from '@opentelemetry/core'
import { getActiveConfig } from './config'
import { TraceFlushableSpanProcessor } from './types'
import { TailSampleFn } from './sampling'

function getSampler(): TailSampleFn {
	const conf = getActiveConfig()
	if (!conf) {
		console.log('Could not find config for sampling, sending everything by default')
	}
	return conf ? conf.sampling.tailSampler : () => true
}

class TraceState {
	private pendingSpans: ReadableSpan[] = []
	private inprogressSpans = new Set<string>()
	private exporter: SpanExporter
	private localRootSpan?: ReadableSpan
	private traceDecision?: boolean

	constructor(exporter: SpanExporter) {
		this.exporter = exporter
	}

	/** True when there is nothing left to export and no span is still running. */
	get isSettled(): boolean {
		return this.pendingSpans.length === 0 && this.inprogressSpans.size === 0
	}

	addSpan(span: Span): void {
		const readableSpan = span as unknown as ReadableSpan
		this.localRootSpan = this.localRootSpan || readableSpan
		this.pendingSpans.push(readableSpan)
		this.inprogressSpans.add(span.spanContext().spanId)
	}

	endSpan(span: ReadableSpan): void {
		// Note: no eager flush here. Flushing is driven exclusively by the instrumentation
		// wrappers at the end of each invocation (awaited, or handed to a *real* waitUntil),
		// so that no export promise ever floats past the I/O context that created it.
		// A fire-and-forget flush from onEnd is what caused workerd's "promise was resolved
		// or rejected from a different request context" warnings and — combined with promise
		// retention in this long-lived object — fatal kj assertions under wrangler dev that
		// killed the isolate and severed every hibernatable WebSocket with a 1006.
		this.inprogressSpans.delete(span.spanContext().spanId)
	}

	/**
	 * Export the spans of this trace that have ended. Spans still in progress — e.g. owned by
	 * another invocation running concurrently in this isolate — stay pending for a later flush
	 * instead of being force-ended, which used to corrupt sibling traces.
	 * Each call awaits only the export batch it started and never rejects.
	 */
	async flush(): Promise<void> {
		const endedSpans = this.pendingSpans.filter((span) => !this.isSpanInProgress(span))
		if (endedSpans.length === 0) {
			return
		}
		this.pendingSpans = this.pendingSpans.filter((span) => this.isSpanInProgress(span))
		const sampledSpans = this.sample(endedSpans)
		if (sampledSpans.length === 0) {
			return
		}
		try {
			await this.exportSpans(sampledSpans)
		} catch (error) {
			console.log('exporting spans failed! ' + error)
		}
	}

	private sample(spans: ReadableSpan[]): ReadableSpan[] {
		if (this.traceDecision === undefined) {
			const sampler = getSampler()
			this.traceDecision = sampler({
				traceId: this.localRootSpan!.spanContext().traceId,
				localRootSpan: this.localRootSpan!,
				spans,
			})
		}
		return this.traceDecision ? spans : []
	}

	private isSpanInProgress(span: ReadableSpan) {
		return this.inprogressSpans.has(span.spanContext().spanId)
	}

	private async exportSpans(spans: ReadableSpan[]): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.exporter.export(spans, (result) => {
				if (result.code === ExportResultCode.SUCCESS) {
					resolve()
				} else {
					reject(result.error)
				}
			})
		})
	}
}

type traceId = string
export class BatchTraceSpanProcessor implements TraceFlushableSpanProcessor {
	private traces: Record<traceId, TraceState> = {}

	constructor(private exporter: SpanExporter) {}

	getTraceState(traceId: string): TraceState {
		const traceState = this.traces[traceId] || new TraceState(this.exporter)
		this.traces[traceId] = traceState
		return traceState
	}

	onStart(span: Span, _parentContext: Context): void {
		const traceId = span.spanContext().traceId
		this.getTraceState(traceId).addSpan(span)
	}

	onEnd(span: ReadableSpan): void {
		const traceId = span.spanContext().traceId
		this.getTraceState(traceId).endSpan(span)
	}

	async forceFlush(traceId?: traceId): Promise<void> {
		if (traceId) {
			const traceState = this.traces[traceId]
			if (traceState) {
				await traceState.flush()
				if (traceState.isSettled) {
					delete this.traces[traceId]
				}
			}
		} else {
			const promises = Object.keys(this.traces).map((id) => this.forceFlush(id))
			await Promise.allSettled(promises)
		}
	}

	async shutdown(): Promise<void> {
		await this.forceFlush()
	}
}
