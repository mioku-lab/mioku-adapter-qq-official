export interface QQOfficialInstanceConfig {
  appId: string
  appSecret: string
  /** 沙箱环境(https://sandbox.api.sgroup.qq.com) */
  sandbox?: boolean
  /** 覆盖 OpenAPI base URL */
  apiBase?: string
  /** 覆盖订阅 intents(默认 群/单聊事件 + 交互事件 + 群成员事件) */
  intents?: number
  /**
   * 是否订阅群成员变动/入群申请事件(GROUP_MEMBER_EVENT 1<<24)。
   * 该 intent 需要在 QQ 开放平台开通权限,未开通时网关会以 4014 拒绝连接,
   * 适配器会自动去掉该 intent 重连。默认 true
   */
  memberEvents?: boolean
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
  /** 启动时等待网关会话就绪的超时毫秒数,0 表示不等待 */
  readyTimeoutMs?: number
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
  memberEvents: true,
  imageMode: 'markdown',
  forceVerifyImageResource: false,
  passiveWindowMs: 300_000,
  maxPassiveReplies: 5,
  readyTimeoutMs: 15_000,
  reconnect: true,
  reconnectInterval: 1000,
  maxReconnectAttempts: Infinity,
  maxReconnectInterval: 30_000,
}

export const API_BASE = 'https://api.bot.qq.com'
export const SANDBOX_API_BASE = 'https://sandbox.api.sgroup.qq.com'
export const TOKEN_URL = `${API_BASE}/app/getAppAccessToken`

/** GROUP_AND_C2C_EVENT(1<<25) | INTERACTION(1<<26) */
export const BASE_INTENTS = (1 << 25) | (1 << 26)

/** GROUP_MEMBER_EVENT(1<<24):群成员加入/退出/入群申请,需要平台开通权限 */
export const MEMBER_EVENT_INTENT = 1 << 24

export const DEFAULT_INTENTS = BASE_INTENTS | MEMBER_EVENT_INTENT

/** 按实例配置解析最终 intents;memberEvents=false 时不请求群成员事件 */
export const resolveIntents = (config: {
  intents?: number
  memberEvents?: boolean
}): number => {
  if (typeof config.intents === 'number') return config.intents
  return config.memberEvents === false
    ? BASE_INTENTS
    : BASE_INTENTS | MEMBER_EVENT_INTENT
}

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
