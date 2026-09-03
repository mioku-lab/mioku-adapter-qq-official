import type { Driver, Logger } from 'mioku'
import type { QQClient } from './client'
import type { TokenManager } from './token'

const OP_DISPATCH = 0
const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_RESUME = 6
const OP_RECONNECT = 7
const OP_INVALID_SESSION = 9
const OP_HELLO = 10
const OP_HEARTBEAT_ACK = 11

export interface GatewayDispatch {
  /** 事件类型,如 GROUP_AT_MESSAGE_CREATE / READY */
  readonly t: string
  readonly d: unknown
  /** 事件 ID(平台全局唯一),用于被动回复与去重 */
  readonly id?: string
  readonly seq?: number
}

export interface QQGatewayOptions {
  driver: Driver
  client: QQClient
  token: TokenManager
  intents: number
  logger: Logger
  reconnect: boolean
  reconnectInterval: number
  maxReconnectAttempts: number
  maxReconnectInterval: number
}

export interface QQGatewayHandlers {
  onDispatch(dispatch: GatewayDispatch): Promise<void> | void
  onDisconnect(reason: string): Promise<void> | void
}

interface WsPayload {
  op: number
  d?: unknown
  s?: number
  t?: string
  id?: string
}

const intentsLabel = (intents: number): string => `intents:${intents}`

export class QQGateway {
  readonly name: string

  private readonly options: QQGatewayOptions
  private conn: import('mioku').WebSocketConnection | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatAcked = true
  private heartbeatInterval = 30_000
  private lastSeq: number | null = null
  private sessionId: string | null = null
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(
    options: QQGatewayOptions,
    private readonly handlers: QQGatewayHandlers,
  ) {
    this.name = `${options.client.base}#${intentsLabel(options.intents)}`
    this.options = options
  }

  async start(): Promise<void> {
    this.stopped = false
    try {
      await this.connect()
    } catch (err) {
      // 首次连接失败(网络/凭证/IP 白名单)不阻塞启动,转重连
      this.options.logger.warn(
        `首次连接失败: ${err instanceof Error ? err.message : String(err)},转入重连流程`,
      )
      this.scheduleReconnect()
    }
  }

  async stop(reason?: string): Promise<void> {
    this.stopped = true
    this.clearHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const conn = this.conn
    this.conn = null
    if (conn) {
      try {
        await conn.close(1000, reason ?? 'adapter stop')
      } catch {
        // ignore
      }
    }
  }

  private async connect(): Promise<void> {
    const { client, logger } = this.options
    const { url } = await client.get<{ url: string }>('/gateway')
    logger.info(`连接官方网关: ${url}`)
    const conn = await this.options.driver.websocket.connect(url, { connectTimeout: 15_000 })
    this.conn = conn
    conn.onMessage((data) => {
      this.onMessage(data).catch((err) =>
        logger.warn(`处理网关消息失败: ${err instanceof Error ? err.message : String(err)}`),
      )
    })
    conn.onClose(({ code, reason }) => {
      this.clearHeartbeat()
      this.conn = null
      if (this.stopped) return
      logger.warn(`官方网关连接断开 (code=${code}, reason=${reason}),准备重连`)
      void this.handlers.onDisconnect(reason)
      this.scheduleReconnect()
    })
    conn.onError((err) => {
      logger.warn(`官方网关连接错误: ${err.message}`)
    })
  }

  private async onMessage(data: string | Uint8Array): Promise<void> {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
    let payload: WsPayload
    try {
      payload = JSON.parse(text) as WsPayload
    } catch {
      return
    }
    const { logger, token } = this.options
    switch (payload.op) {
      case OP_HELLO: {
        const interval = (payload.d as { heartbeat_interval?: number } | undefined)
          ?.heartbeat_interval
        this.heartbeatInterval = typeof interval === 'number' ? interval : 30_000
        this.startHeartbeat()
        const accessToken = await token.get()
        if (this.sessionId) {
          await this.send({
            op: OP_RESUME,
            d: { token: `QQBot ${accessToken}`, session_id: this.sessionId, seq: this.lastSeq ?? 0 },
          })
          logger.info('正在恢复官方网关会话 (resume)')
        } else {
          await this.send({ op: OP_IDENTIFY, d: { token: `QQBot ${accessToken}`, intents: this.options.intents } })
          logger.info('已发送 Identify 鉴权')
        }
        return
      }
      case OP_DISPATCH: {
        if (typeof payload.s === 'number') this.lastSeq = payload.s
        if (payload.t === 'READY') {
          const d = payload.d as { session_id?: string } | undefined
          this.sessionId = d?.session_id ?? null
          this.reconnectAttempts = 0
          logger.info(`官方网关会话就绪: ${this.sessionId}`)
        }
        await this.handlers.onDispatch({
          t: payload.t ?? '',
          d: payload.d,
          id: payload.id,
          seq: payload.s,
        })
        return
      }
      case OP_HEARTBEAT:
        await this.send({ op: OP_HEARTBEAT, d: this.lastSeq })
        return
      case OP_HEARTBEAT_ACK:
        this.heartbeatAcked = true
        return
      case OP_RECONNECT:
        logger.info('服务端要求重连 (op 7)')
        await this.conn?.close(4000, 'server reconnect')
        return
      case OP_INVALID_SESSION:
        logger.warn('会话失效 (op 9),将重新 Identify')
        this.sessionId = null
        this.clearHeartbeat()
        await this.conn?.close(4001, 'invalid session')
        return
      default:
        return
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat()
    this.heartbeatAcked = true
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAcked) {
        this.options.logger.warn('心跳未收到 ACK,强制重连')
        void this.conn?.close(4002, 'heartbeat timeout')
        return
      }
      this.heartbeatAcked = false
      void this.send({ op: OP_HEARTBEAT, d: this.lastSeq })
    }, this.heartbeatInterval)
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private async send(payload: WsPayload): Promise<void> {
    await this.conn?.send(JSON.stringify(payload))
  }

  private scheduleReconnect(): void {
    const { reconnect, reconnectInterval, maxReconnectAttempts, maxReconnectInterval, logger } =
      this.options
    if (this.stopped || !reconnect) return
    if (this.reconnectAttempts >= maxReconnectAttempts) {
      logger.error(`重连次数已达上限 (${maxReconnectAttempts}),停止重连`)
      return
    }
    this.reconnectAttempts += 1
    const delay = Math.min(
      reconnectInterval * 2 ** (this.reconnectAttempts - 1),
      maxReconnectInterval,
    )
    logger.info(`${delay}ms 后进行第 ${this.reconnectAttempts} 次重连`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch((err) => {
        logger.warn(`重连失败: ${err instanceof Error ? err.message : String(err)}`)
        this.scheduleReconnect()
      })
    }, delay)
  }
}
