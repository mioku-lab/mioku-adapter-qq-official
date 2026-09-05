import { asMessage } from "mioku";

import type { Logger, MessageInput } from "mioku";
import type { ButtonOptions } from "mioku";

export interface OfficialButton {
  id?: string;
  render_data: { label: string; visited_label?: string; style?: number };
  action: {
    type: 0 | 1 | 2;
    permission: { type: 0 | 1 | 2; specify_user_ids?: string[] };
    data?: string;
    enter?: boolean;
    reply?: boolean;
    unsupport_tips?: string;
  };
}

export interface KeyboardPayload {
  content: { rows: Array<{ buttons: OfficialButton[] }> };
  bot_appid?: string;
}

export type SendUnit =
  | { kind: "markdown"; content: string; buttons: ButtonOptions[] }
  | {
      kind: "media";
      fileType: 1 | 2 | 3 | 4;
      file: string | Buffer;
      name?: string;
    };

export interface BuildUnitsOptions {
  imageMode: "markdown" | "media";
  logger: Logger;
}

export interface BuiltUnits {
  units: SendUnit[];
  /** reply 段引用的消息 id(用于解析 message_reference) */
  refMessageId?: string;
}

const stripFilePrefix = (file: string): string =>
  file.startsWith("file://") ? file.slice("file://".length) : file;

const fileOf = (data: Record<string, unknown>): string | Buffer | undefined => {
  if (Buffer.isBuffer(data.file)) return data.file;
  if (typeof data.url === "string") return data.url;
  if (typeof data.file === "string") return data.file;
  const attachment = data.attachment as
    | { url?: string; file?: string }
    | undefined;
  if (typeof attachment?.url === "string") return attachment.url;
  if (typeof attachment?.file === "string") return attachment.file;
  return undefined;
};

const buttonToOfficial = (
  button: ButtonOptions,
  index: number,
): OfficialButton | null => {
  const action = button.action ?? (button.url ? "link" : "callback");
  const data = button.data;
  if (action !== "link" && !data) return null;
  if (action === "link" && !button.url && !data) return null;

  const permission: OfficialButton["action"]["permission"] = { type: 2 };
  if (button.permission === "admin") permission.type = 1;
  else if (Array.isArray(button.permission)) {
    permission.type = 0;
    permission.specify_user_ids = button.permission.map(String);
  }

  return {
    id: button.id ?? `btn_${index}`,
    render_data: {
      label: button.label,
      ...(button.visitedLabel ? { visited_label: button.visitedLabel } : {}),
      ...(button.style != null ? { style: button.style } : {}),
    },
    action: {
      type: action === "link" ? 0 : action === "command" ? 2 : 1,
      permission,
      data: action === "link" ? (button.url ?? data ?? "") : (data ?? ""),
      ...(action === "command"
        ? {
            enter: button.enter ?? true,
            ...(button.reply ? { reply: true } : {}),
          }
        : {}),
      unsupport_tips:
        button.unsupportedTips ?? "当前客户端版本过低,暂不支持该操作",
    },
  };
};

const imageMarkdown = (url: string, data: Record<string, unknown>): string => {
  const summary =
    typeof data.summary === "string" && data.summary ? data.summary : "图片";
  const width = typeof data.width === "number" ? data.width : 0;
  const height = typeof data.height === "number" ? data.height : 0;
  return `![${summary} #${width}px #${height}px](${url})`;
};

export const keyboardOf = (
  buttons: OfficialButton[],
  appId: string,
): KeyboardPayload | undefined => {
  if (buttons.length === 0) return undefined;
  const rows: Array<{ buttons: OfficialButton[] }> = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push({ buttons: buttons.slice(i, i + 5) });
  }
  return { content: { rows }, bot_appid: appId };
};

/** 按钮段 → 官方 keyboard payload(自动每 5 个一行,最多 25 个) */
export const buildKeyboard = (
  buttons: ButtonOptions[],
  appId: string,
  logger?: Logger,
): KeyboardPayload | undefined => {
  const official: OfficialButton[] = [];
  let index = 0;
  for (const button of buttons.slice(0, 25)) {
    const converted = buttonToOfficial(button, index);
    if (converted) {
      official.push(converted);
      index += 1;
    } else {
      logger?.debug("丢弃无效按钮:缺少 data/url");
    }
  }
  return keyboardOf(official, appId);
};

/**
 * 核心消息 → 官方发送单元。官方一次请求只能携带一种内容(msg_type 0/2/7 互斥),
 * 因此按 markdown 文本池 + 富媒体拆分成多个单元;按钮汇总后挂到第一个 markdown 单元。
 */
export const buildSendUnits = (
  message: MessageInput,
  options: BuildUnitsOptions,
): BuiltUnits => {
  const { logger, imageMode } = options;
  const units: SendUnit[] = [];
  let text = "";
  const buttons: ButtonOptions[] = [];
  let refMessageId: string | undefined;

  const flush = (): void => {
    if (text.trim())
      units.push({ kind: "markdown", content: text, buttons: [] });
    text = "";
  };

  const pushMedia = (segType: string, data: Record<string, unknown>): void => {
    const file = fileOf(data);
    if (file === undefined) {
      logger.debug(`丢弃无法解析的 ${segType} 段:缺少 file/url`);
      return;
    }
    flush();
    const fileType =
      segType === "image"
        ? 1
        : segType === "video"
          ? 2
          : segType === "record"
            ? 3
            : 4;
    const name = typeof data.name === "string" ? data.name : undefined;
    units.push({ kind: "media", fileType, file, ...(name ? { name } : {}) });
  };

  const walk = (input: MessageInput): void => {
    for (const seg of asMessage(input)) {
      const data = seg.data as Record<string, unknown>;
      switch (seg.type) {
        case "text":
          text += typeof data.text === "string" ? data.text : "";
          break;
        case "at": {
          const target = data.qq ?? data.target;
          text +=
            target === "all" || target === "everyone"
              ? "<qqbot-at-everyone />"
              : `<qqbot-at-user id="${String(target ?? "")}" />`;
          break;
        }
        case "markdown":
          text += typeof data.content === "string" ? data.content : "";
          break;
        case "image": {
          const url = typeof data.url === "string" ? data.url : undefined;
          const isPublicUrl = Boolean(url && /^https?:\/\//i.test(url));
          if (imageMode === "markdown" && isPublicUrl) {
            text += imageMarkdown(url as string, data);
          } else {
            pushMedia("image", data);
          }
          break;
        }
        case "video":
        case "record":
        case "file":
          pushMedia(seg.type, data);
          break;
        case "reply":
          if (!refMessageId && typeof data.message_id === "string")
            refMessageId = data.message_id;
          break;
        case "button":
          if (typeof data.label === "string")
            buttons.push(data as unknown as ButtonOptions);
          break;
        case "node": {
          flush();
          const content = data.content;
          if (Array.isArray(content))
            for (const item of content) walk(item as MessageInput);
          break;
        }
        case "face":
        case "json":
        case "forward":
        default:
          logger.debug(`官方通道不支持 ${seg.type} 段,已丢弃`);
          break;
      }
    }
  };

  walk(message);
  flush();

  const firstMarkdown = units.find((unit) => unit.kind === "markdown");
  if (buttons.length > 0) {
    if (firstMarkdown && firstMarkdown.kind === "markdown") {
      firstMarkdown.buttons = buttons;
    } else {
      units.push({ kind: "markdown", content: " ", buttons });
    }
  }

  return { units, refMessageId };
};

/** markdown 发送失败时降级为纯文本(剥离 qqbot 文本链与图片语法) */
export const degradeMarkdown = (content: string): string =>
  content
    .replace(/<qqbot-at-user id="[^"]*" \/>/g, "")
    .replace(/<qqbot-at-everyone \/>/g, "@全体成员")
    .replace(/<qqbot-cmd-input[^>]*show="\[([^"\]]*)\]"[^>]*\/>/g, "$1")
    .replace(/<qqbot-cmd-input[^>]*\/>/g, "")
    .replace(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g, "(图片:$1)")
    .trim();

export const shouldDegrade = (err: unknown): boolean => {
  const code = (err as { code?: number | string } | null)?.code;
  if (code == null) return false;
  return [
    "50037",
    "50056",
    "304036",
    "304061",
    "40034011",
    "40034008",
    "40034009",
  ].includes(String(code));
};
