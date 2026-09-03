interface MessageRecord {
  /** 引用索引(REFIDX),发送 message_reference 用 */
  refIdx?: string
  /** 撤回用的 API 路径前缀,如 /v2/groups/{group_openid} */
  base?: string
  time: number
}

const TTL_MS = 3_600_000
const MAX_SIZE = 4096

/** 已见消息的元数据索引:msg_id → 引用索引 / 撤回路径 */
export class MessageStore {
  private map = new Map<string, MessageRecord>()

  set(id: string, patch: Partial<Omit<MessageRecord, 'time'>>): void {
    if (!id) return
    if (this.map.size >= MAX_SIZE) {
      const now = Date.now()
      for (const [key, record] of this.map) {
        if (now - record.time > TTL_MS) this.map.delete(key)
      }
      if (this.map.size >= MAX_SIZE) {
        const first = this.map.keys().next().value
        if (first != null) this.map.delete(first)
      }
    }
    const existing = this.map.get(id)
    this.map.set(id, { ...existing, ...patch, time: Date.now() })
  }

  getRef(id: string): string | undefined {
    return this.map.get(id)?.refIdx
  }

  getBase(id: string): string | undefined {
    return this.map.get(id)?.base
  }

  clear(): void {
    this.map.clear()
  }
}
