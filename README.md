# mioku-adapter-qq-official

QQ 开放平台官方机器人适配器(mioku),支持 QQ 群聊、单聊场景,含 Markdown 消息、交互按钮、富媒体发送与按钮回调事件。

## 特性

- **官方通道**:OpenAPI v2 + 官方 WebSocket 网关(op 10/2/1/11/6/7/9,断线自动 Resume 补发)
- **Token 自动管理**:`access_token` 7200s,提前 2 分钟自动刷新,401 自动重试
- **Markdown + 按钮**:核心 `segment.markdown()` / `segment.button()` → 官方 msg_type=2,按钮自动 5 个一行组装 keyboard(最多 5×5)
- **图片双模式**(配置切换):
  - `markdown`:图片嵌入 markdown 单卡片发送,适合有公网的机器
  - `media`:图片走 base64 上传独立富媒体消息,无公网要求
  - markdown 转存/发送失败自动按 media 路径重试;markdown 权限类错误自动降级纯文本
- **被动回复自动接管**:事件后 5 分钟窗口内的发送自动携带 `msg_id`/`msg_seq`(最多 5 次),插件零感知;互动事件回复走 `event_id`
- **按钮回调合成消息事件**:`INTERACTION_CREATE`(type=11/12)自动回应并合成为 `sub_type: "callback"` 的普通消息事件(内容为 `button_data`),走现有指令管道;先应答再派发,规避 3 秒超时
- **群全量消息**:支持 `GROUP_MESSAGE_CREATE`(需在管理端开启「接收所有消息」),`author.member_role` 直接映射 `sender.role`
- **能力降级约定**:官方不支持的群管/查询类能力按约定返回假完成(动作类,带一次性 warn)或空值(查询类),插件不会崩

## 安装

仓库内 workspace 包,`bun install` 即可安装。

```bash
bun install
```

## 配置

适配器配置存在机器人根目录 `package.json` 的 `mioku.adapters` 字段下(JSON):

```json
{
  "mioku": {
    "adapters": {
      "qq-official": {
        "instances": [
          {
            "appId": "你的AppID",
            "appSecret": "你的AppSecret"
          }
        ]
      }
    }
  }
}
```

也可以在机器人项目根目录运行 `npx mioku-adapter-qq-official` 交互式写入,或在 WebUI 配置页按 [config.md](./config.md) 声明的字段表单化编辑。

## 平台前置条件

1. [QQ 开放平台](https://q.qq.com) 创建机器人,拿到 `AppID` / `AppSecret`
2. **IP 白名单**:新机器人默认强制启用,部署机公网 IP 必须加入白名单,否则连不上网关
3. **群全量消息**:如需接收群里非 @ 消息,在管理端开启「接收所有消息」
4. **消息 URL 白名单**:消息文本中的链接域名必须报备(需 ICP 备案);markdown 图片由平台转存,一般无需报白

## 能力支持矩阵

| 能力 | 状态 | 说明 |
|---|---|---|
| message.send | ✅ | 文本/markdown/图片/语音/视频/文件/按钮 |
| message.recall | ✅ | 2 分钟内;仅撤回已见过的消息(发送响应或收到的事件) |
| message.forwardsend | ⚠️ | 合并转发拍平为多条普通消息 |
| message.get / getforward | ⬜ 返回空 | 官方无对应 API |
| group.getinfo | ✅ | `GET /v2/groups/{id}/info`;无权限时回退本地缓存 |
| group.getlist | ⚠️ | 仅返回运行期间见过的群(openid) |
| group.getmembers | ✅ | `GET /v2/groups/{id}/members`,自动翻页(每页 30);需平台开通权限 |
| member.getinfo | ✅ | `GET /v2/groups/{id}/members/{member_openid}`;需平台开通权限 |
| member.ban | ✅ | `POST /restrict_chat_setting`,duration=0 解除禁言 |
| member.kick | ✅ | `POST /batch_remove_members`,reject_add_request 时同时拉黑 |
| member.card / admin / title / poke | ❌ 抛 UnsupportedCapabilityError | 官方无对应 API |
| group.setname / setwholeban / setportrait / leave | ❌ 抛 UnsupportedCapabilityError | 官方无对应 API |
| conversation.history | ⬜ 返回空 | 官方无对应 API |
| friend.getinfo / getlist | ⬜ 返回空 | 官方无对应 API |
| friend.delete / profile.set / avatar.set | ❌ 抛 UnsupportedCapabilityError | 官方无对应 API |
| bot.status | ✅ | |

✅ 完整支持 · ⚠️ 降级实现 · ⬜ 空值降级 · ❌ 明确不支持(抛 `UnsupportedCapabilityError`)

`group.getmembers` / `member.getinfo` / `member.ban` / `member.kick` / `group.getinfo` 属于平台**白名单能力**,
未开通时官方返回错误码 `11253`,调用会抛出官方错误(不再静默假成功)。

## 事件订阅

默认订阅 `GROUP_AND_C2C_EVENT(1<<25) | INTERACTION(1<<26) | GROUP_MEMBER_EVENT(1<<24)`:

| 官方事件 | 核心事件 |
|---|---|
| C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE / GROUP_MESSAGE_CREATE | `message.private` / `message.group` |
| INTERACTION_CREATE(按钮回调) | `message.group.callback` / `message.private.callback` |
| FRIEND_ADD / FRIEND_DEL / C2C_MSG_REJECT / C2C_MSG_RECEIVE | `notice.friend.*` |
| GROUP_ADD_ROBOT / GROUP_DEL_ROBOT / GROUP_MSG_REJECT / GROUP_MSG_RECEIVE | `notice.group.*` |
| GROUP_MEMBER_ADD / GROUP_MEMBER_REMOVE | `notice.group.increase` / `notice.group.decrease`(user_id = 成员 openid) |
| GROUP_JOIN_REQUEST | `request.group.join`(`approve()` / `reject(reason)` 走官方审批接口) |

`GROUP_MEMBER_EVENT` 需要平台开通权限:未开通时网关会以关闭码 4014 拒绝连接,
适配器会**自动去掉该 intent 重连**并打印告警;也可以显式配置 `memberEvents: false` 跳过。

## 消息转换规则

官方一次请求只能携带一种内容(`msg_type` 0/2/7 互斥),适配器按以下规则拆分:

- `text` / `at` / `markdown` 段合并进 markdown 文本池;`at` 转官方文本链(`<qqbot-at-user>` / `<qqbot-at-everyone>`)
- `image`:markdown 模式且有 URL → 嵌入 markdown;否则上传 `/files` 走 msg_type=7 独立发送(图文会拆成多条)
- `video` / `record` / `file` → 上传后 msg_type=7 独立发送(语音支持 silk/mp3/wav/ogg)
- `button` 段汇总挂到第一个 markdown 单元;没有 markdown 单元时自动补一条空白 markdown 承载键盘
- `face` / `json` / `forward` 等无对应物的段丢弃(记 debug);`node` 递归拍平
- 发送报 `50037`/`50056`/`304036` 等 markdown 权限/格式错误 → 自动降级纯文本重试

## 已知限制

- 所有 id 均为 **openid**,且同一用户在不同 appId 下 openid 不同,请按 bot 维度隔离存储
- 群里默认只能收到 @机器人 的消息;全量消息需平台侧开关
- 主动消息有频控(认证 60/qpm,单关系 20/qpm,每群 1000 条/天),超限错误码会翻译进日志
- 按钮仅能挂在 markdown 消息上;回调按钮的互动应答使用 code 0
