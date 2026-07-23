import { context as api_context, trace, SpanOptions, SpanKind, Exception, SpanStatusCode } from '@opentelemetry/api'
import { SemanticAttributes } from '@opentelemetry/semantic-conventions'
import { passthroughGet, unwrap, wrap } from '../wrap.js'
import {
	getParentContextFromHeaders,
	gatherIncomingCfAttributes,
	gatherRequestAttributes,
	gatherResponseAttributes,
	instrumentClientFetch,
} from './fetch.js'
import { instrumentEnv } from './env.js'
import { Initialiser, setConfig } from '../config.js'
import { instrumentStorage } from './do-storage.js'
import { DOConstructorTrigger } from '../types.js'
import { exportSpans, proxyExecutionContext } from './common.js'

import { DurableObject as DurableObjectClass } from 'cloudflare:workers'

type DO = DurableObject | DurableObjectClass
type FetchFn = DurableObject['fetch']
type AlarmFn = DurableObject['alarm']
type Env = Record<string, unknown>

function instrumentBindingStub(stub: DurableObjectStub, nsName: string): DurableObjectStub {
	const stubHandler: ProxyHandler<typeof stub> = {
		get(target, prop, receiver) {
			if (prop === 'fetch') {
				const fetcher = Reflect.get(target, prop)
				const attrs = {
					name: `Durable Object ${nsName}`,
					'do.namespace': nsName,
					'do.id': target.id.toString(),
					'do.id.name': target.id.name,
				}
				return instrumentClientFetch(fetcher, () => ({ includeTraceContext: true }), attrs)
			} else {
				return passthroughGet(target, prop, receiver)
			}
		},
	}
	return wrap(stub, stubHandler)
}

function instrumentBindingGet(getFn: DurableObjectNamespace['get'], nsName: string): DurableObjectNamespace['get'] {
	const getHandler: ProxyHandler<DurableObjectNamespace['get']> = {
		apply(target, thisArg, argArray) {
			const stub: DurableObjectStub = Reflect.apply(target, thisArg, argArray)
			return instrumentBindingStub(stub, nsName)
		},
	}
	return wrap(getFn, getHandler)
}

export function instrumentDOBinding(ns: DurableObjectNamespace, nsName: string) {
	const nsHandler: ProxyHandler<typeof ns> = {
		get(target, prop, receiver) {
			if (prop === 'get') {
				const fn = Reflect.get(ns, prop, receiver)
				return instrumentBindingGet(fn, nsName)
			} else {
				return passthroughGet(target, prop, receiver)
			}
		},
	}
	return wrap(ns, nsHandler)
}

export function instrumentState(state: DurableObjectState) {
	const stateHandler: ProxyHandler<DurableObjectState> = {
		get(target, prop, receiver) {
			const result = Reflect.get(target, prop, unwrap(receiver))
			if (prop === 'storage') {
				return instrumentStorage(result)
			} else if (typeof result === 'function') {
				return result.bind(target)
			} else {
				return result
			}
		},
	}
	return wrap(state, stateHandler)
}

let cold_start = true
export function executeDOFetch(
	fetchFn: FetchFn,
	request: Request,
	id: DurableObjectId,
	state: DurableObjectState,
): Promise<Response> {
	const spanContext = getParentContextFromHeaders(request.headers)
	const { tracker } = proxyExecutionContext(state)

	const tracer = trace.getTracer('DO fetchHandler')
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

	const name = id.name || ''
	const promise = tracer.startActiveSpan(`Durable Object Fetch ${name}`, options, spanContext, async (span) => {
		try {
			const response: Response = await fetchFn(request)
			if (response.ok) {
				span.setStatus({ code: SpanStatusCode.OK })
			}
			span.setAttributes(gatherResponseAttributes(response))
			span.end()
			state.waitUntil(exportSpans(tracker))

			return response
		} catch (error) {
			span.recordException(error as Exception)
			span.setStatus({ code: SpanStatusCode.ERROR })
			span.end()
			state.waitUntil(exportSpans(tracker))
			throw error
		}
	})
	return promise
}

export function executeDOAlarm(
	alarmFn: NonNullable<AlarmFn>,
	id: DurableObjectId,
	state: DurableObjectState,
): Promise<void> {
	const tracer = trace.getTracer('DO alarmHandler')
	const { tracker } = proxyExecutionContext(state)

	const name = id.name || ''
	const promise = tracer.startActiveSpan(`Durable Object Alarm ${name}`, async (span) => {
		span.setAttribute(SemanticAttributes.FAAS_COLDSTART, cold_start)
		cold_start = false
		span.setAttribute('do.id', id.toString())
		if (id.name) span.setAttribute('do.name', id.name)

		try {
			await alarmFn()
			span.end()
			state.waitUntil(exportSpans(tracker))
		} catch (error) {
			span.recordException(error as Exception)
			span.setStatus({ code: SpanStatusCode.ERROR })
			span.end()
			state.waitUntil(exportSpans(tracker))
			throw error
		}
	})
	return promise
}

function instrumentFetchFn(fetchFn: FetchFn, initialiser: Initialiser, env: Env, state: DurableObjectState): FetchFn {
	const fetchHandler: ProxyHandler<FetchFn> = {
		async apply(target, thisArg, argArray: Parameters<FetchFn>) {
			const request = argArray[0]
			const config = initialiser(env, request)
			const context = setConfig(config)
			try {
				const bound = target.bind(unwrap(thisArg))
				return await api_context.with(context, executeDOFetch, undefined, bound, request, state.id, state)
			} catch (error) {
				throw error
			}
		},
	}
	return wrap(fetchFn, fetchHandler)
}

function instrumentAlarmFn(alarmFn: AlarmFn, initialiser: Initialiser, env: Env, state: DurableObjectState) {
	if (!alarmFn) return undefined

	const alarmHandler: ProxyHandler<NonNullable<AlarmFn>> = {
		async apply(target, thisArg) {
			const config = initialiser(env, 'do-alarm')
			const context = setConfig(config)
			try {
				const bound = target.bind(unwrap(thisArg))
				return await api_context.with(context, executeDOAlarm, undefined, bound, state.id, state)
			} catch (error) {
				throw error
			}
		},
	}
	return wrap(alarmFn, alarmHandler)
}

function instrumentAnyFn(fn: () => any, initialiser: Initialiser, env: Env, state: DurableObjectState) {
	if (!fn) return undefined

	const fnHandler: ProxyHandler<() => any> = {
		async apply(target, thisArg, argArray: []) {
			thisArg = unwrap(thisArg)
			const config = initialiser(env, 'do-alarm')
			const context = setConfig(config)
			const { tracker } = proxyExecutionContext(state)
			try {
				const bound = target.bind(unwrap(thisArg))
				return await api_context.with(context, () => bound.apply(thisArg, argArray), undefined)
			} finally {
				// Same cross-request flush hazard as WorkerEntrypoint RPC methods: keep the DO
				// invocation context alive until BatchTraceSpanProcessor export settles.
				state.waitUntil(exportSpans(tracker))
			}
		},
	}
	return wrap(fn, fnHandler)
}

function instrumentDurableObject(
	doObj: DO,
	initialiser: Initialiser,
	env: Env,
	state: DurableObjectState,
	classStyle: boolean,
) {
	const objHandler: ProxyHandler<DurableObject> = {
		get(target, prop) {
			if (classStyle && prop === 'ctx') {
				return state
			} else if (classStyle && prop === 'env') {
				return env
			} else if (prop === 'fetch') {
				const fetchFn = Reflect.get(target, prop)
				return instrumentFetchFn(fetchFn, initialiser, env, state)
			} else if (prop === 'alarm') {
				const alarmFn = Reflect.get(target, prop)
				return instrumentAlarmFn(alarmFn, initialiser, env, state)
			} else {
				const result = Reflect.get(target, prop)
				if (typeof result === 'function') {
					result.bind(doObj)
					return instrumentAnyFn(result, initialiser, env, state)
				}
				return result
			}
		},
	}
	return wrap(doObj, objHandler)
}

export type DOClass = { new (state: DurableObjectState, env: any): DO }

export function instrumentDOClass<C extends DOClass>(doClass: C, initialiser: Initialiser): C {
	const classHandler: ProxyHandler<C> = {
		construct(target, [orig_state, orig_env]: ConstructorParameters<DOClass>) {
			const trigger: DOConstructorTrigger = {
				id: orig_state.id.toString(),
				name: orig_state.id.name,
			}
			const constructorConfig = initialiser(orig_env, trigger)
			const context = setConfig(constructorConfig)
			const state = instrumentState(orig_state)
			const env = instrumentEnv(orig_env)
			const classStyle = doClass.prototype instanceof DurableObjectClass
			const createDO = () => {
				if (classStyle) {
					return new target(orig_state, orig_env)
				} else {
					return new target(state, env)
				}
			}
			const doObj = api_context.with(context, createDO)

			return instrumentDurableObject(doObj, initialiser, env, state, classStyle)
		},
	}
	return wrap(doClass, classHandler)
}
