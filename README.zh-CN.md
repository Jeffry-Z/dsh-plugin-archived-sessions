# DeepSeek Harness 归档会话管理

[English](README.md) | 简体中文

为 **DeepSeek Harness（DSH）** 提供集中管理已归档对话的插件。在设置页查看归档会话、恢复到工作区，或永久删除日志。删除成功后，对话会立即从工作区侧栏和「未分组」列表消失，无需刷新页面。

本项目是独立的社区插件，不修改 DSH 安装包中的代码。

## 功能介绍

- **集中管理归档会话：** 在「设置 → 归档会话」中查看标题、工作区、创建时间和日志大小。
- **恢复到工作区：** 取消归档，保留对话文件。
- **永久删除：** 移除整个会话日志目录，包括旧版本日志；设置页的删除操作不生成隔离备份。
- **同步移除侧栏入口：** 通知所有已连接客户端删除会话摘要；即使旧列表请求仍在进行，也不会把刚删除的入口重新插回。
- **记住删除确认：** 首次勾选「我了解此操作不可撤销，今后不再提醒」并确认删除后，同一浏览器存储环境中不再弹出确认框；取消不会保存偏好。
- **释放驻留会话：** 删除已追踪的驻留会话前，通过 DSH 自身的生命周期句柄停止并释放会话。
- **手动刷新：** 读取侧栏或其他窗口产生的归档变化；本页面操作完成后也会自动刷新。
- **清理历史备份：** 查看并删除旧版本留下的隔离备份，仅在存在此类备份时显示该区域。
- **中英文界面。**

删除不可撤销。「恢复到工作区」仅适用于尚未删除的归档会话。

## 兼容性

| 项目 | 范围 |
| --- | --- |
| DSH 版本 | 针对 `0.2.0-rc.2` 开发 |
| 已验证环境 | macOS、Desktop profile、JSONL 会话持久化 |
| 运行依赖 | 由 DSH 提供，插件没有声明额外 npm 依赖 |
| 构建步骤 | 无，直接加载 JavaScript 和 Cordis bundle patch |

其他 DSH 版本、操作系统和持久化后端尚未验证。插件依赖宿主的生命周期与 Remote 协议行为，升级 DSH 前请确认兼容性。

## 安装方式

### 1. 获取源码

克隆本项目：

```sh
git clone https://github.com/Jeffry-Z/dsh-plugin-archived-sessions.git
cd dsh-plugin-archived-sessions
```

请将源码目录放在固定位置，后续安装会直接链接到它。插件目录内无需构建或安装依赖。

### 2. 初始化桌面配置

至少打开一次 DeepSeek Harness Desktop，使其初始化桌面 profile，然后**完全退出应用**。只关闭对话或窗口不一定会停止后端。

### 3. 使用桌面版命令安装

在克隆的目录中，使用 **DeepSeek Harness Desktop 安装的 `dsh` 命令**：

```sh
dsh plugin --profile desktop add "link:$PWD"
```

此命令会将本地插件安装到桌面 profile，并登记其 bundle。npm 发行的 `dsh` 命令不能管理 `desktop` profile；请使用桌面版命令，或采用下面的手动安装方式。

### 手动安装

如果桌面版命令不可用，在 DSH 完全退出后编辑 `~/.dsh/profiles/desktop/package.json`。若配置了 `DSH_HOME`，请以该目录替代 `~/.dsh`。

将以下内容合并到现有配置中，保留其他依赖及 bundle：

1. 在 `dependencies` 中加入插件，路径必须是源码目录的**绝对路径**：

   ```json
   "dsh-plugin-archived-sessions": "link:/absolute/path/dsh-plugin-archived-sessions"
   ```

2. 在现有 `dsh.profile.bundles` 数组末尾加入 `"dsh-plugin-archived-sessions"`。

随后使用 pnpm 安装 profile 依赖：

```sh
pnpm --dir "$HOME/.dsh/profiles/desktop" install
```

自定义了 `DSH_HOME` 时，请相应调整路径。此方式需要本机已有 pnpm。源码安装建议使用 `link:`；移动或删除源码目录会使 profile 中的链接失效。

### 4. 重启并打开管理页面

重新启动 DSH，进入「设置 → 归档会话」。必须完整重启，让插件从会话创建或恢复阶段开始捕获生命周期句柄。

更新链接安装的插件时，在源码目录拉取最新代码，然后完全退出并重新打开 DSH：

```sh
git pull --ff-only
```

卸载时，先完全退出 DSH，再使用桌面版命令：

```sh
dsh plugin --profile desktop remove dsh-plugin-archived-sessions
```

卸载不会恢复已删除的对话，也不会移除运行时的删除记录。

## 实现方式

### 宿主服务与设置页面

`cordis.patch.yml` 负责挂载宿主插件。`package.json` 中的 `dsh.client` 元数据和 `./client` 导出将浏览器模块注册到 DSH 的模块加载器，使用宿主已有的 React 组件与国际化能力添加设置页。

宿主将工作区归档集合与会话头部、投影缓存中的标题及持久化元数据合并。列出会话不读取对话消息正文。浏览器通过宿主已有的、带身份认证的 HTTP Remote 通道 `/api/archivedSessions/<method>` 调用服务。

`lib/protocol.js` 本地实现网关所需的小部分 Remote 绑定和方法标记，避免外部插件目录无法解析宿主包导入的问题。宿主方法应保持未压缩，因为网关会从方法源码提取参数名。

### 删除流程

1. 确认会话已归档，验证持久化路径；拒绝仅在内存中创建、尚未写入任何文件的会话。
2. 同一会话 ID 的删除串行执行，并阻止并发创建或恢复。
3. 对驻留会话，等待已捕获的 `AgentHandle.dispose()` 完成，由 DSH 关闭写入句柄并注销会话。没有可追踪句柄或释放不完整时拒绝删除。
4. 移除整个会话目录，记录已删除的 ID。
5. 解除工作区关联，发出 `api-session/removed`，再解除归档。宿主将事件转发到各客户端，已有的会话管理器也会在进行中的旧列表响应上重放删除操作。
6. 尝试清理该会话的投影缓存。

插件追踪公开 `agents.create()` 和 `agents.resume()` 返回的句柄，保留原调用方的 Cordis 所有权，卸载时恢复原方法；不直接从宿主内部 Agent 或 Session 注册表删除条目。

### 删除记录与旧备份

默认运行数据位于会话持久化根目录的同级位置：

```text
~/.dsh/archived-session-deletions/
├── .tombstones/
│   └── <编码后的会话ID>.json
└── <历史备份目录>/                 # 仅旧版或明确请求备份的 API 删除会生成
```

删除记录只包含会话 ID 和删除时间，**不包含对话内容**。写入采用尽力完成的方式；记录存在时，插件重启后会据此阻止重新创建或恢复已删除 ID。清理备份会保留这些记录。

为兼容旧 Remote 调用方，API 仍允许显式传入 `keepBackup: true`。设置页始终传入 `keepBackup: false`，API 默认也直接删除文件。历史备份不会被自动清空。

### Remote 接口

所有接口均使用 `/api/archivedSessions/` 前缀：

| 方法 | 作用 | 请求参数（`payload.args`） |
| --- | --- | --- |
| `list` | 列出已归档会话元数据 | `{}` |
| `delete` | 删除已归档会话 | `{ "request": { "sessionId": "…", "keepBackup": false } }` |
| `unarchive` | 恢复归档会话 | `{ "request": { "sessionId": "…" } }` |
| `listBackups` | 列出历史隔离备份 | `{}` |
| `pruneBackups` | 删除指定备份；省略 `name` 时清空备份 | `{ "request": { "name": "…" } }` |

接口沿用 DSH 的 `client-request` 请求信封和身份认证。接收请求对象的方法必须包含 `request` 包装层。完整信封及错误处理见[客户端实现](lib/client.js)。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 设置中没有归档会话页面 | 检查 profile 依赖和 `dsh.profile.bundles`，完全重启 DSH。 |
| 提示会话仍驻留或句柄未追踪 | 完全退出并重新打开 DSH。切换对话不会释放后端会话；插件加载前已创建的原始句柄无法事后捕获。 |
| 会话释放失败 | 生命周期释放失败时文件会保留；重启 DSH 后重试。 |
| 会话尚未落盘 | 等待首次持久化写入完成后再删除。 |
| 归档列表未反映其他窗口的变化 | 点击「刷新」；页面尚未订阅其他位置的归档变更。 |
| 删除确认重新出现 | 偏好保存在 `localStorage` 中；清理站点数据或切换浏览器存储环境会重置。存储不可用时仍显示确认框。 |

DSH `0.2.0-rc.2` 的部分内部会话头部缓存没有公开清理接口。外部调用仍可能再次归档已删除 ID；插件会将该项标记为已删除，并通过已追踪入口阻止创建或恢复。正常删除流程会立即移除侧栏摘要。

## 项目结构

```text
dsh-plugin-archived-sessions/
├── lib/
│   ├── index.js                 # 宿主服务与 Remote 接口
│   ├── lifecycle.js             # 句柄追踪与删除协调
│   ├── protocol.js              # 本地 Remote 协议适配
│   └── client.js                # 设置页面与中英文界面
├── cordis.patch.yml             # 插件 bundle 注册
├── package.json                 # DSH 元数据与导出
├── README.md
├── README.zh-CN.md
├── LICENSE
└── THIRD_PARTY_NOTICES.md
```

仓库仅包含运行代码和文档。本地测试模型、验证脚本、私人会话数据和调查记录不纳入项目。插件采用源码安装，不假设已有 npm 发行版本。

## 参与贡献

欢迎提交 Issue 和 Pull Request。问题报告请包含 DSH 版本、操作系统、持久化后端、复现步骤及相关错误码，并移除对话内容、认证 Cookie 和私人路径。

源码无需构建。验证 DSH 中的实际行为时，请创建专用的可删除测试会话，检查删除、恢复、重启及侧栏同步。

## 许可证

采用 [MIT 许可证](LICENSE)。DSH 协议行为及算法的来源说明见[第三方声明](THIRD_PARTY_NOTICES.md)。
