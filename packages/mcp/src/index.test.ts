import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect, test } from 'vitest'

import { Mcp } from './index'

const fixture = resolve(import.meta.dirname, '../test/server.fixture.ts')
test('discovers and calls a real stdio peer, protects credentials, and closes owned connections', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-'))
  const mcp = await Mcp.open(directory)
  process.env.MCP_TEST_SECRET = 'private-fixture-value'
  try {
    const config = await mcp.create({
      args: [fixture],
      command: process.execPath,
      env: { MCP_TEST_SECRET: 'MCP_TEST_SECRET' },
      name: 'tools',
      transport: 'stdio'
    })
    await mcp.bind('p', config.id, true)
    expect(JSON.stringify(await mcp.list())).not.toContain('private-fixture-value')
    const connection = await mcp.connect('p')
    expect(connection.tools.map(({ name }) => name)).toEqual(['echo'])
    expect(JSON.stringify(await connection.callTool('echo', { text: 'hello' }))).toContain('hello')
    expect(JSON.stringify(await connection.callTool('echo', {}))).not.toContain('private-fixture-value')
    await expect(connection.callTool('echo', { fail: true })).rejects.toMatchObject({
      code: 'MCP_CALL_FAILED',
      message: 'MCP tool call failed'
    })
    await connection.close()
    await expect(connection.callTool('echo', {})).rejects.toMatchObject({ code: 'DISPOSED' })
    await mcp.bind('p', config.id, false)
    expect((await mcp.connect('p')).tools).toEqual([])
    const reopened = await Mcp.open(directory)
    expect(await reopened.enabled('p')).toEqual([])
    await reopened.delete(config.id)
    expect(await reopened.list()).toEqual([])
    await reopened.dispose()
  } finally {
    delete process.env.MCP_TEST_SECRET
    await mcp.dispose()
    await rm(directory, { force: true, recursive: true })
  }
})

test('reports conflicts and timeouts and releases failed preparation resources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-failure-'))
  const mcp = await Mcp.open(directory)
  try {
    const first = await mcp.create({
      args: [fixture],
      command: process.execPath,
      name: 'first',
      timeoutMs: 1000,
      transport: 'stdio'
    })
    const second = await mcp.create({ args: [fixture], command: process.execPath, name: 'second', transport: 'stdio' })
    await mcp.bind('p', first.id, true)
    await mcp.bind('p', second.id, true)
    await expect(mcp.connect('p')).rejects.toMatchObject({ code: 'TOOL_CONFLICT' })
    await mcp.bind('p', second.id, false)
    const connection = await mcp.connect('p')
    const result = await connection.callTool('echo', {})
    const content = result.content[0]
    if (content?.type !== 'text') {
      throw new Error('Missing text')
    }
    const { pid } = JSON.parse(content.text) as { pid: number }
    await expect(connection.callTool('echo', { wait: true })).rejects.toMatchObject({ code: 'MCP_TIMEOUT' })
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      })
      .toBe(true)
    const stuck = await mcp.create({
      args: [
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], String(process.pid));process.stdin.resume();setInterval(()=>{},1000)',
        join(directory, 'stuck.pid')
      ],
      command: process.execPath,
      name: 'stuck',
      timeoutMs: 100,
      transport: 'stdio'
    })
    await expect(mcp.probe(stuck.id)).rejects.toMatchObject({ code: 'MCP_TIMEOUT' })
    const stuckPid = Number(await readFile(join(directory, 'stuck.pid'), 'utf8'))
    expect(() => process.kill(stuckPid, 0)).toThrow()
  } finally {
    await mcp.dispose()
    await rm(directory, { force: true, recursive: true })
  }
}, 15000)
