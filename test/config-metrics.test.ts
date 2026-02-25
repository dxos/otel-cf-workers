import { describe, it, expect, vi } from 'vitest'
import { parseConfig } from '../src/config'
import type { TraceConfig } from '../src/types'
import type { PushMetricExporter } from '@opentelemetry/sdk-metrics'
import { ExportResultCode } from '@opentelemetry/core'

function createStubMetricExporter(): PushMetricExporter {
	return {
		export: vi.fn((_metrics, cb) => cb({ code: ExportResultCode.SUCCESS })),
		forceFlush: vi.fn().mockResolvedValue(undefined),
		shutdown: vi.fn().mockResolvedValue(undefined),
	}
}

function createStubSpanExporter() {
	return {
		export: vi.fn((_spans: unknown, cb: (result: { code: number }) => void) => cb({ code: ExportResultCode.SUCCESS })),
		shutdown: vi.fn().mockResolvedValue(undefined),
	}
}

describe('parseConfig with metrics', () => {
	it('passes through metrics config when provided', () => {
		const metricExporter = createStubMetricExporter()
		const config: TraceConfig = {
			service: { name: 'test-worker' },
			exporter: createStubSpanExporter(),
			metrics: { exporter: metricExporter },
		}

		const resolved = parseConfig(config)

		expect(resolved.metrics).toBeDefined()
		expect(resolved.metrics!.exporter).toBe(metricExporter)
	})

	it('resolved config has metrics undefined when not provided', () => {
		const config: TraceConfig = {
			service: { name: 'test-worker' },
			exporter: createStubSpanExporter(),
		}

		const resolved = parseConfig(config)

		expect(resolved.metrics).toBeUndefined()
	})

	it('preserves all existing config alongside metrics', () => {
		const metricExporter = createStubMetricExporter()
		const config: TraceConfig = {
			service: { name: 'my-service', namespace: 'prod', version: '1.0.0' },
			exporter: createStubSpanExporter(),
			metrics: { exporter: metricExporter },
		}

		const resolved = parseConfig(config)

		expect(resolved.service.name).toBe('my-service')
		expect(resolved.service.namespace).toBe('prod')
		expect(resolved.service.version).toBe('1.0.0')
		expect(resolved.metrics!.exporter).toBe(metricExporter)
		expect(resolved.spanProcessors).toHaveLength(1)
	})
})
