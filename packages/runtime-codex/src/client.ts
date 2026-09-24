import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

import { type Json, RuntimeError } from '@qingshaner/runtime'

import { type Frame, parseFrame, parseResult } from './protocol'

const MAX_BYTES = 8 * 1024 * 1024
const STDERR_BYTES = 16 * 1024
interface ClientOptions {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
  shutdownTimeoutMs?: number
}
interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (error: RuntimeError) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * A child-process JSON-RPC transport with bounded frames, buffered writes, and request timeouts.
 */
export class JsonRpcClient {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #options: ClientOptions
  readonly #pending = new Map<string | number, Pending>()
  readonly #frames = new Set<(frame: Frame) => void>()
  readonly #exits = new Set<(error: RuntimeError) => void>()
  readonly #decoder = new StringDecoder('utf8')
  readonly #exited: Promise<void>
  #closePromise?: Promise<void>
  #failure?: RuntimeError
  #nextId = 0
  #partial = ''
  #partialBytes = 0
  #stderr = Buffer.alloc(0)
  #didExit = false
  #queuedBytes = 0
  #writes: Promise<void> = Promise.resolve()

  /**
   * Spawn the configured executable with piped streams and no shell.
   */
  constructor(options: ClientOptions) {
    this.#options = options
    this.#child = spawn(options.command, options.args, {
      env: options.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.#exited = new Promise((resolve) => {
      this.#child.once('close', (code, signal) => {
        this.#didExit = true
        const error =
          this.#failure ?? new RuntimeError('PROCESS_EXITED', `App-server exited (code ${code}, signal ${signal})`)
        this.#fail(error)
        this.#stderr = Buffer.alloc(0)
        for (const listener of this.#exits) {
          listener(error)
        }
        this.#exits.clear()
        this.#frames.clear()
        resolve()
      })
    })
    this.#child.on('error', () => this.#fail(new RuntimeError('PROCESS_EXITED', 'App-server process failed')))
    this.#child.stdin.on('error', () => this.#stop(new RuntimeError('PROCESS_EXITED', 'App-server input failed')))
    this.#child.stdout.on('error', () => this.#stop(new RuntimeError('PROCESS_EXITED', 'App-server output failed')))
    this.#child.stderr.on('error', () => {})
    this.#child.stdout.on('data', (chunk: Buffer) => this.#read(chunk))
    this.#child.stdout.on('end', () => {
      if (!this.#failure && (this.#partialBytes > 0 || this.#decoder.end())) {
        this.#stop(new RuntimeError('PROTOCOL_ERROR', 'Truncated app-server frame'))
      }
    })
    this.#child.stderr.on('data', (chunk: Buffer) => {
      this.#stderr = Buffer.concat([this.#stderr, chunk.subarray(-STDERR_BYTES)]).subarray(-STDERR_BYTES)
    })
  }

  /**
   * Send a request and await its validated response within the configured timeout.
   */
  request(method: string, params: Json): Promise<unknown> {
    if (this.#failure) {
      return Promise.reject(this.#failure)
    }
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new RuntimeError('RPC_TIMEOUT', 'App-server request timed out'))
      }, this.#options.requestTimeoutMs ?? 15_000)
      this.#pending.set(id, { method, reject, resolve, timer })
      void this.#write({ id, method, params }).catch((error) => {
        const pending = this.#pending.get(id)
        if (pending) {
          this.#pending.delete(id)
          clearTimeout(pending.timer)
          reject(error)
        }
      })
    })
  }

  /**
   * Write a notification without waiting for a remote response.
   */
  notify(method: string, params: Json): Promise<void> {
    return this.#write({ method, params })
  }
  /**
   * Write a success response to a native server request.
   */
  reply(id: string | number, result: Json): Promise<void> {
    return this.#write({ id, result })
  }
  /**
   * Write an error response to a native server request.
   */
  replyError(id: string | number, code: number, message: string): Promise<void> {
    return this.#write({ error: { code, message }, id })
  }
  /**
   * Register a listener for validated frames.
   *
   * @returns A function that removes the listener.
   */
  onFrame(listener: (frame: Frame) => void): () => void {
    this.#frames.add(listener)
    return () => {
      this.#frames.delete(listener)
    }
  }
  /**
   * Register a listener for process closure.
   *
   * @returns A function that removes the listener.
   */
  onExit(listener: (error: RuntimeError) => void): () => void {
    this.#exits.add(listener)
    return () => {
      this.#exits.delete(listener)
    }
  }

  /**
   * Reject outstanding requests and shut down the child, escalating to termination if needed.
   */
  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#fail(new RuntimeError('PROCESS_EXITED', 'App-server transport closed'))
      this.#closePromise = this.#shutdown()
    }
    return this.#closePromise
  }

  #fail(error: RuntimeError): void {
    this.#failure ??= error
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(this.#failure)
    }
    this.#pending.clear()
  }

  #stop(error: RuntimeError): void {
    this.#fail(error)
    void this.close()
  }

  async #shutdown(): Promise<void> {
    this.#child.stdin.end()
    if (await this.#waitForExit()) {
      return
    }
    this.#child.kill('SIGTERM')
    if (await this.#waitForExit()) {
      return
    }
    this.#child.kill('SIGKILL')
    await this.#exited
  }

  async #waitForExit(): Promise<boolean> {
    if (this.#didExit) {
      return true
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.#exited.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), this.#options.shutdownTimeoutMs ?? 2000)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  #write(value: Json): Promise<void> {
    if (this.#failure) {
      return Promise.reject(this.#failure)
    }
    let data: string
    try {
      data = `${JSON.stringify(value)}\n`
    } catch {
      return Promise.reject(new RuntimeError('INVALID_INPUT', 'Cannot serialize app-server request'))
    }
    const bytes = Buffer.byteLength(data)
    if (this.#queuedBytes + bytes > MAX_BYTES) {
      const error = new RuntimeError(
        'STREAM_OVERFLOW',
        'App-server write queue exceeded 8 MiB; all shared sessions are affected'
      )
      this.#stop(error)
      return Promise.reject(error)
    }
    this.#queuedBytes += bytes
    const write = this.#writes
      .then(async () => {
        if (this.#failure) {
          throw this.#failure
        }
        await new Promise<void>((resolve, reject) => {
          let callbackComplete = false
          let bufferDrained = false
          const failed = () => {
            cleanup()
            reject(this.#failure ?? new RuntimeError('PROCESS_EXITED', 'App-server input failed'))
          }
          const complete = () => {
            if (callbackComplete && bufferDrained) {
              cleanup()
              resolve()
            }
          }
          const drained = () => {
            bufferDrained = true
            complete()
          }
          const cleanup = () => {
            this.#child.stdin.off('error', failed)
            this.#child.stdin.off('close', failed)
            this.#child.stdin.off('drain', drained)
          }
          this.#child.stdin.once('error', failed)
          this.#child.stdin.once('close', failed)
          bufferDrained = this.#child.stdin.write(data, (error) => {
            if (error) {
              failed()
              return
            }
            callbackComplete = true
            complete()
          })
          if (bufferDrained) {
            complete()
          } else {
            this.#child.stdin.once('drain', drained)
          }
        })
      })
      .finally(() => {
        this.#queuedBytes -= bytes
      })
    this.#writes = write.catch(() => {})
    return write
  }

  #read(chunk: Buffer): void {
    if (this.#failure) {
      return
    }
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset)
      const end = newline < 0 ? chunk.length : newline
      const part = chunk.subarray(offset, end)
      this.#partialBytes += part.length
      if (this.#partialBytes > MAX_BYTES) {
        this.#stop(
          new RuntimeError('STREAM_OVERFLOW', 'App-server frame exceeded 8 MiB; all shared sessions are affected')
        )
        return
      }
      this.#partial += this.#decoder.write(part)
      if (newline < 0) {
        return
      }
      try {
        const line = this.#partial + this.#decoder.end()
        this.#partial = ''
        this.#partialBytes = 0
        const value: unknown = JSON.parse(line)
        const frame = parseFrame(value)
        this.#dispatch(frame)
      } catch {
        this.#stop(new RuntimeError('PROTOCOL_ERROR', 'Invalid app-server protocol frame'))
        return
      }
      if (this.#failure) {
        return
      }
      offset = end + 1
    }
  }

  #dispatch(frame: Frame): void {
    if (frame.kind === 'response') {
      const pending = this.#pending.get(frame.id)
      if (pending) {
        // Validate before removing it: a bad native response must reject this waiter too.
        const result = frame.error ? undefined : parseResult(pending.method, frame.result)
        this.#pending.delete(frame.id)
        clearTimeout(pending.timer)
        if (frame.error) {
          pending.reject(new RuntimeError('RPC_ERROR', `RPC failed (code ${frame.error.code})`))
        } else {
          pending.resolve(result)
        }
        for (const listener of this.#frames) {
          listener(frame)
        }
      }
    } else {
      for (const listener of this.#frames) {
        listener(frame)
      }
    }
  }
}
