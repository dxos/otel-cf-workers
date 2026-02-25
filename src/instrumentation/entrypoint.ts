import { context as api_context, trace, SpanOptions, SpanKind, Exception, SpanStatusCode } from '@opentelemetry/api'
import { SemanticAttributes } from '@opentelemetry/semantic-conventions'
import { unwrap, wrap } from '../wrap.js'
import {
	getParentContextFromHeaders,
	gatherIncomingCfAttributes,
	gatherRequestAttributes,
	gatherResponseAttributes,
} from './fetch.js'
import { instrumentEnv } from './env.js'
import { Initialiser, setConfig } from '../config.js'
import { flushMetrics } from '../sdk.js'
import { WorkerEntrypoint } from 'cloudflare:workers'

type Env = Record<string, unknown>
type FetchFn = NonNullable<WorkerEntrypoint['fetch']>

let cold_start = true
export function executeEntrypointFetch(fetchFn: FetchFn, request: Request): Promise<Response> {
	const spanContext = getParentContextFromHeaders(request.headers)

	const tracer = trace.getTracer('Entrypoint fetchHandler')
	const attributes = {
		[SemanticAttributes.FAAS_TRIGGER]: 'http',
		[SemanticAttributes.FAAS_COLDSTART]: cold_start,
	}
	cold_start = false
	Object.assign(attributes, gatherRequestAttributes(request))
	Object.assign(attributes, gatherIncomingCfAttributes(request))

	const options: SpanOptions = {
		attributes,
		kind: SpanKind.SERVER,
	}

	const promise = tracer.startActiveSpan('Entrypoint Fetch', options, spanContext, async (span) => {
		try {
			const response: Response = await fetchFn(request)
			if (response.ok) {
				span.setStatus({ code: SpanStatusCode.OK })
			}
			span.setAttributes(gatherResponseAttributes(response))
			span.end()
			flushMetrics().catch(() => {})

			return response
		} catch (error) {
			span.recordException(error as Exception)
			span.setStatus({ code: SpanStatusCode.ERROR })
			span.end()
			flushMetrics().catch(() => {})
			throw error
		}
	})
	return promise
}

function instrumentFetchFn(fetchFn: FetchFn, initialiser: Initialiser, env: Env): FetchFn {
	const fetchHandler: ProxyHandler<FetchFn> = {
		async apply(target, thisArg, argArray: Parameters<FetchFn>) {
			const request = argArray[0]
			const config = initialiser(env, request)
			const context = setConfig(config)

			try {
				const bound = target.bind(unwrap(thisArg))
				return await api_context.with(context, executeEntrypointFetch, undefined, bound, request)
			} catch (error) {
				throw error
			}
		},
	}
	return wrap(fetchFn, fetchHandler)
}

function instrumentAnyFn(fn: (...args: any[]) => any, initialiser: Initialiser, env: Env) {
	const fnHandler: ProxyHandler<(...args: any[]) => any> = {
		async apply(target, thisArg, argArray) {
			thisArg = unwrap(thisArg)
			const config = initialiser(env, 'entrypoint-method')
			const context = setConfig(config)

			try {
				const bound = target.bind(thisArg)
				return await api_context.with(context, () => bound.apply(thisArg, argArray), undefined)
			} catch (error) {
				throw error
			}
		},
	}
	return wrap(fn, fnHandler)
}

function instrumentEntrypoint(entrypoint: WorkerEntrypoint, initialiser: Initialiser, env: Env, ctx: ExecutionContext) {
	const objHandler: ProxyHandler<WorkerEntrypoint> = {
		get(target, prop) {
			if (prop === 'env') {
				return env
			} else if (prop === 'ctx') {
				return ctx
			} else if (prop === 'fetch') {
				const fetchFn = Reflect.get(target, prop)
				if (fetchFn) {
					return instrumentFetchFn(fetchFn, initialiser, env)
				}
				return fetchFn
			} else {
				const result = Reflect.get(target, prop)
				if (typeof result === 'function') {
					result.bind(entrypoint)
					return instrumentAnyFn(result, initialiser, env)
				}
				return result
			}
		},
	}
	return wrap(entrypoint, objHandler)
}

export type EntrypointClass = new (ctx: ExecutionContext, env: any) => WorkerEntrypoint

export function instrumentEntrypointClass<C extends EntrypointClass>(entrypointClass: C, initialiser: Initialiser): C {
	const classHandler: ProxyHandler<C> = {
		construct(target, [orig_ctx, orig_env]: ConstructorParameters<EntrypointClass>) {
			const config = initialiser(orig_env, 'entrypoint-constructor')
			const context = setConfig(config)
			const env = instrumentEnv(orig_env)

			const createEntrypoint = () => {
				return new target(orig_ctx, orig_env)
			}
			const entrypoint = api_context.with(context, createEntrypoint)

			return instrumentEntrypoint(entrypoint, initialiser, env, orig_ctx)
		},
	}
	return wrap(entrypointClass, classHandler)
}
