#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import consola from "consola";

import type { ConfirmPromptOptions, TextPromptOptions } from "consola";

type ConfirmOpts = Omit<ConfirmPromptOptions, "type" | "required"> & {
  required?: boolean;
};
type TextOpts = Omit<TextPromptOptions, "type" | "required"> & {
  required?: boolean;
};

const confirm = async (
  message: string,
  options?: ConfirmOpts,
): Promise<boolean> =>
  (await consola.prompt(message, {
    type: "confirm",
    cancel: "reject",
    ...options,
  })) as boolean;

const input = async (message: string, options?: TextOpts): Promise<string> => {
  let result: string;
  do {
    result = (await consola.prompt(message, {
      type: "text",
      cancel: "reject",
      ...options,
    })) as string;
    if (options?.required && !result) continue;
    break;
  } while (true);
  return result;
};

const select = <T extends string>(
  message: string,
  options: Array<{ label: string; value: T }>,
): Promise<T> =>
  consola.prompt(message, {
    type: "select",
    cancel: "reject",
    options,
  }) as Promise<T>;

export interface QQOfficialCliContext {
  readonly cwd: string;
  readonly logger?: typeof consola;
}

export interface QQOfficialInstanceInput {
  appId: string;
  appSecret: string;
  sandbox: boolean;
  imageMode: "markdown" | "media";
}

export interface QQOfficialCliConfig {
  instances: QQOfficialInstanceInput[];
}

export const run = async (
  ctx: QQOfficialCliContext,
): Promise<QQOfficialCliConfig> => {
  const log = ctx.logger ?? consola;
  log.info("正在配置 qq-official 适配器(AppID / AppSecret 见开放平台开发设置)");
  log.info("");

  const instances: QQOfficialInstanceInput[] = [];
  let addMore = true;
  while (addMore) {
    const appId = await input("AppID", { required: true });
    const appSecret = await input("AppSecret", { required: true });
    const sandbox = await confirm("使用沙箱环境？", { initial: false });
    const imageMode = await select("图片发送方式", [
      {
        label: "markdown（单卡片，图片需公网可访问）",
        value: "markdown" as const,
      },
      { label: "media（图文分离，base64 上传）", value: "media" as const },
    ]);

    instances.push({ appId, appSecret, sandbox, imageMode });
    addMore = await confirm("是否继续添加机器人实例？", { initial: false });
    if (addMore) log.info("");
  }

  return { instances };
};

const isRunningAsMain = (): boolean => {
  if (!process.argv[1]) return false;
  try {
    return (
      import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
};

if (isRunningAsMain()) {
  void (async () => {
    const cwd = process.cwd();
    const pkgPath = path.join(cwd, "package.json");
    if (!fs.existsSync(pkgPath)) {
      consola.error("未找到 package.json，请在机器人项目根目录运行此向导");
      process.exit(1);
    }
    const config = await run({ cwd });
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      mioku?: Record<string, unknown>;
    };
    pkg.mioku = pkg.mioku ?? {};
    const adapters =
      (pkg.mioku.adapters as Record<string, unknown> | undefined) ?? {};
    pkg.mioku.adapters = { ...adapters, "qq-official": config };
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
    consola.success("已写入 qq-official 适配器配置");
  })();
}

export default run;
