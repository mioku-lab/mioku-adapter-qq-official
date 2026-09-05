import { MessageSegmentImpl, createMessage } from 'mioku'

import type { Message, MessageSegment } from 'mioku'

export interface QQUser {
  id?: string
  username?: string
  user_openid?: string
  member_openid?: string
  member_role?: string
  bot?: boolean
}

export interface QQAttachment {
  url?: string
  filename?: string
  width?: number
  height?: number
  size?: number
  content_type?: string
  voice_wav_url?: string
  asr_refer_text?: string
}

export interface QQMessagePayload {
  id?: string
  author?: QQUser
  content?: string
  group_openid?: string
  user_openid?: string
  timestamp?: string
  message_type?: number
  message_scene?: { source?: string; ext?: string[] }
  attachments?: QQAttachment[]
  mentions?: QQUser[]
  ark_data?: Record<string, unknown>
  msg_elements?: unknown[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 官方内容里的 @ 令牌:<@openid>(全量消息不会去除他人 @ 前缀) */
const MENTION_TOKEN_RE = /<@!?([A-Za-z0-9_-]{4,64})>/g

export const mentionTokensOf = (text: string): string[] =>
  [...text.matchAll(MENTION_TOKEN_RE)].map((m) => m[1])

/** 去掉内容里的 @ 令牌并清理空白(提及信息由 mentions 与令牌本身补回 at 段) */
export const stripMentionTokens = (text: string): string =>
  text
    .replace(MENTION_TOKEN_RE, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()

/** 解析 message_scene.ext 里的 key=value 列表 */
export const parseSceneExt = (payload: QQMessagePayload): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const item of payload.message_scene?.ext ?? []) {
    if (typeof item !== 'string') continue
    const index = item.indexOf('=')
    if (index > 0) result[item.slice(0, index)] = item.slice(index + 1)
  }
  return result
}

const roleOf = (role: string | undefined): 'owner' | 'admin' | 'member' | undefined => {
  if (role === 'owner' || role === 'admin' || role === 'member') return role
  return undefined
}

export const userIdOf = (payload: QQMessagePayload): string => {
  const author = payload.author
  return String(
    author?.member_openid ?? author?.user_openid ?? author?.id ?? payload.user_openid ?? '',
  )
}

const attachmentSegments = (payload: QQMessagePayload): MessageSegment[] => {
  const segments: MessageSegment[] = []
  for (const a of payload.attachments ?? []) {
    if (!isObject(a)) continue
    const contentType = typeof a.content_type === 'string' ? a.content_type : ''
    const url = typeof a.url === 'string' ? a.url : undefined
    if (!url) continue
    const name = typeof a.filename === 'string' ? a.filename : undefined
    const size = typeof a.size === 'number' ? a.size : undefined
    const attachment = { url, name, size }
    if (contentType === 'voice') {
      const wavUrl = typeof a.voice_wav_url === 'string' && a.voice_wav_url ? a.voice_wav_url : url
      segments.push(
        new MessageSegmentImpl('record', { url: wavUrl, sourceUrl: url }, { ...attachment, url: wavUrl }),
      )
    } else if (contentType.startsWith('image/')) {
      segments.push(
        new MessageSegmentImpl(
          'image',
          {
            url,
            width: typeof a.width === 'number' ? a.width : undefined,
            height: typeof a.height === 'number' ? a.height : undefined,
          },
          attachment,
        ),
      )
    } else if (contentType.startsWith('video/')) {
      segments.push(new MessageSegmentImpl('video', { url }, attachment))
    } else {
      segments.push(new MessageSegmentImpl('file', { url, name }, attachment))
    }
  }
  return segments
}

/** 官方消息事件 payload → 核心消息段;按正文出现顺序把 @ 令牌转成 at 段,正文只留纯文本 */
export const buildMessage = (
  payload: QQMessagePayload,
  options: { botId: string },
): Message => {
  const rawText = typeof payload.content === 'string' ? payload.content : ''

  const segments: MessageSegment[] = []
  const mentioned = new Set<string>()

  const pushText = (text: string): void => {
    if (text.length > 0 && text.trim().length > 0) {
      // 保留原始空格,与 onebot 段结构一致({at:xxx} .status)
      segments.push(new MessageSegmentImpl('text', { text }))
    }
  }

  let cursor = 0
  for (const match of rawText.matchAll(MENTION_TOKEN_RE)) {
    const id = match[1]
    pushText(rawText.slice(cursor, match.index))
    if (!mentioned.has(id)) {
      mentioned.add(id)
      segments.push(new MessageSegmentImpl('at', { target: id }))
    }
    cursor = match.index + match[0].length
  }
  pushText(rawText.slice(cursor))

  // mentions 里未出现在正文令牌中的,追加在末尾兜底
  for (const mention of payload.mentions ?? []) {
    if (!isObject(mention)) continue
    const id = mention.member_openid ?? mention.user_openid ?? mention.id
    if (!id || mentioned.has(String(id))) continue
    mentioned.add(String(id))
    segments.push(new MessageSegmentImpl('at', { target: String(id) }))
  }

  segments.push(...attachmentSegments(payload))

  if (isObject(payload.ark_data)) {
    segments.push(new MessageSegmentImpl('json', { data: JSON.stringify(payload.ark_data) }))
  }

  return createMessage(segments, stripMentionTokens(rawText))
}

export const senderOf = (payload: QQMessagePayload) => ({
  user_id: userIdOf(payload),
  nickname: payload.author?.username,
  role: roleOf(payload.author?.member_role),
})
