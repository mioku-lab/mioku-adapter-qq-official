export interface PassiveKey {
  type: 'group' | 'private'
  id: string
}

export interface PassiveEntry {
  /** msg: 消息被动回复(msg_id) / event: 事件被动回复(event_id) */
  kind: 'msg' | 'event'
  id: string
  seq: number
  expiresAt: number
}

/**
 * 被动回复窗口管理:记录每个会话最近一次可被回复的 msg_id/event_id,
 * 发送时命中窗口内就按被动消息发送(自动占用 msg_seq),窗口外或次数用尽则走主动消息。
 */
export class PassiveManager {
  private entries = new Map<string, PassiveEntry>()

  constructor(
    private readonly windowMs = 300_000,
    private readonly maxReplies = 5,
  ) {}

  record(key: PassiveKey, id: string, kind: 'msg' | 'event' = 'msg'): void {
    if (!id) return
    this.entries.set(this.keyOf(key), {
      kind,
      id,
      seq: 0,
      expiresAt: Date.now() + this.windowMs,
    })
  }

  take(key: PassiveKey): PassiveEntry | undefined {
    const mapKey = this.keyOf(key)
    const entry = this.entries.get(mapKey)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt || entry.seq >= this.maxReplies) {
      this.entries.delete(mapKey)
      return undefined
    }
    entry.seq += 1
    return entry
  }

  clear(): void {
    this.entries.clear()
  }

  private keyOf(key: PassiveKey): string {
    return `${key.type}:${key.id}`
  }
}
