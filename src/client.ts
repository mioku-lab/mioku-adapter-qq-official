import type { Driver, Logger } from 'mioku'
import type { TokenManager } from './token'

/** 官方错误码的可读翻译,未收录时回退原始 message */
const ERROR_MESSAGES: Record<string, string> = {
  '22006': '消息类型与内容不匹配',
  '304004': '无权限使用该 ARK 模板',
  '304036': '无 Markdown 模板权限',
  '304061': '消息内容无效',
  '304080': '文件信息无效',
  '304103': '消息 ID 已过期,不能回复',
  '305007': '键盘样式参数错误',
  '340069': '消息类型无效',
  '40034004': '富媒体信息转存失败',
  '40034005': '回复消息 msg_id 已过期',
  '40034006': '消息内容违规',
  '40034008': 'markdown 参数有空值',
  '40034009': 'markdown 参数有换行符',
  '40034010': '模板参数中不能含有 markdown 语法',
  '40034011': '无效的 markdown 内容',
  '40034024': 'msg_id 无效或越权',
  '40034025': 'event_id 无效',
  '40034026': 'event_id 已过期',
  '40034027': '该事件不支持回复消息',
  '40034029': '内联键盘行/列超限(最多 5 行 x 5 个)',
  '40034100': '主动消息超过频控限制',
  '40034101': '机器人非群成员',
  '40034105': '主动消息发送失败,无权限',
  '40034106': '消息不支持该指令类型',
  '40034108': '指令参数长度超限',
  '40034109': '指令参数解析失败',
  '40034122': '召回消息已达区间上限',
  '40034123': '该消息不支持召回',
  '40034124': 'markdown 消息参数错误',
  '40034127': '无 markdown 模板权限',
  '40034128': '被动回复时间或次数超限',
  '40054002': '机器人被禁言',
  '40054003': '机器人不是群成员',
  '40054004': '无好友关系',
  '40054005': '消息被去重(msg_seq 重复)',
  '40054007': '消息长度超限',
  '40054010': '不允许发送 URL(域名未加入消息 URL 白名单)',
  '40054016': '机器人已下线',
  '50037': 'markdown 消息只支持 markdown/keyboard 组合',
  '50056': '不允许发送 markdown content',
  '50055001': '消息发送异常,请稍后重试',
  '50055006': 'ARK 消息发送异常,请稍后重试',
}

export class QQApiError extends Error {
  constructor(
    readonly code: number | string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'QQApiError'
  }
}

interface ApiResponseShape {
  err_code?: number | string
  code?: number | string
  message?: string
  msg?: string
  data?: unknown
  [key: string]: unknown
}

export class QQClient {
  constructor(
    private readonly driver: Driver,
    private readonly apiBase: string,
    private readonly token: TokenManager,
    private readonly logger: Logger,
  ) {}

  get base(): string {
    return this.apiBase
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      let status = 0
      let text = ''
      try {
        const res = await this.driver.http.request({
          method,
          url: `${this.apiBase}${path}`,
          headers: {
            Authorization: `QQBot ${await this.token.get()}`,
            ...(body !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          timeout: 20_000,
        })
        status = res.status
        text = res.text()
      } catch (err) {
        lastError = err
        break
      }

      let data: ApiResponseShape | undefined
      try {
        data = text ? (JSON.parse(text) as ApiResponseShape) : undefined
      } catch {
        data = undefined
      }

      if (status === 401 && attempt === 0) {
        this.token.invalidate()
        continue
      }

      const errCode = data?.err_code ?? data?.code
      const failed =
        status < 200 || status >= 300 || (errCode != null && Number(errCode) !== 0)
      if (failed) {
        const code = errCode ?? status
        const rawMessage = data?.message ?? data?.msg ?? text.slice(0, 300)
        const known = ERROR_MESSAGES[String(code)]
        throw new QQApiError(
          code,
          known ? `官方接口错误 ${code}: ${known}` : `官方接口错误 ${code}: ${rawMessage}`,
          status,
        )
      }

      if (
        data &&
        typeof data === 'object' &&
        'data' in data &&
        data.data != null &&
        ('err_code' in data || 'code' in data)
      ) {
        return data.data as T
      }
      return data as T
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body ?? {})
  }

  async delete(path: string): Promise<void> {
    await this.request<unknown>('DELETE', path)
  }

  logRequestError(scope: string, err: unknown): void {
    if (err instanceof QQApiError) {
      this.logger.warn(`${scope} 失败: ${err.message}`)
    } else {
      this.logger.warn(`${scope} 失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
