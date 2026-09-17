// biome-ignore-all lint/suspicious/noMisplacedAssertion: CLI verification shares runtime assertions with the public test.
// biome-ignore-all lint/style/useNamingConvention: Official wire fields and environment keys preserve their names.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

type Snapshot = { pid: number; header: SessionHeader; events: SessionEvent[]; messages: unknown[]; status: string }
const version = '0.1.5-rc.2'

export async function probe(external = false) {
  if (external && !process.env.DEEPSEEK_API_KEY) {
    return { framework: 'UNVERIFIED', hostedModel: 'UNVERIFIED', reason: 'DEEPSEEK_API_KEY is not set' } as const
  }
  const marker = `remember-${randomUUID()}`
  const sessionId = `probe-${randomUUID()}`
  const token = randomUUID()
  const model = external ? process.env.DSH_PROBE_MODEL : 'deepseek-v4-flash'
  if (!model) {
    throw new Error('External mode requires explicit DSH_PROBE_MODEL')
  }
  const require = createRequire(import.meta.url)
  for (const name of ['@deepseek-ai/dsh-sdk-client', '@deepseek-ai/dsh']) {
    assert.equal(JSON.parse(await readFile(require.resolve(`${name}/package.json`), 'utf8')).version, version)
  }
  const root = await mkdtemp(join(tmpdir(), 'dsh-continuation-'))
  const requests: unknown[] = []
  const fixture = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) {
      body += chunk
    }
    const parsed = JSON.parse(body)
    requests.push(parsed)
    const text = `fixture-response-${requests.length}`
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: text, role: 'assistant' }, finish_reason: null, index: 0 }], created: 1, id: `fixture-${requests.length}`, model, object: 'chat.completion.chunk' })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], created: 1, id: `fixture-${requests.length}`, model, object: 'chat.completion.chunk', usage: { completion_tokens: 2, prompt_tokens: 10, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`
    )
  })
  const processes: DeepSeekHarness[] = []
  try {
    if (!external) {
      await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve))
    }
    const address = fixture.address()
    const baseURL =
      !external && address && typeof address !== 'string'
        ? `http://127.0.0.1:${address.port}`
        : 'https://api.deepseek.com'
    const patch = join(root, 'probe.patch.yml')
    await writeFile(
      patch,
      JSON.stringify([
        { config: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL, thinking: 'disabled' }, id: 'llm-deepseek' },
        { insert: [{ id: 'probe-control', name: fileURLToPath(new URL('./control.ts', import.meta.url)) }] }
      ])
    )
    const launch = async (phase: number) => {
      const addressFile = join(root, `address-${phase}.json`)
      const harness = new DeepSeekHarness({
        cwd: root,
        dshHome: join(root, 'home'),
        env: {
          DEEPSEEK_API_KEY: external ? process.env.DEEPSEEK_API_KEY : 'local-fixture-only',
          DSH_PROBE_ADDRESS: addressFile,
          DSH_PROBE_AUDIT: join(root, `audit-${phase}.json`),
          DSH_PROBE_MODEL: model,
          DSH_PROBE_TOKEN: token,
          HOME: root,
          NODE_OPTIONS: `--import=${new URL('./audit.ts', import.meta.url).href}`,
          PATH: process.env.PATH
        },
        initializeTimeoutMs: 30_000,
        model,
        patches: [patch],
        processCwd: root,
        profile: 'sdk-minimal',
        provider: 'deepseek-official',
        requestTimeoutMs: 30_000
      })
      processes.push(harness)
      await harness.start()
      let control: { port: number; pid: number } | undefined
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          control = JSON.parse(await readFile(addressFile, 'utf8'))
          break
        } catch {
          await delay(20)
        }
      }
      assert(control, 'Control plugin did not become ready')
      const call = (path: string, method = 'GET', auth: string = token) =>
        fetch(`http://127.0.0.1:${control.port}${path}`, {
          headers: { authorization: `Bearer ${auth}` },
          method,
          signal: AbortSignal.timeout(30_000)
        })
      return { call, harness, pid: control.pid }
    }
    const first = await launch(1)
    assert.equal((await first.call(`/snapshot?id=${sessionId}`, 'GET', 'invalid')).status, 401)
    const initial = await bounded(first.harness.run(`Remember this marker: ${marker}. Reply briefly.`, { sessionId }))
    assert(initial.finalResponse.length > 0, 'First run did not produce assistant text')
    assert(initial.events.some((event) => event.type === 'turn/end' && event.data.reason.kind === 'completed'))
    const beforeResponse = await first.call(`/snapshot?id=${sessionId}`)
    assert.equal(beforeResponse.status, 200)
    const before = (await beforeResponse.json()) as Snapshot
    assert.equal(before.header.id, sessionId)
    assert(JSON.stringify(before.messages).includes(marker))
    await first.harness.close()
    assert.throws(() => process.kill(first.pid, 0), { code: 'ESRCH' }, 'First runtime must exit before resume')

    const second = await launch(2)
    assert.notEqual(first.pid, second.pid)
    assert.equal((await second.call('/resume?id=missing-probe-session', 'POST')).status, 409)
    assert.equal((await second.call('/snapshot?id=missing-probe-session')).status, 409)
    const resumedResponse = await second.call(`/resume?id=${sessionId}`, 'POST')
    assert.equal(resumedResponse.status, 200, 'Native resume failed')
    const resumed = (await resumedResponse.json()) as Snapshot
    assert.deepEqual(resumed.header, { delegationDepth: 0, ...before.header }, 'Native header changed')
    assert.deepEqual(resumed.events.slice(0, before.events.length), before.events, 'History prefix changed')
    assert.deepEqual(resumed.messages, before.messages, 'Model history changed')
    assert.equal(resumed.status, 'idle', 'Resume unexpectedly started execution')
    assert(
      !resumed.events.slice(before.events.length).some((event) => event.type === 'turn/start'),
      'Resume replayed a turn'
    )
    if (!external) {
      assert.equal(requests.length, 1, 'Resume replayed a model request')
    }
    const completedResponse = await second.call(
      `/run?id=${sessionId}&text=${encodeURIComponent('Recall the marker from the previous turn and reply briefly.')}`,
      'POST'
    )
    assert.equal(completedResponse.status, 200)
    const completed = (await completedResponse.json()) as Snapshot
    assert.equal(completed.header.id, sessionId)
    assert(completed.events.length > resumed.events.length)
    assert(completed.events.slice(resumed.events.length).some((event) => event.type === 'assistant/message'))
    assert(
      completed.events
        .slice(resumed.events.length)
        .some((event) => event.type === 'turn/end' && event.data.reason.kind === 'completed')
    )
    if (!external) {
      assert.equal(requests.length, 2, 'Expected exactly two model requests')
      assert(JSON.stringify(requests[1]).includes(marker), 'Second model request lost original history')
      assert(JSON.stringify(requests[1]).includes('fixture-response-1'), 'Second request lost original assistant reply')
    }
    await second.harness.close()
    assert.throws(() => process.kill(second.pid, 0), { code: 'ESRCH' }, 'Second runtime must exit')
    for (const phase of [1, 2]) {
      const audit = JSON.parse(await readFile(join(root, `audit-${phase}.json`), 'utf8'))
      assert.equal(audit.clean, true, 'SDK stdout was polluted')
      assert(audit.frames > 0)
    }
    return {
      framework: 'PASS',
      historyRetained: true,
      hostedModel: external ? 'PASS' : 'UNVERIFIED',
      missingRejected: true,
      modelRequests: external ? undefined : requests.length,
      processIds: [first.pid, second.pid],
      stdoutClean: true,
      unauthorizedRejected: true,
      version
    } as const
  } finally {
    await Promise.all(processes.map((harness) => harness.close()))
    fixture.closeAllConnections()
    if (fixture.listening) {
      await new Promise<void>((resolve) => fixture.close(() => resolve()))
    }
    await rm(root, { force: true, recursive: true })
  }
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Probe run timeout')), 30_000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await probe(process.argv.includes('--external')), null, 2)}\n`)
  } catch {
    process.stderr.write(
      'DSH probe FAILED; no acceptance claim. Upstream diagnostics withheld to avoid disclosing credentials.\n'
    )
    process.exitCode = 1
  }
}
