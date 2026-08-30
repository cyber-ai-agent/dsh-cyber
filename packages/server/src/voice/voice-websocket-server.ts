import { randomUUID } from 'node:crypto'
import type { Server as HttpServer, IncomingMessage } from 'node:http'

import { WebSocket, WebSocketServer } from 'ws'

import { assertApplicationAccess } from '../http/application-access-guard.js'
import { assertLocalRequest } from '../http/security.js'
import type { ApplicationAccessService } from '../services/application-access-service.js'
import { VoiceSessionManager, type VoiceSessionEvent } from './voice-session-manager.js'

export interface VoiceWebSocketRuntime { close(): Promise<void> }

export function attachVoiceWebSocket(input: {
  server: HttpServer
  stateRoot: string
  applicationAccess: ApplicationAccessService
}): VoiceWebSocketRuntime {
  const manager = new VoiceSessionManager(input.stateRoot)
  const sockets = new Map<string, WebSocket>()
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  const unsubscribe = manager.onEvent((event) => forward(event, sockets))

  const onUpgrade = (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    void (async () => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      if (pathname !== '/api/voice/session') { socket.destroy(); return }
      assertLocalRequest(request)
      await assertApplicationAccess(input.applicationAccess, request)
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => webSocketServer.emit('connection', webSocket, request))
    })().catch(() => socket.destroy())
  }
  input.server.on('upgrade', onUpgrade)

  webSocketServer.on('connection', (socket) => {
    let sessionId: string | undefined
    socket.on('message', (data, binary) => {
      try {
        if (binary) {
          if (sessionId === undefined) throw new Error('Voice session has not started')
          const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
          if (frame.length < 10 || (frame.length - 8) % 2 !== 0) throw new Error('Invalid PCM frame')
          const pcm = new Int16Array((frame.length - 8) / 2)
          for (let index = 0; index < pcm.length; index += 1) pcm[index] = frame.readInt16LE(8 + index * 2)
          manager.pushAudio(sessionId, pcm, frame.readDoubleLE(0))
          return
        }
        const command = parseCommand(String(data))
        if (command.type === 'prepare') {
          void manager.prepare().then(() => send(socket, { type: 'prepared' })).catch((error: unknown) => send(socket, { type: 'error', message: errorText(error) }))
          return
        }
        if (command.type === 'start') {
          if (sessionId !== undefined) manager.cancel(sessionId)
          sessionId = randomUUID(); sockets.set(sessionId, socket)
          manager.start(sessionId, command.endpointSilenceMs)
          send(socket, { type: 'session-started', sessionId })
          return
        }
        if (sessionId === undefined) return
        if (command.type === 'stop') manager.stop(sessionId)
        else manager.cancel(sessionId)
      } catch (error) { send(socket, { type: 'error', message: errorText(error) }) }
    })
    socket.on('close', () => {
      if (sessionId !== undefined) { sockets.delete(sessionId); manager.cancel(sessionId) }
    })
  })

  return {
    async close() {
      input.server.off('upgrade', onUpgrade)
      unsubscribe()
      for (const socket of webSocketServer.clients) socket.close(1001, 'Voice runtime stopped')
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()))
      await manager.close()
    },
  }
}

function parseCommand(raw: string): { type: 'prepare' } | { type: 'start'; endpointSilenceMs: number } | { type: 'stop' | 'cancel' } {
  const value = JSON.parse(raw) as Record<string, unknown>
  if (value.type === 'prepare' || value.type === 'stop' || value.type === 'cancel') return { type: value.type }
  if (value.type === 'start') {
    const endpoint = typeof value.endpointSilenceMs === 'number' ? value.endpointSilenceMs : 650
    return { type: 'start', endpointSilenceMs: Math.max(450, Math.min(900, endpoint)) }
  }
  throw new Error('Unsupported voice command')
}

function forward(event: VoiceSessionEvent, sockets: Map<string, WebSocket>): void {
  if (event.sessionId === undefined) return
  const socket = sockets.get(event.sessionId)
  if (socket === undefined) return
  send(socket, event)
  if (event.type === 'stopped' || event.type === 'cancelled') sockets.delete(event.sessionId)
}

function send(socket: WebSocket, value: object): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value))
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
