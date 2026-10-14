# paseo-hermes-direct

通过 Paseo Direct Provider 连接本机 Hermes AIAgent，不经过 ACP。实验性首版 v0.1.0（已加入图片、slash、steer、queue 和目标循环支持）。

链路：手机 Paseo → 现有 Paseo daemon/relay → Hermes Direct provider → 独立 Python 桥接进程 → Hermes AIAgent → 你配置的模型。

每个会话独立进程，避免 cwd、环境变量、审批回调互相干扰。文本和推理由 Hermes 原生增量回调产生；插件把累计文本以同一个 timeline ID 更新，结束时不重复追加最终答案。没有把完整答案人为切片的逻辑。

## 前置条件和验证边界

- Linux/WSL2/macOS；Node.js ≥22.19；Paseo daemon 和手机端均为 0.11.x。SDK 锁定 0.11.2。不宣称兼容旧版本或未来 0.12。
- 已安装、配置好且可以正常运行的 NousResearch/hermes-agent，以及它自己的 Python 环境。
- 当前实现核对了 Hermes main `97a9ae8ee55d31bebce49f1fb6b5ef775323976a`、Paseo main `114389383d6f6c78a9e1580ab245b3edc81feae8` 的源码契约。Hermes 内部 API 变化快；不支持的签名会明确报错，不静默降级。
- 已通过 TypeScript 类型检查，以及真实 Node→Python 子进程的协议集成测试；测试用的是模拟 AIAgent，本开发环境没有连接真实 Hermes、真实模型或手机 App。用户已在 macOS 上验证 Hermes 模块导入与 provider 模型发现，尚不能据此判定 Android 对话和流式输出通过。请在自己的服务器运行下述 smoke，再测试 Paseo 手机端。
- ACP 本身支持流式输出，当前 Hermes ACP 源码也接入了增量回调。你遇到的问题可能涉及版本、适配层或模型 transport；这个项目提供独立接入路径，不把“ACP 天生不能流式”作为前提。

## 1. 解压、构建

在运行 Paseo daemon 的服务器上解压源码包，并进入目录：

```bash
unzip paseo-hermes-direct-0.1.0.zip
cd paseo-hermes-direct
npm ci --legacy-peer-deps
npm run build
npm run typecheck
npm test
```

Paseo 在运行时提供 SDK；npm 依赖仅用于构建和开发。`build` 把 Python 桥接源码写入 `server/generated-bridge.ts`，Paseo 加载后可以直接启动它。源码包已含生成文件，修改 Python 后请重新 build。

`paseo-plugin.json` 只保留 `id`、`requirements`、`build`，不使用部分 0.11 安装版本会拒绝的 `name` 字段。界面的 **Hermes Direct** 名称由 provider 注册的 `label` 提供。`package.json` 的 npm `name` 字段仍须保留。

## 2. 指定 Hermes 环境

**这里必须填 Hermes 环境里的 Python，不能填 `hermes` 命令，也不能填缺少 Hermes 依赖的系统 Python。**

默认安装示例（按实际路径修改）：

```bash
export PASEO_HERMES_ROOT="$HOME/.hermes/hermes-agent"
export PASEO_HERMES_PYTHON="$PASEO_HERMES_ROOT/.venv/bin/python"
PYTHONPATH="$PASEO_HERMES_ROOT" "$PASEO_HERMES_PYTHON" -c 'import hermes_bootstrap, run_agent; print(hermes_bootstrap.__file__); print(run_agent.__file__)'
npm run smoke
```

若你用 micromamba，`PASEO_HERMES_PYTHON` 可以指向该环境的 `bin/python`，`PASEO_HERMES_ROOT` 指向 Hermes 源码目录。

Python 环境目录可能名为 `.venv` 或 `venv`。用户验证过的 macOS 安装使用 `$HOME/.hermes/hermes-agent/venv/bin/python`，请按实际路径填写，不能直接照搬 Linux 示例。

`smoke` 会使用你已有的 Hermes 配置发起一次真实模型请求，打印每次文本更新的时间和内容。它不保存会话，工具审批自动拒绝。正常情况下，可以在最后出现 `Result: completed` 之前看到多次 assistant 更新。只有一次更新时，应检查 Hermes 版本以及模型服务的流式能力。

## 3. 配置 Paseo daemon

将下面字段**合并**到 daemon 用户的 `~/.paseo/config.json`，保留已有 provider、relay 和其他配置。不要整个覆盖原文件。JSON 示例路径必须改成实际绝对路径。

```json
{
  "pluginsEnabled": true,
  "agents": {
    "providers": {
      "hermes-direct": {
        "label": "Hermes Direct",
        "paseoTools": {"enabled": false},
        "command": ["/home/ubuntu/.hermes/hermes-agent/.venv/bin/python"],
        "env": {
          "PASEO_HERMES_ROOT": "/home/ubuntu/.hermes/hermes-agent",
          "HERMES_HOME": "/home/ubuntu/.hermes"
        }
      }
    }
  }
}
```

macOS 示例（用户验证过的 `/Users/mac` 路径；用户名和 Python 环境名按实际修改）：

```json
{
  "pluginsEnabled": true,
  "agents": {
    "providers": {
      "hermes-direct": {
        "label": "Hermes Direct",
        "command": ["/Users/mac/.hermes/hermes-agent/venv/bin/python"],
        "env": {
          "PASEO_HERMES_ROOT": "/Users/mac/.hermes/hermes-agent",
          "HERMES_HOME": "/Users/mac/.hermes"
        },
        "paseoTools": {"enabled": false}
      }
    }
  }
}
```

两个配置均为合并示例，不是完整配置替换文件。`label` 用于兼容要求 custom provider 显式声明名称的 0.11 安装版本，不能省略。保留原有 Hermes ACP provider 和 `daemon.agentProfiles`；使用 Direct 时新建会话并选择 **Hermes Direct**。

首版关闭这个 provider 的 Paseo 工具注入（`paseoTools.enabled: false`），避免自动注入的 MCP 与首版能力不匹配；其他 provider 的设置不受影响。

使用非默认 Hermes profile 时，`HERMES_HOME` 应指向那个 profile 的目录。插件通过 Hermes 自己的 env loader、config loader 和 runtime provider resolver 读取配置，保留模型路由和凭据池。无需把 API Key 复制到插件。

`command` 是 Python 可执行文件数组；也可以用 env 里的 `PASEO_HERMES_PYTHON` 覆盖，它优先于 command。daemon 已经运行时，仅在 SSH 终端 export 不会改变 daemon 的环境，所以推荐把路径写进 provider 配置。

```bash
paseo reload --json
paseo plugin add "$PWD"
paseo plugin ls
paseo provider models hermes-direct
```

`paseo plugin add` 是当前 0.11 文档中的命令；若你的 0.11 构建使用参考项目所示的旧命名，可用 `paseo plugin install "$PWD"`。请按 `paseo plugin --help` 的实际命令执行。在 App 的 Settings → Plugins 里也要启用插件。

## 4. 手机端使用

连接原有服务器，新建会话，provider 选择 **Hermes Direct**。原有 Hermes ACP 会话不会自动转成 Direct 会话，第一次请新建。

建议验证：

1. 请求一段较长的文字，观察回复在生成中更新。
2. 追问上一轮内容，验证历史上下文。
3. 让模型执行一次普通的目录查看，观察工具卡片。
4. 生成过程中点击停止，等当前回合结束后再发送下一条。
5. 上传一张图片并要求描述，再发送多张图片进行比较；可以只发图片。
6. 关闭/重新打开持久会话，验证恢复。不要用关闭窗口代替停止运行中的模型任务。

已有 relay、自建 relay、Tailscale 等连接方式继续由 Paseo 负责。

## 功能范围

| 能力 | 首版状态 |
|---|---|
| 文本增量输出、推理增量输出 | 已实现；取决于模型和 Hermes 提供对应 delta |
| 多轮上下文 | 已实现 |
| 工具开始/完成卡片 | 已实现，通用输入/输出展示 |
| Hermes 原生命令审批 | 接入 Hermes terminal approval callback，提供单次允许/拒绝；不会自动开启 yolo |
| 中断、进程退出错误处理 | 已实现；停止请求不提前释放正在执行的回合 |
| 持久会话恢复 | 插件创建的会话可恢复；快照原子写入，跨进程锁避免并发恢复 |
| Hermes 已配置 MCP | 由 Hermes 自身发现和加载 |
| Paseo 向会话注入 MCP | 暂不支持，会明确拒绝；Paseo 自带编排 MCP 也不注入 |
| 图片、图片上传文件 | 已实现；PNG/JPEG/WebP/GIF，支持多图及文字混合 |
| Slash 命令与 `/` 菜单 | 已实现，见下方命令表 |
| 原生 steer、文字队列、持续目标 | 已实现，见下方命令表 |
| 非图片附件 | 暂不支持 |
| 当前会话模型切换 | 手机模型选择器（`session.configure`）和 `/model` 均已实现；保留历史并更新 Paseo 配置 |
| 原生 CLI 历史导入、plan mode | 暂不支持 |
| clarify 问答卡片、文件差异专项审批 | 暂未适配，不宣称与 CLI 交互完全等价 |

## Slash 命令

在手机输入 `/` 可看到命令菜单；也可以直接发送 `/context` 等文字命令。图文消息中以 `/` 开头的说明保持为普通图片提问。

| 命令 | 行为 |
|---|---|
| `/help` | 显示此插件支持的命令 |
| `/version` | 显示 Hermes 版本 |
| `/tools` | 列出当前 AIAgent 已加载的工具 |
| `/context` | 查看历史消息数、图片数、估算 token 用量和模型 |
| `/model` | 查看当前模型和 provider |
| `/model <model>` 或 `/model <provider:model>` | 通过 Hermes 原生路由验证与切换 API 更换当前会话模型，不修改全局 config.yaml |
| `/reset` | 清空模型上下文及当前原生会话消息，重置 Hermes 会话状态；显示时间线保留 |
| `/compress [here N 或 focus] [--preview]` | 通过 Hermes 原生 manual compression 核心压缩上下文；preview 不提交修改 |
| `/compact ...` | `/compress` 的别名 |
| `/stop` | 中断当前回合，暂停队列与目标，清掉待执行目标续轮；不提前释放正在取消的回合 |
| `/steer <text>` | 调用原生 `AIAgent.steer()`，在当前工具批次结束后注入指令；也支持 Paseo 原生 steer 投递 |
| `/queue <text>` | 在当前回合之后 FIFO 串行执行；空闲且队列未暂停时立即开始 |
| `/queue list/pause/resume/clear` | 查看、暂停、继续、清空待执行队列；pause/clear 不取消当前回合 |
| `/queue remove <N>` | 删除第 N 条待执行消息，编号从 1 开始 |
| `/goal <text>` 或 `/goal -- <text>` | 原生设置持续目标并开始执行；`--` 用于以控制词开头的目标文本 |
| `/goal status/show`（或 `/goal`） | 查看目标状态、预算和完成条件 |
| `/goal draft <text>` | 用 Hermes 辅助模型拟定完成条件；沿用原生失败回退行为 |
| `/goal pause/resume/clear` | 暂停、继续（重置回合预算）或清除目标；pause 不取消当前回合 |
| `/goal wait <pid> [reason]`、`/goal unwait` | 等待进程退出后自动续轮，或手动解除等待 |
| `/subgoal <text>` | 添加原生验收条件 |
| `/subgoal list/remove <N>/clear` | 查看、删除或清空验收条件 |

查询命令直接返回，不送给模型作为普通提示词。命令及其显示结果不加入模型对话历史。`/stop`、`/steer`、`/queue`、`/goal`、`/subgoal` 可在运行中使用，其余命令要求空闲会话；执行压缩或模型切换期间也拒绝新 prompt。未知命令明确报错。

`/compress` 可能调用配置的模型；不会硬截断历史，Hermes 不支持的 `--aggressive` 会被拒绝。压缩不删除显示时间线。`/reset` 会清空模型的图片上下文；`/model` 只改变当前会话并随插件快照恢复。失败的原生模型路由验证保持当前模型。新版 Hermes 没有某个原生接口时，会明确报错或不发布对应菜单项。

CLI/TUI 的交互式命令、插件自定义命令、`/new`、`/undo`、`/heartbeat`、`/loop` 等暂未适配，不能假设整个 Hermes CLI 命令集都可用。`/goal gate add` 明确拒绝：原生 shell 质量门不经过本插件的工具审批回调。目标的文本验证条件和 `/subgoal` 可正常使用。

`/steer` 仅接受文字，需要正在执行的模型回合；空闲时请用普通消息或 `/queue`。它不会立即中止当前 token 生成。`/queue` 是文字队列，不把其中的 `/xxx` 再解释成控制命令；例如 `/queue /goal status` 会把这段文字送给模型。用 `/queue -- list` 排队发送字面量 `list`。排队图片暂不支持，普通图片消息继续可用。

目标逻辑复用 `hermes_cli.goal_command.dispatch_goal_command` 与 `GoalManager.evaluate_after_turn`，每轮通过原生 judge 判定完成、继续、阻塞或等待；不是反复发送固定提示词。`config.yaml` 的 `goals.max_turns` 控制预算（原生默认 20）；判定和 `draft` 使用 Hermes 的辅助模型配置，可能产生额外模型调用。正常完成后才判定，异常或中断会暂停后续工作。目标续轮排在已等待的用户队列之后；所有模型回合共用同一串行执行通道。

`/goal pause/clear` 会清掉待执行的目标续轮，用户队列保留。`/queue pause` 暂停整个待执行通道；`/goal resume` 明确恢复目标时也会启用该通道。`/stop` 或 Paseo 中断会暂停队列和目标；`/queue resume` 只恢复保留的用户消息，目标要用 `/goal resume` 恢复。`/reset` 还会清空目标及待执行队列。

待执行队列写入插件快照，目标/验收条件使用 Hermes 原生状态存储。恢复会话时，待执行队列和活动目标均暂停，分别用 `/queue resume`、`/goal resume` 继续。已取出的任务先从队列持久化删除，再执行：进程崩溃后不会自动重复执行，但当前未完成任务可能需要手动重发。目标 judge/draft 运行时控制请求可能等待该调用结束；pause/stop 的调度停止信号立即记录，避免判定完成后又偷偷启动下一轮。

可以先直接测试真实 Hermes 的只读命令：

```bash
npm run smoke -- --command help
npm run smoke -- --command context
npm run smoke -- --command model
```

手机端可在空闲会话使用模型选择器切换：插件协商 `session.configure` 能力，并复用 `/model` 的 Hermes 原生模型路由与切换接口。成功后先更新 `session.config`，再完成配置请求；不会新增用户/助手消息或对话回合，历史和图片上下文保留。模型/原生 provider 随持久快照恢复；清除选择（model 为 null）或选择 `default` 时回到 Hermes 默认模型及其解析出的 provider。正在执行或切换模型时拒绝新的切换和普通 prompt；不支持的 mode、thinkingOption、settings 非空配置整体拒绝，不会先改模型再报错。更新插件后关闭并恢复原会话，或新建会话，以重新协商能力。

模型列表来自 Hermes 默认模型；额外候选可通过 `PASEO_HERMES_MODELS` 配置为逗号分隔列表。它只是候选名称列表，不负责创建模型服务或验证可用性。`PASEO_HERMES_MODEL` 可覆盖默认模型。

图片会转换为 Hermes 原生的 OpenAI 风格 `image_url` 多模态内容，顺序与发送时一致。上传文件会读入图片字节，恢复后的上下文不依赖临时路径。单次消息的图片合计上限为 **20 MiB**（解码后的大小）。会校验 base64、MIME 与文件头，错误会明确返回。GIF 是否按静态图处理取决于模型服务。

**须选择支持视觉输入的模型。** 插件不会让纯文本模型获得识图能力。手机原始 HEIC/HEIF 图片请先转换成 JPEG/PNG。

可使用自己的测试图验证真实模型：

```bash
npm run smoke -- --image /path/to/scene.jpg "这张图片里有什么？"
npm run smoke -- --image /path/to/a.png --image /path/to/b.jpg "比较这两张图片"
```

持久会话快照位于 `$HERMES_HOME/paseo-direct/<uuid>.json`，包含模型上下文、图片 data URL、待执行队列和显示时间线；文件以 0600 写入。恢复同一会话要求相同 cwd。快照在建会话和回合结束时保存；强制杀进程不保证保存当前未完成回合。持久会话还传入 Hermes 原生 SessionDB。不会扫描、导入或改变已有 CLI 会话。

## 常见问题

- **Provider 不可用 / No module named run_agent**：Python 或源码路径错误。检查上面的 import 命令，然后 `paseo reload`，新建会话。
- **No module named hermes_bootstrap / 缺少回调或 cwd 参数**：Hermes 版本过旧或安装不完整。修复 Hermes 安装后重试。
- **完整答案才一次出现**：先执行 `npm run smoke` 区分 Hermes/model 端和 Paseo 端问题。Direct 不会制造模型端没有提供的 token 流。
- **busy**：当前回合仍在运行，先停止并等结束。普通消息在运行中仍会拒绝；追加任务用 `/queue`，当前回合补充指令用 `/steer`。
- **session is already in use**：同一持久会话仍有另一个桥接进程持锁。先关闭原会话/进程，不能删除锁文件绕过活动进程。
- **MCP 注入错误**：将对应 MCP 配置到 Hermes `config.yaml`，关闭该会话的 Paseo MCP 注入。

## 开发与来源

```bash
npm run build
npm run typecheck
npm test
```

40 项 Node 测试覆盖手机模型切换协议、切换后的历史及恢复、默认模型重置、路由/原生切换失败恢复、切换并发防护、能力协商，以及目标继续/完成/预算/阻塞、暂停防止过期续轮、subgoal 恢复、wait/unwait、steer 注入和原生投递、队列 FIFO 和暂停恢复，以及 slash 菜单、结构化命令和文字命令、命令能力协商、查询命令不调用模型、重置及模型切换后的恢复、压缩预览/失败恢复、命令并发防护、stop，以及图片纯输入、多图和文字顺序、图片文件内联、格式与大小拒绝、图片历史恢复、能力协商、实时文本到达、推理和工具事件、最终答案去重、多轮恢复、busy、中断、审批拒绝与解除、错误恢复、配置/附件拒绝、跨进程锁以及 provider status/catalog。每个输出事件均通过 Paseo SDK `ProviderEventSchema` 验证。

架构参考：<https://github.com/Jecvay/paseo-dsh-direct>。本项目没有复制该项目的实现；直接使用 Paseo 公开 Provider SDK 和 Hermes 原生 AIAgent 回调。

相关现有工作：<https://github.com/narzaut/paseo> 是带 Hermes gateway 集成的 Paseo 分支，不是可单独安装的 `paseo-hermes-direct` 插件。

图片、slash、steer、queue 和目标更新保持 provider ID 和持久化格式不变。已安装者在更新源码并重新 build 后执行 `paseo plugin reload paseo-hermes-direct`，然后新建会话或关闭并恢复原会话；以 `paseo plugin --help` 的命令为准。若更新本地插件后未生效，重新执行 `paseo plugin add "$PWD"`。

已发布到 GitHub（[ljfrankie/paseo-hermes-direct](https://github.com/ljfrankie/paseo-hermes-direct)），尚未发布到 npm，因此不能使用 `npm:paseo-hermes-direct` 安装。
