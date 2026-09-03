import type {
  AdapterBotBase,
  BotBase,
  ForwardNode,
  FriendInfo,
  GroupInfo,
  HistoryMessage,
  Logger,
  MemberInfo,
  MessageGetResult,
  MessageInput,
  MessageTarget,
  SentMessage,
} from 'mioku'

import { buildKeyboard, buildSendUnits, degradeMarkdown, shouldDegrade, type SendUnit } from './payload'
import type { QQClient } from './client'
import type { MediaUploader } from './media'
import type { MessageStore } from './store'
import type { PassiveManager, PassiveKey } from './passive'
import type { QQOfficialInstanceConfig } from './config'

export interface QQOfficialBotData {
  bot_id: string
  readonly adapter: 'qq-official'
  nickname: string
  online: boolean
  connected_at?: number
}

export type QQOfficialBot = BotBase & {
  readonly adapter: 'qq-official'
  /** 直接调用官方 OpenAPI:action 为 API 路径(如 /v2/groups/{id}/messages) */
  sendApi<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T>
  as<T extends object = Record<string, unknown>>(): T
}

declare module 'mioku' {
  interface AdapterBotMap {
    'qq-official': QQOfficialBot
  }
}

export interface QQOfficialBotParams {
  data: QQOfficialBotData
  client: QQClient
  uploader: MediaUploader
  passive: PassiveManager
  refs: MessageStore
  config: QQOfficialInstanceConfig
  logger: Logger
  /** 在群里见过的群,用于 getGroupInfo/getGroupList 降级 */
  groups: Map<string, GroupInfo>
  onSend?: () => void
}

interface ResolvedTarget {
  type: 'group' | 'private'
  uploadType: 'group' | 'user'
  id: string
  base: string
  key: PassiveKey
}

/** 被动回复失效/超限:去掉 msg_id/event_id 转主动消息重发 */
const PASSIVE_EXPIRED_CODES = ['40034128', '40034005', '304103']

const targetOf = (target: MessageTarget): ResolvedTarget | null => {
  if (target.type === 'group' && target.group_id) {
    const id = String(target.group_id)
    return {
      type: 'group',
      uploadType: 'group',
      id,
      base: `/v2/groups/${id}`,
      key: { type: 'group', id },
    }
  }
  if (target.type === 'private' && target.user_id) {
    const id = String(target.user_id)
    return {
      type: 'private',
      uploadType: 'user',
      id,
      base: `/v2/users/${id}`,
      key: { type: 'private', id },
    }
  }
  return null
}

export const createQQBot = (params: QQOfficialBotParams): AdapterBotBase<QQOfficialBot> => {
  const { data, client, uploader, passive, refs, config, logger, groups, onSend } = params

  const warnOnce = (() => {
    const warned = new Set<string>()
    return (feature: string, message: string): void => {
      if (warned.has(feature)) return
      warned.add(feature)
      logger.warn(`[qq-official] ${message}`)
    }
  })()

  const bot: AdapterBotBase<QQOfficialBot> = {
    get bot_id(): string {
      return data.bot_id
    },
    adapter: data.adapter,
    get nickname(): string | undefined {
      return data.nickname
    },
    get online(): boolean {
      return data.online
    },
    get connected_at(): number | undefined {
      return data.connected_at
    },

    async sendMessage(target: MessageTarget, message: MessageInput): Promise<SentMessage> {
      if (!data.online) throw new Error(`Bot ${data.bot_id} 不在线`)
      const resolved = targetOf(target)
      if (!resolved) throw new Error(`不支持的消息目标: ${JSON.stringify(target)}`)

      const { units, refMessageId } = buildSendUnits(message, {
        imageMode: config.imageMode ?? 'markdown',
        logger,
      })
      if (units.length === 0) throw new Error('消息内容为空')

      const unitBody = async (unit: SendUnit): Promise<Record<string, unknown>> => {
        if (unit.kind === 'markdown') {
          const keyboard = buildKeyboard(unit.buttons, data.bot_id, logger)
          return {
            msg_type: 2,
            markdown: {
              content: unit.content,
              ...(config.forceVerifyImageResource ? { force_verify_image_resource: true } : {}),
            },
            ...(keyboard ? { keyboard } : {}),
          }
        }
        const fileInfo = await uploader.upload(
          { type: resolved.uploadType, id: resolved.id },
          unit.file,
          unit.fileType,
        )
        return { msg_type: 7, media: { file_info: fileInfo } }
      }

      const sendRequest = async (body: Record<string, unknown>): Promise<string | undefined> => {
        const res = await client.post<{ id?: string; ext_info?: { ref_idx?: string } }>(
          `${resolved.base}/messages`,
          body,
        )
        if (res?.id) refs.set(res.id, { refIdx: res.ext_info?.ref_idx, base: resolved.base })
        return res?.id
      }

      const passiveEntry = passive.take(resolved.key)
      const refIdx = refMessageId ? refs.getRef(refMessageId) : undefined
      let seq = passiveEntry?.seq
      let passiveActive = passiveEntry != null
      let firstId: string | undefined
      let lastError: unknown

      const passiveFields = (): Record<string, unknown> => {
        if (!passiveActive || !passiveEntry) return {}
        return passiveEntry.kind === 'msg'
          ? { msg_id: passiveEntry.id, msg_seq: seq }
          : { event_id: passiveEntry.id }
      }

      for (const unit of units) {
        try {
          const id = await sendRequest({
            ...passiveFields(),
            ...(refIdx ? { message_reference: { message_id: refIdx } } : {}),
            ...(await unitBody(unit)),
          })
          if (id) firstId ??= id
          onSend?.()
        } catch (err) {
          lastError = err
          const code = String((err as { code?: unknown } | null)?.code ?? '')

          if (passiveActive && PASSIVE_EXPIRED_CODES.includes(code)) {
            passiveActive = false
            try {
              const id = await sendRequest(await unitBody(unit))
              if (id) firstId ??= id
              onSend?.()
              logger.warn(`被动回复已失效(${code}),已转主动消息重发`)
            } catch (retryErr) {
              client.logRequestError('主动消息重发', retryErr)
            }
          } else if (unit.kind === 'markdown' && shouldDegrade(err)) {
            try {
              const id = await sendRequest({
                ...passiveFields(),
                msg_type: 0,
                content: degradeMarkdown(unit.content),
              })
              if (id) firstId ??= id
              onSend?.()
              logger.warn(`markdown 发送失败,已降级为纯文本: ${err instanceof Error ? err.message : String(err)}`)
            } catch (fallbackErr) {
              client.logRequestError('降级发送', fallbackErr)
            }
          } else {
            client.logRequestError('消息单元发送', err)
          }
        }
        if (passiveActive && seq != null) seq += 1
      }

      if (firstId === undefined && units.length > 0) {
        throw lastError instanceof Error ? lastError : new Error('消息发送失败')
      }
      return { message_id: firstId }
    },

    async sendApi<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T> {
      return client.post<T>(action, params ?? {})
    },

    async recallMessage(messageId: string): Promise<void> {
      const base = refs.getBase(String(messageId))
      if (!base) throw new Error(`无法撤回:未知的消息 ${messageId}`)
      await client.delete(`${base}/messages/${messageId}`)
    },

    async getMessage(): Promise<MessageGetResult | null> {
      warnOnce('message.get', '官方通道不支持获取单条消息,返回 null')
      return null
    },

    async getForwardMessage(): Promise<ForwardNode[]> {
      warnOnce('message.getforward', '官方通道不支持获取合并转发内容,返回空')
      return []
    },

    async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
      return groups.get(String(groupId)) ?? null
    },

    async getGroupList(): Promise<GroupInfo[]> {
      return [...groups.values()]
    },

    async getGroupMembers(): Promise<MemberInfo[]> {
      warnOnce('group.getmembers', '官方通道不支持获取群成员列表,返回空')
      return []
    },

    async getMemberInfo(): Promise<MemberInfo | null> {
      warnOnce('member.getinfo', '官方通道不支持获取成员信息,返回 null')
      return null
    },

    async banMember(): Promise<void> {
      warnOnce('member.ban', '官方通道不支持群禁言,已忽略')
    },

    async kickMember(): Promise<void> {
      warnOnce('member.kick', '官方通道不支持踢出成员,已忽略')
    },

    async setMemberCard(): Promise<void> {
      warnOnce('member.setcard', '官方通道不支持设置群名片,已忽略')
    },

    async setMemberAdmin(): Promise<void> {
      warnOnce('member.setadmin', '官方通道不支持设置管理员,已忽略')
    },

    async setMemberTitle(): Promise<void> {
      warnOnce('member.settitle', '官方通道不支持设置头衔,已忽略')
    },

    async pokeMember(): Promise<void> {
      warnOnce('member.poke', '官方通道不支持戳一戳,已忽略')
    },

    async setGroupName(): Promise<void> {
      warnOnce('group.setname', '官方通道不支持修改群名,已忽略')
    },

    async setGroupWholeBan(): Promise<void> {
      warnOnce('group.wholeban', '官方通道不支持全员禁言,已忽略')
    },

    async setGroupPortrait(): Promise<void> {
      warnOnce('group.portrait', '官方通道不支持设置群头像,已忽略')
    },

    async leaveGroup(): Promise<void> {
      warnOnce('group.leave', '官方通道不支持退出群聊,已忽略')
    },

    async getFriendInfo(): Promise<null> {
      warnOnce('friend.getinfo', '官方通道不支持获取好友信息,返回 null')
      return null
    },

    async getFriendList(): Promise<FriendInfo[]> {
      warnOnce('friend.getlist', '官方通道不支持获取好友列表,返回空')
      return []
    },

    async deleteFriend(): Promise<void> {
      warnOnce('friend.delete', '官方通道不支持删除好友,已忽略')
    },

    async setProfile(): Promise<void> {
      warnOnce('profile.set', '官方通道不支持修改资料,已忽略')
    },

    async setAvatar(): Promise<void> {
      warnOnce('avatar.set', '官方通道不支持修改头像,已忽略')
    },

    async getHistory(): Promise<HistoryMessage[]> {
      warnOnce('conversation.history', '官方通道不支持获取历史消息,返回空')
      return []
    },

    async getStatus() {
      return {
        online: data.online,
        app_name: 'QQ 开放平台',
        protocol_version: 'v2',
      }
    },

    as<T extends object = Record<string, unknown>>(): T {
      return this as unknown as T
    },
  }

  return bot
}
