import {
  bindCapabilities,
  defineAdapter,
  registerStatusProvider,
  avatarSet,
  avatarGet,
  botStatus,
  conversationGetHistory,
  forwardSend,
  friendDelete,
  friendGetInfo,
  friendGetList,
  groupGetInfo,
  groupGetList,
  groupGetMembers,
  groupLeave,
  groupSetName,
  groupSetPortrait,
  groupSetWholeBan,
  memberBan,
  memberGetInfo,
  memberKick,
  memberPoke,
  memberSetAdmin,
  memberSetCard,
  memberSetTitle,
  messageGet,
  messageGetForward,
  messageRecall,
  messageSend,
  profileSet,
} from "mioku";

import {
  API_BASE,
  DEFAULT_INSTANCE,
  DEFAULT_INTENTS,
  SANDBOX_API_BASE,
  normalizeInstances,
} from "./config";
import { QQClient } from "./client";
import { QQGateway } from "./gateway";
import { MediaUploader } from "./media";
import { PassiveManager } from "./passive";
import { MessageStore } from "./store";
import { TokenManager } from "./token";
import { createQQBot, type QQOfficialBot, type QQOfficialBotData } from "./bot";
import {
  buildInteractionEvent,
  buildQQMessageEvent,
  buildQQNoticeEvent,
  noticeMappingOf,
  type MessageType,
  type QQInteractionPayload,
} from "./events";
import type { QQMessagePayload } from "./segments";
import { version as adapterVersion } from "../package.json" with { type: "json" };
import type {
  Adapter,
  AdapterContext,
  AdapterFactoryOptions,
  AdapterStatus,
  Bot,
  Logger,
} from "mioku";
import type {
  QQOfficialAdapterConfig,
  QQOfficialInstanceConfig,
} from "./config";

const ADAPTER_NAME = "qq-official";

/** 收到消息的日志格式与 onebot/icqq 适配器对齐 */
const stringifyMessageLog = (message: import("mioku").Message): string =>
  message
    .map((seg) => {
      const d = (seg.data ?? {}) as Record<string, unknown>;
      switch (seg.type) {
        case "text":
          return typeof d.text === "string" ? d.text : "";
        case "at":
          return `{at:${d.target ?? d.qq ?? ""}}`;
        case "face":
          return `{face:${d.id ?? ""}}`;
        case "image":
          return `{image:${typeof d.url === "string" ? d.url : ""}}`;
        case "record":
          return `{record:${typeof d.url === "string" ? d.url : ""}}`;
        case "video":
          return `{video:${typeof d.url === "string" ? d.url : ""}}`;
        case "file":
          return `{file:${typeof d.name === "string" ? d.name : ""}}`;
        case "json":
          return `{json:${typeof d.data === "string" ? d.data.slice(0, 200) : ""}}`;
        default:
          return `{${seg.type}}`;
      }
    })
    .join("");

const buildAdapter = (
  instance: QQOfficialInstanceConfig,
  logger: Logger,
): Adapter => {
  const resolved = { ...DEFAULT_INSTANCE, ...instance };
  const apiBase =
    instance.apiBase ?? (resolved.sandbox ? SANDBOX_API_BASE : API_BASE);
  const intents = instance.intents ?? DEFAULT_INTENTS;

  const botData: QQOfficialBotData = {
    bot_id: String(instance.appId),
    adapter: ADAPTER_NAME,
    nickname: "",
    online: false,
  };

  let context: AdapterContext | null = null;
  let token: TokenManager | null = null;
  let client: QQClient | null = null;
  let uploader: MediaUploader | null = null;
  let passive: PassiveManager | null = null;
  let refs: MessageStore | null = null;
  let gateway: QQGateway | null = null;
  let bot: QQOfficialBot | null = null;
  let unregisterBot: (() => void) | null = null;
  let unregisterStatus: (() => void) | null = null;
  let unregisterCapabilities: Array<() => void> = [];
  const groups = new Map<string, import("mioku").GroupInfo>();
  // 机器人在 openid 体系里的自身 id(官方 READY 只给平台 id,群消息 @ 令牌用的是 openid,
  // 从「内容中出现但 mentions 未收录」的 @ 令牌里学习)
  const selfOpenids = new Set<string>();
  // /users/@me 拿到的机器人头像地址
  let avatarUrl: string | undefined;
  let sendCount = 0;
  let receiveCount = 0;

  const eventParams = () => {
    if (!context || !bot || !client || !passive || !refs) return null;
    return {
      adapterName: ADAPTER_NAME,
      bot,
      client,
      passive,
      refs,
      logger,
      selfOpenids,
    };
  };

  const ensureBot = async (user?: {
    id?: string;
    username?: string;
  }): Promise<void> => {
    if (!context || !client || !uploader || !passive || !refs) {
      throw new Error("QQ official adapter is not initialized");
    }
    botData.bot_id = String(user?.id ?? instance.appId);
    botData.nickname = user?.username ?? "";

    if (!bot) {
      bot = bindCapabilities(
        createQQBot({
          data: botData,
          client,
          uploader,
          passive,
          refs,
          config: instance,
          logger,
          groups,
          onSend: () => {
            sendCount += 1;
          },
        }),
        context.getCapabilityRegistry(),
      );
      unregisterBot = context.registerBot(bot).unregister;
      registerCapabilities(context, bot);
    }

    if (unregisterStatus && statusBotId !== botData.bot_id) {
      unregisterStatus();
      unregisterStatus = null;
    }
    if (!unregisterStatus) {
      unregisterStatus = registerStatusProvider(
        { adapter: ADAPTER_NAME, bot_id: botData.bot_id },
        (): AdapterStatus => ({
          adapter: ADAPTER_NAME,
          bot_id: botData.bot_id,
          impl: "QQ OpenAPI v2",
          protocol: "v2",
          stats: {
            sent: sendCount,
            received: receiveCount,
            groups: groups.size,
          },
          data: {
            appId: instance.appId,
            sandbox: Boolean(resolved.sandbox),
            imageMode: resolved.imageMode,
          },
        }),
      );
    }
    statusBotId = botData.bot_id;

    if (!botData.online) {
      botData.online = true;
      botData.connected_at = Date.now();
      logger.info(
        `已连接 QQ 开放平台: ${botData.nickname || "bot"}(${botData.bot_id}) appId=${instance.appId}${resolved.sandbox ? " [沙箱]" : ""}`,
      );
      await context.emitLifecycle({ type: "bot:connected", bot });
    }
  };

  let statusBotId: string | null = null;

  const registerCapabilities = (
    ctx: AdapterContext,
    currentBot: QQOfficialBot,
  ): void => {
    const target = { adapter: ADAPTER_NAME, bot_id: currentBot.bot_id };
    unregisterCapabilities = [
      ctx.registerCapability(messageSend, target, (req) =>
        currentBot.sendMessage(req.target, req.message),
      ),
      ctx.registerCapability(messageRecall, target, async (req) => {
        await currentBot.recallMessage(String(req.message_id));
      }),
      ctx.registerCapability(messageGet, target, (req) =>
        currentBot.getMessage(req.message_id),
      ),
      ctx.registerCapability(messageGetForward, target, (req) =>
        currentBot.getForwardMessage(req.message_id),
      ),
      ctx.registerCapability(forwardSend, target, async (req) => {
        let last: { message_id?: string } = {};
        for (const node of req.nodes) {
          last = await currentBot.sendMessage(req.target, node.content);
        }
        return last;
      }),
      ctx.registerCapability(memberBan, target, async (req) => {
        await currentBot.banMember(req.group_id, req.user_id, req.duration);
      }),
      ctx.registerCapability(memberKick, target, async (req) => {
        await currentBot.kickMember(req.group_id, req.user_id);
      }),
      ctx.registerCapability(memberSetCard, target, async (req) => {
        await currentBot.setMemberCard(req.group_id, req.user_id, req.card);
      }),
      ctx.registerCapability(memberSetAdmin, target, async (req) => {
        await currentBot.setMemberAdmin(req.group_id, req.user_id, req.enable);
      }),
      ctx.registerCapability(memberGetInfo, target, (req) =>
        currentBot.getMemberInfo(req.group_id, req.user_id),
      ),
      ctx.registerCapability(memberPoke, target, async (req) => {
        await currentBot.pokeMember(req.group_id, req.user_id);
      }),
      ctx.registerCapability(memberSetTitle, target, async (req) => {
        await currentBot.setMemberTitle(req.group_id, req.user_id, req.title);
      }),
      ctx.registerCapability(groupGetInfo, target, (req) =>
        currentBot.getGroupInfo(req.group_id),
      ),
      ctx.registerCapability(groupGetMembers, target, (req) =>
        currentBot.getGroupMembers(req.group_id),
      ),
      ctx.registerCapability(groupGetList, target, () =>
        currentBot.getGroupList(),
      ),
      ctx.registerCapability(groupLeave, target, async (req) => {
        await currentBot.leaveGroup(req.group_id, req.is_dismiss);
      }),
      ctx.registerCapability(groupSetName, target, async (req) => {
        await currentBot.setGroupName(req.group_id, req.group_name);
      }),
      ctx.registerCapability(groupSetPortrait, target, async (req) => {
        await currentBot.setGroupPortrait(req.group_id, req.file);
      }),
      ctx.registerCapability(groupSetWholeBan, target, async (req) => {
        await currentBot.setGroupWholeBan(req.group_id, req.enable);
      }),
      ctx.registerCapability(friendGetInfo, target, (req) =>
        currentBot.getFriendInfo(req.user_id),
      ),
      ctx.registerCapability(friendDelete, target, async (req) => {
        await currentBot.deleteFriend(req.user_id);
      }),
      ctx.registerCapability(friendGetList, target, () =>
        currentBot.getFriendList(),
      ),
      ctx.registerCapability(conversationGetHistory, target, (req) =>
        currentBot.getHistory(
          req.target,
          req.before == null ? undefined : String(req.before),
          req.limit,
          req.extra,
        ),
      ),
      ctx.registerCapability(profileSet, target, (req) =>
        currentBot.setProfile(req),
      ),
      ctx.registerCapability(avatarSet, target, async (req) => {
        await currentBot.setAvatar(req.file);
      }),
      ctx.registerCapability(avatarGet, target, async () => {
        // 官方 READY 只带 id/username,bot_id 是平台 id,qlogo 数字头像服务不可用,
        // 头像从 /users/@me 获取并缓存
        if (!avatarUrl && client) {
          const info = await client.get<{ avatar?: string }>("/users/@me");
          if (info?.avatar) avatarUrl = String(info.avatar);
        }
        return avatarUrl ?? null;
      }),
      ctx.registerCapability(botStatus, target, () => currentBot.getStatus()),
    ];
  };

  const handleInteraction = async (d: QQInteractionPayload): Promise<void> => {
    const params = eventParams();
    if (!client || !params || !context) return;
    const interactionId = String(d.id ?? "");
    const type = d.type;
    if (!interactionId || (type !== 11 && type !== 12)) {
      logger.debug(`忽略互动事件 type=${type}`);
      return;
    }
    // 3 秒超时,先回应再派发
    client
      .request("PUT", `/interactions/${interactionId}`, { code: 0 })
      .catch((err) => {
        client?.logRequestError("回应互动", err);
      });
    const event = buildInteractionEvent({ ...params, d });
    if (!event) return;
    await context.dispatch(event);
  };

  const handleDispatch = async (dispatch: {
    t: string;
    d: unknown;
    id?: string;
  }): Promise<void> => {
    const { t, d, id } = dispatch;
    if (!t) return;
    if (t === "READY") {
      const user = (
        d as { user?: { id?: string; username?: string } } | undefined
      )?.user;
      await ensureBot(user);
      return;
    }
    if (t === "RESUMED") {
      logger.info("官方网关会话已恢复");
      return;
    }
    if (!bot || !context) {
      logger.debug(`会话未就绪,丢弃事件 ${t}`);
      return;
    }

    if (
      t === "C2C_MESSAGE_CREATE" ||
      t === "GROUP_AT_MESSAGE_CREATE" ||
      t === "GROUP_MESSAGE_CREATE"
    ) {
      const params = eventParams();
      if (!params || !context) return;
      const payload = d as QQMessagePayload;
      if (payload.group_openid)
        groups.set(String(payload.group_openid), {
          group_id: String(payload.group_openid),
        });
      receiveCount += 1;
      const event = buildQQMessageEvent({
        ...params,
        eventType: t as MessageType,
        d: payload,
      });
      if (!event) {
        logger.warn(
          `消息事件解析失败 ${t}#${id ?? ""} (缺少消息 id 或群 openid,无法处理与回复)`,
        );
        return;
      }
      const senderName = event.sender?.nickname
        ? `${event.sender.nickname}(${event.user_id})`
        : `(${event.user_id})`;
      if (event.message_type === "group") {
        logger.info(
          `[群:${event.group_id}] ${senderName}: ${stringifyMessageLog(event.message)}`,
        );
      } else {
        logger.info(`[私:${senderName}]: ${stringifyMessageLog(event.message)}`);
      }
      await context.dispatch(event);
      return;
    }

    if (t === "INTERACTION_CREATE") {
      await handleInteraction(d as QQInteractionPayload);
      return;
    }

    const mapping = noticeMappingOf(t);
    if (mapping) {
      const params = eventParams();
      if (!params || !context) return;
      await context.dispatch(
        buildQQNoticeEvent({
          ...params,
          eventType: t,
          d: d as Record<string, unknown>,
          mapping,
        }),
      );
      return;
    }

    logger.debug(`未处理事件 ${t}`);
  };

  return {
    name: ADAPTER_NAME,
    version: adapterVersion,
    async start(ctx: AdapterContext): Promise<void> {
      context = ctx;
      const driver = ctx.getDriver();
      token = new TokenManager(
        driver,
        instance.appId,
        instance.appSecret,
        logger,
      );
      client = new QQClient(driver, apiBase, token, logger);
      uploader = new MediaUploader(client, logger);
      passive = new PassiveManager(
        resolved.passiveWindowMs,
        resolved.maxPassiveReplies,
      );
      refs = new MessageStore();
      gateway = new QQGateway(
        {
          driver,
          client,
          token,
          appId: String(instance.appId),
          intents,
          logger,
          reconnect: resolved.reconnect,
          reconnectInterval: resolved.reconnectInterval,
          maxReconnectAttempts: resolved.maxReconnectAttempts,
          maxReconnectInterval: resolved.maxReconnectInterval,
        },
        {
          onDispatch: handleDispatch,
          onDisconnect: async () => {
            if (bot && botData.online) {
              botData.online = false;
              await context?.emitLifecycle({
                type: "bot:disconnected",
                bot,
                reason: "connection closed",
              });
            }
          },
        },
      );
      ctx.registerGateway(gateway);
      logger.info(`正在连接 QQ 开放平台 (appId=${instance.appId}, ${apiBase})`);
      if (resolved.readyTimeoutMs > 0) {
        const ready = await gateway.waitForReady(resolved.readyTimeoutMs);
        if (!ready) {
          logger.warn(
            `等待官方网关会话就绪超时 (${resolved.readyTimeoutMs}ms),转入后台继续重连,后续结果见日志`,
          );
        }
      }
    },
    async stop(reason?: string): Promise<void> {
      if (bot && botData.online) {
        botData.online = false;
        try {
          await context?.emitLifecycle({
            type: "bot:disconnected",
            bot,
            reason: reason ?? "stop",
          });
        } catch (err) {
          logger.warn(
            `emit bot:disconnected 失败: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (gateway) {
        await gateway.stop(reason);
        gateway = null;
      }
      for (const dispose of unregisterCapabilities) dispose();
      unregisterCapabilities = [];
      unregisterStatus?.();
      unregisterStatus = null;
      statusBotId = null;
      unregisterBot?.();
      unregisterBot = null;
      bot = null;
      token = null;
      client = null;
      uploader = null;
      passive = null;
      refs = null;
      groups.clear();
      selfOpenids.clear();
      avatarUrl = undefined;
    },
  };
};

export const qqOfficialAdapterDefinition =
  defineAdapter<QQOfficialAdapterConfig>({
    name: ADAPTER_NAME,
    version: adapterVersion,
    apiVersion: 1,
    validateConfig: (config): QQOfficialAdapterConfig => {
      const instances = normalizeInstances(config);
      if (instances.length === 0) {
        throw new Error(
          "qq-official.instances must contain at least one instance",
        );
      }
      for (const [index, instance] of instances.entries()) {
        if (!instance.appId || typeof instance.appId !== "string") {
          throw new Error(`qq-official.instances[${index}].appId is required`);
        }
        if (!instance.appSecret || typeof instance.appSecret !== "string") {
          throw new Error(
            `qq-official.instances[${index}].appSecret is required`,
          );
        }
      }
      return { instances };
    },
    create: (
      options: AdapterFactoryOptions<QQOfficialAdapterConfig>,
    ): Adapter => {
      const instances = options.config.instances;
      // 同一 appId 建立多条网关连接会互踢下线(op 9),直接去重并告警
      const seen = new Set<string>();
      const adapters: Adapter[] = [];
      for (const instance of instances) {
        if (seen.has(String(instance.appId))) {
          options.logger.warn(
            `appId ${instance.appId} 配置了多个实例,同一 appId 仅允许一条网关连接,已忽略重复实例`,
          );
          continue;
        }
        seen.add(String(instance.appId));
        adapters.push(
          buildAdapter(
            instance,
            options.logger.child({ appId: instance.appId }),
          ),
        );
      }
      return {
        name: ADAPTER_NAME,
        version: adapterVersion,
        async start(context: AdapterContext): Promise<void> {
          await Promise.all(adapters.map((adapter) => adapter.start(context)));
        },
        async stop(reason?: string): Promise<void> {
          for (let i = adapters.length - 1; i >= 0; i--) {
            await adapters[i].stop(reason);
          }
        },
      };
    },
  });
