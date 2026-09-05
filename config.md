---
title: qq-official 适配器配置
description: 配置 QQ 官方开放平台机器人的接入实例
fields:
  - key: qq-official.instances
    label: 机器人实例
    type: array
    description: 每个实例对应一个官方机器人（AppID + AppSecret）。可添加多个实例同时接入多个机器人，openid 按 AppID 隔离。
    itemFields:
      - key: appId
        label: AppID
        type: text
        description: 开放平台机器人的 AppID。
        required: true

      - key: appSecret
        label: AppSecret
        type: secret
        description: 开放平台机器人的 AppSecret，用于获取 access_token。
        required: true

      - key: sandbox
        label: 沙箱环境
        type: switch
        description: 开启后连接沙箱 API（sandbox.api.sgroup.qq.com），只收到沙箱配置的群/单聊事件。
        defaultValue: false

      - key: imageMode
        label: 图片发送方式
        type: select
        description: markdown=嵌入 markdown 单卡片发送（图片 URL 需公网可访问）；media=独立富媒体消息（base64 上传，无公网要求）。markdown 发送失败会自动按 media 重试。
        options:
          - value: markdown
            label: markdown（单卡片）
          - value: media
            label: media（图文分离）

      - key: forceVerifyImageResource
        label: 校验图片转存
        type: switch
        description: markdown 图片转存失败时是否中断发送（默认 false，失败时消息照发、图片可能裂图）。
        defaultValue: false

      - key: passiveWindowMs
        label: 被动回复窗口（ms）
        type: number
        description: 收到事件后多少毫秒内的发送按被动回复携带 msg_id，官方上限 5 分钟。
        defaultValue: 300000

      - key: maxPassiveReplies
        label: 被动回复次数上限
        type: number
        description: 同一条 msg_id 最多被动回复次数，官方上限 5 次，超出自动转主动消息。
        defaultValue: 5

      - key: readyTimeoutMs
        label: 启动等待就绪超时（ms）
        type: number
        description: 启动时等待官方网关会话就绪（READY）的最长时间，超时后转入后台重连并继续启动；设为 0 表示不等待。
        defaultValue: 15000

      - key: reconnect
        label: 断线自动重连
        type: switch
        description: 网关断开后是否自动重连（优先恢复会话补发漏掉的事件）。
        defaultValue: true
---

# qq-official 适配器配置

连接 [QQ 开放平台](https://q.qq.com) 官方机器人（OpenAPI v2 + WebSocket 事件推送），支持群聊/单聊的文本、Markdown、按钮、富媒体。

部署前需在开放平台管理端完成：IP 白名单（新机器人强制启用，否则无法连接）、按需开启「接收所有消息」（群全量消息）。

```mioku-field
key: qq-official.instances
```
