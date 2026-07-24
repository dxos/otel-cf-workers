// Regression fixture for the rc.63 Durable Object WebSocket kill (DXOS DX-1128 follow-up).
//
// Shape mirrors a real production setup (DXOS edge): an instrument()ed entry fetch handler
// that re-wraps a Durable Object WebSocket upgrade response, an instrumentDO()ed hibernatable
// echo DO whose webSocketMessage creates a span and makes a service-binding RPC to an
// instrumentEntrypoint()ed WorkerEntrypoint. With rc.63, the export chain scheduled on the
// no-op DurableObjectState#waitUntil floated past the invocation's I/O context and workerd
// killed the DO ~1ms after the first message — severing the WebSocket with a 1006 and never
// invoking webSocketClose.
import { trace } from '@opentelemetry/api'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { instrument, instrumentDO, instrumentEntrypoint } from '../../../dist/index.js'

// Synchronous counting exporter, so exports are observable in wrangler stdout.
let exportedTotal = 0
const countingExporter = {
	export(spans, resultCallback) {
		exportedTotal += spans.length
		console.log(`[exporter] exported ${spans.length} spans (total ${exportedTotal})`)
		resultCallback({ code: 0 }) // ExportResultCode.SUCCESS
	},
	async shutdown() {},
}

const config = () => ({
	exporter: countingExporter,
	service: { name: 'e2e-websocket-do' },
})

class AgentsEntrypointBase extends WorkerEntrypoint {
	async getKey() {
		return 'agent-key'
	}
}

class EchoDO {
	constructor(state, env) {
		this.state = state
		this.env = env
	}

	async fetch(_request) {
		const pair = new WebSocketPair()
		const [client, server] = Object.values(pair)
		this.state.acceptWebSocket(server)
		return new Response(null, { status: 101, webSocket: client })
	}

	async webSocketMessage(ws, message) {
		// A per-message span plus a service-binding RPC to the instrumented entrypoint.
		const tracer = trace.getTracer('e2e')
		await tracer.startActiveSpan('ws-message', async (span) => {
			try {
				await this.env.AGENTS.getKey()
			} finally {
				span.end()
			}
		})
		ws.send(message)
	}

	async webSocketClose(_ws, code, _reason, wasClean) {
		console.log(`[do] webSocketClose code=${code} clean=${wasClean}`)
	}
}

const handler = {
	async fetch(request, env, _ctx) {
		const url = new URL(request.url)
		if (url.pathname === '/ws') {
			const id = env.ECHO.idFromName('singleton')
			const stub = env.ECHO.get(id)
			const response = await stub.fetch(request)
			// Re-wrap the DO response (some routers wrap upgrade responses like this).
			return new Response(null, { status: response.status, webSocket: response.webSocket })
		}
		return new Response('ok')
	},
}

export const AgentsEntrypoint = instrumentEntrypoint(AgentsEntrypointBase, config)
export const EchoDurableObject = instrumentDO(EchoDO, config)
export default instrument(handler, config)
