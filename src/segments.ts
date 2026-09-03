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

/** 官方消息事件 payload → 核心消息段(content 已去 @bot 前缀;mentions 追加 at 段;语音优先取 wav 转码直链) */
export const buildMessage = (
  payload: QQMessagePayload,
  options: { botId: string },
): Message => {
  const segments: MessageSegment[] = []
  const text = typeof payload.content === 'string' ? payload.content : ''
  if (text) segments.push(new MessageSegmentImpl('text', { text }))

  for (const mention of payload.mentions ?? []) {
    if (!isObject(mention)) continue
    const id = mention.member_openid ?? mention.user_openid ?? mention.id
    if (!id || id === options.botId) continue
    segments.push(new MessageSegmentImpl('at', { target: String(id) }))
  }

  segments.push(...attachmentSegments(payload))

  if (isObject(payload.ark_data)) {
    segments.push(new MessageSegmentImpl('json', { data: JSON.stringify(payload.ark_data) }))
  }

  return createMessage(segments, text)
}

export const senderOf = (payload: QQMessagePayload) => ({
  user_id: userIdOf(payload),
  nickname: payload.author?.username,
  role: roleOf(payload.author?.member_role),
})
