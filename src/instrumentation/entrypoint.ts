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
import { WorkerEntrypoint } from 'cloudflare:workers'

type Env = Record<string, unknown>
type FetchFn = NonNullable<WorkerEntrypoint['fetch']>

let cold_start = true
export function executeEntrypointFetch(fetchFn: FetchFn, request: Request): Promise<Response> {
	console.log('[OTEL] executeEntrypointFetch called for:', request.url)

	const spanContext = getParentContextFromHeaders(request.headers)
	console.log('[OTEL] Span context extracted:', spanContext)

	const tracer = trace.getTracer('Entrypoint fetchHandler')
	console.log('[OTEL] Tracer obtained:', tracer)

	const attributes = {
		[SemanticAttributes.FAAS_TRIGGER]: 'http',
		[SemanticAttributes.FAAS_COLDSTART]: cold_start,
	}
	cold_start = false
	Object.assign(attributes, gatherRequestAttributes(request))
	Object.assign(attributes, gatherIncomingCfAttributes(request))
	console.log('[OTEL] Span attributes:', attributes)

	const options: SpanOptions = {
		attributes,
		kind: SpanKind.SERVER,
	}

	const promise = tracer.startActiveSpan('Entrypoint Fetch', options, spanContext, async (span) => {
		console.log('[OTEL] Span started:', span.spanContext().spanId)
		try {
			const response: Response = await fetchFn(request)
			console.log('[OTEL] Fetch completed with status:', response.status)
			if (response.ok) {
				span.setStatus({ code: SpanStatusCode.OK })
			}
			span.setAttributes(gatherResponseAttributes(response))
			span.end()
			console.log('[OTEL] Span ended successfully')

			return response
		} catch (error) {
			console.log('[OTEL] Fetch error:', error)
			span.recordException(error as Exception)
			span.setStatus({ code: SpanStatusCode.ERROR })
			span.end()
			throw error
		}
	})
	return promise
}

export function executeEntrypointRpcMethod(
	methodFn: (...args: any[]) => any,
	methodName: string,
	args: any[],
): Promise<any> {
	const tracer = trace.getTracer('Entrypoint RPC methodHandler')
	console.log('[OTEL] Tracer obtained for RPC method:', tracer)

	const attributes = {
		[SemanticAttributes.FAAS_TRIGGER]: 'other',
		'method.name': methodName,
		'method.args_count': args.length,
		'rpc.method': methodName,
	}
	console.log('[OTEL] RPC method span attributes:', attributes)

	const options: SpanOptions = {
		attributes,
		kind: SpanKind.SERVER, // RPC methods are server-side
	}

	const promise = tracer.startActiveSpan(`RPC Method ${methodName}`, options, async (span) => {
		console.log('[OTEL] RPC method span started:', span.spanContext().spanId)
		try {
			const result = await methodFn(...args)
			console.log('[OTEL] RPC method call completed successfully')
			span.setStatus({ code: SpanStatusCode.OK })
			span.end()
			console.log('[OTEL] RPC method span ended successfully')
			return result
		} catch (error) {
			console.log('[OTEL] Error in RPC method:', error)
			span.recordException(error as Exception)
			span.setStatus({ code: SpanStatusCode.ERROR })
			span.end()
			throw error
		}
	})
	return promise
}

function instrumentFetchFn(fetchFn: FetchFn, initialiser: Initialiser, env: Env): FetchFn {
	console.log('[OTEL] instrumentFetchFn called')
	const fetchHandler: ProxyHandler<FetchFn> = {
		async apply(target, thisArg, argArray: Parameters<FetchFn>) {
			console.log('[OTEL] instrumentFetchFn proxy handler called')
			const request = argArray[0]
			console.log('[OTEL] Request received:', request.url)

			const config = initialiser(env, request)
			console.log('[OTEL] Config from initialiser:', config)

			const context = setConfig(config)
			console.log('[OTEL] Context set:', context)

			try {
				const bound = target.bind(unwrap(thisArg))
				console.log('[OTEL] Calling executeEntrypointFetch')
				return await api_context.with(context, executeEntrypointFetch, undefined, bound, request)
			} catch (error) {
				console.log('[OTEL] Error in instrumentFetchFn:', error)
				throw error
			}
		},
	}
	return wrap(fetchFn, fetchHandler)
}

function instrumentAnyFn(fn: (...args: any[]) => any, initialiser: Initialiser, env: Env) {
	console.log('[OTEL] instrumentAnyFn called with function:', fn.name || 'anonymous')
	if (!fn) {
		console.log('[OTEL] instrumentAnyFn: function is undefined, returning undefined')
		return undefined
	}

	const methodName = fn.name || 'anonymous'
	const isPrivateMethod = methodName.startsWith('#') || methodName.startsWith('_')
	console.log('[OTEL] Method is private:', isPrivateMethod, 'for method:', methodName)

	const fnHandler: ProxyHandler<(...args: any[]) => any> = {
		async apply(target, thisArg, argArray) {
			console.log('[OTEL] instrumentAnyFn proxy handler called for function:', methodName)
			console.log('[OTEL] Arguments received:', argArray)

			thisArg = unwrap(thisArg)
			console.log('[OTEL] Unwrapped thisArg:', thisArg)

			const config = initialiser(env, 'entrypoint-method')
			console.log('[OTEL] Method config:', config)

			const context = setConfig(config)
			console.log('[OTEL] Method context set:', context)

			// Only create spans for public RPC methods, not private methods
			if (isPrivateMethod) {
				console.log('[OTEL] Private method, not creating span, just propagating context')
				try {
					const bound = target.bind(thisArg)
					console.log('[OTEL] Function bound, calling with context')
					const result = await api_context.with(context, () => bound.apply(thisArg, argArray), undefined)
					console.log('[OTEL] Private method call completed successfully')
					return result
				} catch (error) {
					console.log('[OTEL] Error in private method:', error)
					throw error
				}
			}

			// Create a span for public RPC methods
			try {
				const bound = target.bind(thisArg)
				console.log('[OTEL] Function bound, calling executeEntrypointRpcMethod')
				return await api_context.with(context, executeEntrypointRpcMethod, undefined, bound, methodName, argArray)
			} catch (error) {
				console.log('[OTEL] Error in RPC method:', error)
				throw error
			}
		},
	}
	return wrap(fn, fnHandler)
}

function instrumentEntrypoint(entrypoint: WorkerEntrypoint, initialiser: Initialiser, env: Env, ctx: ExecutionContext) {
	console.log('[OTEL] instrumentEntrypoint called')
	const objHandler: ProxyHandler<WorkerEntrypoint> = {
		get(target, prop) {
			console.log('[OTEL] instrumentEntrypoint proxy get called for property:', prop)
			if (prop === 'env') {
				console.log('[OTEL] Returning instrumented env')
				return env
			} else if (prop === 'ctx') {
				console.log('[OTEL] Returning ctx')
				return ctx
			} else if (prop === 'fetch') {
				console.log('[OTEL] Handling fetch property')
				const fetchFn = Reflect.get(target, prop)
				if (fetchFn) {
					console.log('[OTEL] Fetch function found, instrumenting it')
					return instrumentFetchFn(fetchFn, initialiser, env)
				}
				console.log('[OTEL] No fetch function found')
				return fetchFn
			} else {
				const result = Reflect.get(target, prop)
				if (typeof result === 'function') {
					console.log('[OTEL] Instrumenting other function:', prop)
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
	console.log('[OTEL] instrumentEntrypointClass called')
	const classHandler: ProxyHandler<C> = {
		construct(target, [orig_ctx, orig_env]: ConstructorParameters<EntrypointClass>) {
			console.log('[OTEL] Entrypoint class constructor called')
			console.log('[OTEL] Original env:', orig_env)
			console.log('[OTEL] Original ctx:', orig_ctx)

			const config = initialiser(orig_env, 'entrypoint-constructor')
			console.log('[OTEL] Constructor config:', config)

			const context = setConfig(config)
			console.log('[OTEL] Constructor context set:', context)

			const env = instrumentEnv(orig_env)
			console.log('[OTEL] Environment instrumented')

			const createEntrypoint = () => {
				console.log('[OTEL] Creating entrypoint instance')
				return new target(orig_ctx, orig_env)
			}
			const entrypoint = api_context.with(context, createEntrypoint)
			console.log('[OTEL] Entrypoint created with context')

			console.log('[OTEL] Instrumenting entrypoint instance')
			return instrumentEntrypoint(entrypoint, initialiser, env, orig_ctx)
		},
	}
	return wrap(entrypointClass, classHandler)
}
