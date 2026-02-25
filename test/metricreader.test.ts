import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MeterProvider, PushMetricExporter, ResourceMetrics } from '@opentelemetry/sdk-metrics'
import { ExportResult, ExportResultCode } from '@opentelemetry/core'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { OnDemandMetricReader } from '../src/metricreader'

function createTestExporter(
	overrides?: Partial<PushMetricExporter>,
): PushMetricExporter & { exportedData: ResourceMetrics[] } {
	const exportedData: ResourceMetrics[] = []
	return {
		exportedData,
		export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
			exportedData.push(metrics)
			resultCallback({ code: ExportResultCode.SUCCESS })
		},
		forceFlush: vi.fn().mockResolvedValue(undefined),
		shutdown: vi.fn().mockResolvedValue(undefined),
		...overrides,
	}
}

describe('OnDemandMetricReader', () => {
	let exporter: ReturnType<typeof createTestExporter>
	let reader: OnDemandMetricReader
	let provider: MeterProvider

	beforeEach(() => {
		exporter = createTestExporter()
		reader = new OnDemandMetricReader(exporter)
		provider = new MeterProvider({
			resource: resourceFromAttributes({ 'service.name': 'test-service' }),
			readers: [reader],
		})
	})

	it('does not export metrics without an explicit forceFlush', () => {
		const meter = provider.getMeter('test')
		const counter = meter.createCounter('requests')
		counter.add(5)

		expect(exporter.exportedData).toHaveLength(0)
	})

	it('exports collected metrics on forceFlush', async () => {
		const meter = provider.getMeter('test')
		const counter = meter.createCounter('requests')
		counter.add(1, { method: 'GET' })
		counter.add(3, { method: 'POST' })

		await provider.forceFlush()

		expect(exporter.exportedData).toHaveLength(1)
		const resourceMetrics = exporter.exportedData[0]!
		expect(resourceMetrics.scopeMetrics).toHaveLength(1)

		const scopeMetrics = resourceMetrics.scopeMetrics[0]!
		expect(scopeMetrics.metrics).toHaveLength(1)
		expect(scopeMetrics.metrics[0]!.descriptor.name).toBe('requests')
	})

	it('exports multiple metric instruments', async () => {
		const meter = provider.getMeter('test')
		meter.createCounter('counter_a').add(1)
		meter.createCounter('counter_b').add(2)

		await provider.forceFlush()

		expect(exporter.exportedData).toHaveLength(1)
		const names = exporter.exportedData[0]!.scopeMetrics[0]!.metrics.map((m) => m.descriptor.name)
		expect(names).toContain('counter_a')
		expect(names).toContain('counter_b')
	})

	it('can flush multiple times (accumulates new data each cycle)', async () => {
		const meter = provider.getMeter('test')
		const counter = meter.createCounter('requests')

		counter.add(1)
		await provider.forceFlush()
		expect(exporter.exportedData).toHaveLength(1)

		counter.add(2)
		await provider.forceFlush()
		expect(exporter.exportedData).toHaveLength(2)
	})

	it('propagates export failures', async () => {
		const failingExporter = createTestExporter({
			export(_metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
				resultCallback({ code: ExportResultCode.FAILED, error: new Error('network down') })
			},
		})
		const failingReader = new OnDemandMetricReader(failingExporter)
		const failingProvider = new MeterProvider({
			resource: resourceFromAttributes({ 'service.name': 'test' }),
			readers: [failingReader],
		})

		failingProvider.getMeter('test').createCounter('c').add(1)

		await expect(failingProvider.forceFlush()).rejects.toThrow('network down')
	})

	it('calls exporter.shutdown on reader shutdown', async () => {
		await provider.shutdown()

		expect(exporter.shutdown).toHaveBeenCalledOnce()
	})
})
