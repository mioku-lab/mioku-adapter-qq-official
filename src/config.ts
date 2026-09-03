export interface QQOfficialInstanceConfig {
  appId: string
  appSecret: string
  /** 沙箱环境(https://sandbox.api.sgroup.qq.com) */
  sandbox?: boolean
  /** 覆盖 OpenAPI base URL */
  apiBase?: string
  /** 覆盖订阅 intents(默认 群/单聊事件 + 交互事件) */
  intents?: number
  /**
   * 图片发送方式:
   * - markdown:图片嵌入 markdown 单卡片发送,要求图片 URL 公网可访问
   * - media:图片作为独立富媒体消息发送(base64 上传),无公网要求
   */
  imageMode?: 'markdown' | 'media'
  /** markdown 图片转存失败时是否报错中断 */
  forceVerifyImageResource?: boolean
  /** 被动回复窗口毫秒数(官方 5 分钟) */
  passiveWindowMs?: number
  /** 同一条消息最多被动回复次数(官方 5 次) */
  maxPassiveReplies?: number
  reconnect?: boolean
  reconnectInterval?: number
  maxReconnectAttempts?: number
  maxReconnectInterval?: number
}

export interface QQOfficialAdapterConfig {
  instances: ReadonlyArray<QQOfficialInstanceConfig>
}

export const DEFAULT_INSTANCE: Required<Omit<QQOfficialInstanceConfig, 'appId' | 'appSecret' | 'apiBase' | 'intents'>> = {
  sandbox: false,
  imageMode: 'markdown',
  forceVerifyImageResource: false,
  passiveWindowMs: 300_000,
  maxPassiveReplies: 5,
  reconnect: true,
  reconnectInterval: 1000,
  maxReconnectAttempts: Infinity,
  maxReconnectInterval: 30_000,
}

export const API_BASE = 'https://api.bot.qq.com'
export const SANDBOX_API_BASE = 'https://sandbox.api.sgroup.qq.com'
export const TOKEN_URL = `${API_BASE}/app/getAppAccessToken`

/** GROUP_AND_C2C_EVENT(1<<25) | INTERACTION(1<<26) */
export const DEFAULT_INTENTS = (1 << 25) | (1 << 26)

export const normalizeInstances = (input: unknown): QQOfficialInstanceConfig[] => {
  if (!input) return []
  if (Array.isArray(input)) {
    return input.filter(
      (item): item is QQOfficialInstanceConfig =>
        typeof item === 'object' && item !== null && !Array.isArray(item),
    )
  }
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>
    if (Array.isArray(obj.instances)) return normalizeInstances(obj.instances)
    if ('appId' in obj || 'appSecret' in obj) return [obj as unknown as QQOfficialInstanceConfig]
  }
  return []
}
