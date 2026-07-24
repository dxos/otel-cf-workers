#!/usr/bin/env node
// E2E regression test: a WebSocket served by an instrumented Durable Object behind an
// instrumented entry handler must survive sustained echo traffic under `wrangler dev`.
//
// Guards against the rc.63 regression where the span-export chain was scheduled on the no-op
// DurableObjectState#waitUntil: workerd killed the DO ~1ms after the first message (WebSocket
// 1006 storm, at times a fatal kj::Exception killing the whole isolate). See src/worker.mjs.
//
// Run with: pnpm test:e2e (requires `pnpm build:src` output in dist/).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const port = 8790 + (process.pid % 100)
const inspectorPort = port + 1000
const clientDurationMs = 12_000
const echoIntervalMs = 150

const fail = (message) => {
	console.error(`\nFAIL: ${message}`)
	process.exitCode = 1
}

if (!existsSync(join(repoRoot, 'dist', 'index.js'))) {
	console.error('dist/index.js not found — run `pnpm build:src` first.')
	process.exit(1)
}

console.log(`Starting wrangler dev on port ${port} (inspector ${inspectorPort})...`)
let output = ''
const wranglerBin = join(repoRoot, 'node_modules', '.bin', 'wrangler')
const wrangler = spawn(wranglerBin, ['dev', '--port', `${port}`, '--inspector-port', `${inspectorPort}`], {
	cwd: here,
	stdio: ['ignore', 'pipe', 'pipe'],
})
wrangler.stdout.on('data', (chunk) => (output += chunk.toString()))
wrangler.stderr.on('data', (chunk) => (output += chunk.toString()))

const stopWrangler = () => {
	if (wrangler.exitCode === null) {
		wrangler.kill('SIGTERM')
		setTimeout(() => {
			if (wrangler.exitCode === null) wrangler.kill('SIGKILL')
		}, 3000).unref()
	}
}
process.on('exit', stopWrangler)

const waitForReady = async () => {
	for (let attempt = 0; attempt < 60; attempt++) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })
			if ((await response.text()) === 'ok') return true
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 500))
	}
	return false
}

if (!(await waitForReady())) {
	fail(`wrangler dev did not become ready.\n--- captured output ---\n${output}`)
	process.exit(1)
}
console.log('Server ready, running WebSocket client...')

const stats = await new Promise((resolve) => {
	let opens = 0
	let closes = 0
	let echoes = 0
	const closeCodes = {}
	const start = Date.now()

	const connect = () => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
		ws.onopen = () => {
			opens++
			ws.send('ping')
		}
		ws.onmessage = () => {
			echoes++
			setTimeout(() => {
				try {
					ws.send('ping')
				} catch {}
			}, echoIntervalMs)
		}
		ws.onclose = (event) => {
			closes++
			closeCodes[event.code] = (closeCodes[event.code] ?? 0) + 1
			console.log(`[client] close code=${event.code} at +${Date.now() - start}ms`)
			if (Date.now() - start < clientDurationMs) setTimeout(connect, 300)
		}
		ws.onerror = () => {}
	}

	connect()
	// Copy closeCodes: the socket's shutdown close (when wrangler is killed below) would
	// otherwise mutate the reported object after the snapshot.
	setTimeout(() => resolve({ opens, closes, echoes, closeCodes: { ...closeCodes } }), clientDurationMs + 500)
})

stopWrangler()
await new Promise((resolve) => setTimeout(resolve, 500))

console.log(`\nClient stats: ${JSON.stringify(stats)}`)
const exporterLines = (output.match(/\[exporter\] exported/g) ?? []).length
console.log(`Exporter invocations observed: ${exporterLines}`)

if (stats.opens !== 1 || stats.closes !== 0) {
	fail(
		`WebSocket did not survive: opens=${stats.opens} closes=${stats.closes} codes=${JSON.stringify(stats.closeCodes)}`,
	)
}
if (stats.echoes < 10) {
	fail(`Too few echoes: ${stats.echoes} (expected >= 10 over ${clientDurationMs}ms)`)
}
if (exporterLines < 10) {
	fail(`Spans were not exported (only ${exporterLines} exporter invocations) — the DX-1128 export fix regressed.`)
}
for (const pattern of [/Fatal uncaught kj::Exception/i, /different request context/i, /was not ended properly/i]) {
	if (pattern.test(output)) {
		fail(`wrangler output matched forbidden pattern ${pattern}`)
	}
}

if (process.exitCode) {
	console.error(`\n--- captured wrangler output ---\n${output}`)
} else {
	console.log('\nPASS: WebSocket survived, spans exported, no fatal kj exceptions or cross-request warnings.')
}
