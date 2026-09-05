import {
  asMessage,
  atOf,
  buildRoutes,
  createFriendRef,
  createGroupRef,
} from "mioku";
import { MessageSegmentImpl, createMessage } from "mioku";

import {
  buildMessage,
  mentionTokensOf,
  parseSceneExt,
  senderOf,
  userIdOf,
} from "./segments";
import type { QQClient } from "./client";
import type { MessageStore } from "./store";
import type { PassiveManager } from "./passive";
import type {
  Logger,
  Message,
  MessageEvent,
  NoticeEvent,
  Bot,
  MessageInput,
  MessageSegment,
} from "mioku";
import type { QQMessagePayload } from "./segments";

export type MessageType =
  | "GROUP_AT_MESSAGE_CREATE"
  | "GROUP_MESSAGE_CREATE"
  | "C2C_MESSAGE_CREATE";

export interface QQInteractionPayload {
  id?: string;
  type?: number;
  scene?: string;
  chat_type?: number;
  timestamp?: string;
  user_openid?: string;
  group_openid?: string;
  group_member_openid?: string;
  data?: {
    type?: number;
    resolved?: {
      button_data?: string;
      button_id?: string;
      user_id?: string;
      message_id?: string;
    };
  };
  application_id?: string;
}

export interface EventBuildParams {
  adapterName: string;
  bot: Bot;
  client: QQClient;
  passive: PassiveManager;
  refs: MessageStore;
  logger: Logger;
  /** 已学习的机器人自身 openid(官方 READY 只给平台 id,@ 令牌用的是 openid 体系) */
  selfOpenids: Set<string>;
}

const timestampOf = (payload: { timestamp?: string }): number | undefined => {
  if (!payload.timestamp) return undefined;
  const ms = Date.parse(payload.timestamp);
  return Number.isFinite(ms) ? ms : undefined;
};

const identityOf = (
  params: EventBuildParams & {
    eventType: string;
    messageId?: string;
    time?: number;
  },
) => ({
  adapter: params.adapterName,
  bot_id: params.bot.bot_id,
  event_type: params.eventType,
  message_id: params.messageId,
  timestamp: params.time,
  native_event_id: params.messageId,
});

const replyOf = (
  params: EventBuildParams & { eventMessageId?: string },
  conversation: { type: "group" | "private"; id: string },
): MessageEvent["reply"] => {
  return async (input, options) => {
    const opts = typeof options === "boolean" ? { quote: options } : options;
    let content: MessageInput = input;
    if (opts?.quote && params.eventMessageId) {
      content = [
        new MessageSegmentImpl("reply", { message_id: params.eventMessageId }),
        ...asMessage(input),
      ];
    }
    const target =
      conversation.type === "group"
        ? { type: "group", group_id: conversation.id }
        : { type: "private", user_id: conversation.id };
    return params.bot.sendMessage(target, content);
  };
};

const computeIsToMe = (
  params: EventBuildParams,
  eventType: MessageType,
  d: QQMessagePayload,
): boolean => {
  const { bot, logger, selfOpenids } = params;
  const botId = bot.bot_id;
  if (eventType === "GROUP_AT_MESSAGE_CREATE") return true;
  const mentionIds = new Set<string>();
  for (const mention of d.mentions ?? []) {
    if (!mention || typeof mention !== "object") continue;
    const m = mention as {
      member_openid?: unknown;
      user_openid?: unknown;
      id?: unknown;
    };
    for (const id of [m.member_openid, m.user_openid, m.id]) {
      if (typeof id === "string" && id) mentionIds.add(id);
    }
  }
  if (mentionIds.has(botId)) return true;
  const content = typeof d.content === "string" ? d.content : "";
  for (const token of mentionTokensOf(content)) {
    if (token === botId || mentionIds.has(token)) continue;
    if (!selfOpenids.has(token)) {
      selfOpenids.add(token);
      logger.info(`已识别机器人自身 openid: ${token} (来自群消息 @ 令牌)`);
    }
    return true;
  }
  return false;
};

/** 官方消息事件 → 核心 MessageEvent;同时登记被动回复窗口与撤回路径 */
export const buildQQMessageEvent = (
  params: EventBuildParams & {
    eventType: MessageType;
    d: QQMessagePayload;
  },
): MessageEvent | null => {
  const { adapterName, bot, client, passive, refs, eventType, d } = params;
  const messageId = String(d.id ?? "");
  if (!messageId) return null;

  const isGroup = eventType !== "C2C_MESSAGE_CREATE";
  const groupId = isGroup ? String(d.group_openid ?? "") : undefined;
  const userId = isGroup ? userIdOf(d) : String(d.user_openid ?? userIdOf(d));
  if (isGroup && !groupId) return null;

  const message: Message = buildMessage(d, { botId: bot.bot_id });
  const scene = parseSceneExt(d);
  const time = timestampOf(d);
  const conversation = {
    type: isGroup ? ("group" as const) : ("private" as const),
    id: isGroup ? groupId! : userId,
  };

  refs.set(messageId, {
    refIdx: scene.msg_idx,
    base: isGroup ? `/v2/groups/${groupId}` : `/v2/users/${userId}`,
  });
  passive.record(conversation, messageId, "msg");

  const sender = senderOf(d);
  const at = atOf(message);
  const quoteId = scene.ref_msg_idx;
  const isToMe = computeIsToMe(params, eventType, d);

  const buildParams = { ...params, eventMessageId: messageId };

  return {
    kind: "message",
    type: "message",
    routes: buildRoutes(adapterName, "message", isGroup ? "group" : "private"),
    identity: identityOf({
      ...buildParams,
      eventType: isGroup ? "message.group" : "message.private",
      messageId,
      time,
    }),
    self_id: bot.bot_id,
    bot,
    time,
    raw: d,
    message_type: isGroup ? "group" : "private",
    sub_type: eventType === "GROUP_MESSAGE_CREATE" ? "full" : undefined,
    user_id: userId,
    group_id: groupId,
    message_id: messageId,
    raw_message: message.raw_message,
    quote_id: quoteId,
    sender,
    group: isGroup && groupId ? createGroupRef(bot, groupId) : undefined,
    friend:
      !isGroup && userId
        ? createFriendRef(bot, userId, sender.nickname)
        : undefined,
    conversation: { type: conversation.type, id: conversation.id },
    message,
    is_to_me: isToMe,
    at,
    reply: replyOf(buildParams, conversation),
    recall: async () => {
      await client.delete(
        isGroup
          ? `/v2/groups/${groupId}/messages/${messageId}`
          : `/v2/users/${userId}/messages/${messageId}`,
      );
    },
  };
};

/** 按钮回调(type=11/12)→ 合成普通 message 事件(sub_type=callback),走现有指令管道 */
export const buildInteractionEvent = (
  params: EventBuildParams & { d: QQInteractionPayload },
): MessageEvent | null => {
  const { adapterName, bot, passive, refs, logger, d } = params;
  const eventId = String(d.id ?? "");
  if (!eventId) return null;

  const buttonData = String(d.data?.resolved?.button_data ?? "");
  const isGroup = d.scene === "group" || d.chat_type === 1;
  const groupId = d.group_openid;
  const userId = String(d.group_member_openid ?? d.user_openid ?? "");
  if (isGroup && !groupId) return null;

  const time = timestampOf(d);
  const conversation = {
    type: isGroup ? ("group" as const) : ("private" as const),
    id: isGroup ? groupId! : userId,
  };
  const segments: MessageSegment[] = [
    new MessageSegmentImpl("text", { text: buttonData }),
  ];
  const message = createMessage(segments, buttonData);

  refs.set(eventId, {
    base: isGroup ? `/v2/groups/${groupId}` : `/v2/users/${userId}`,
  });
  passive.record(conversation, eventId, "event");

  const buildParams = { ...params, eventMessageId: eventId };

  return {
    kind: "message",
    type: "message",
    routes: buildRoutes(
      adapterName,
      "message",
      isGroup ? "group" : "private",
      "callback",
    ),
    identity: identityOf({
      ...buildParams,
      eventType: "interaction.callback",
      messageId: eventId,
      time,
    }),
    self_id: bot.bot_id,
    bot,
    time,
    raw: d,
    message_type: isGroup ? "group" : "private",
    sub_type: "callback",
    user_id: userId,
    group_id: isGroup ? groupId : undefined,
    message_id: eventId,
    raw_message: buttonData,
    sender: { user_id: userId },
    group: isGroup && groupId ? createGroupRef(bot, groupId) : undefined,
    friend: !isGroup && userId ? createFriendRef(bot, userId) : undefined,
    conversation: { type: conversation.type, id: conversation.id },
    message,
    is_to_me: true,
    reply: replyOf(buildParams, conversation),
    recall: async () => {
      logger.debug("按钮回调合成事件不支持撤回");
    },
  };
};

const NOTICE_MAP: Record<string, { noticeType: string; subType: string }> = {
  FRIEND_ADD: { noticeType: "friend", subType: "increase" },
  FRIEND_DEL: { noticeType: "friend", subType: "decrease" },
  C2C_MSG_REJECT: { noticeType: "friend", subType: "msg_reject" },
  C2C_MSG_RECEIVE: { noticeType: "friend", subType: "msg_receive" },
  GROUP_ADD_ROBOT: { noticeType: "group", subType: "increase" },
  GROUP_DEL_ROBOT: { noticeType: "group", subType: "decrease" },
  GROUP_MSG_REJECT: { noticeType: "group", subType: "msg_reject" },
  GROUP_MSG_RECEIVE: { noticeType: "group", subType: "msg_receive" },
};

export const noticeMappingOf = (eventType: string) => NOTICE_MAP[eventType];

export const buildQQNoticeEvent = (
  params: EventBuildParams & {
    eventType: string;
    d: Record<string, unknown>;
    mapping: { noticeType: string; subType: string };
  },
): NoticeEvent => {
  const { adapterName, bot, eventType, d, mapping } = params;
  const isGroup = mapping.noticeType === "group";
  const time = timestampOf(d as { timestamp?: string });
  return {
    kind: "notice",
    type: "notice",
    routes: buildRoutes(
      adapterName,
      "notice",
      mapping.noticeType,
      mapping.subType,
    ),
    identity: {
      adapter: adapterName,
      bot_id: bot.bot_id,
      event_type: `notice.${mapping.noticeType}`,
      timestamp: time,
      native_event_id: typeof d.id === "string" ? d.id : undefined,
    },
    self_id: bot.bot_id,
    bot,
    time,
    raw: d,
    notice_type: mapping.noticeType,
    sub_type: mapping.subType,
    user_id: typeof d.user_openid === "string" ? d.user_openid : undefined,
    group_id:
      isGroup && typeof d.group_openid === "string"
        ? d.group_openid
        : undefined,
  };
};
