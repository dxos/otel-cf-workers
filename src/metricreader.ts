import { MetricReader, PushMetricExporter } from '@opentelemetry/sdk-metrics'
import { ExportResultCode } from '@opentelemetry/core'

/**
 * A MetricReader that only exports on explicit forceFlush() calls.
 * CF Workers don't support setInterval, so PeriodicExportingMetricReader is not viable.
 */
export class OnDemandMetricReader extends MetricReader {
	private _exporter: PushMetricExporter

	constructor(exporter: PushMetricExporter) {
		super({
			aggregationTemporalitySelector: exporter.selectAggregationTemporality?.bind(exporter),
			aggregationSelector: exporter.selectAggregation?.bind(exporter),
		})
		this._exporter = exporter
	}

	protected async onForceFlush(): Promise<void> {
		const { resourceMetrics, errors } = await this.collect()
		if (errors.length > 0) {
			console.error('Errors collecting metrics:', errors)
		}
		await new Promise<void>((resolve, reject) => {
			this._exporter.export(resourceMetrics, (result) => {
				result.code === ExportResultCode.SUCCESS ? resolve() : reject(result.error ?? new Error('Metric export failed'))
			})
		})
	}

	protected async onShutdown(): Promise<void> {
		await this._exporter.shutdown()
	}
}
