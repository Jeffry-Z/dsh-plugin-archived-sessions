# DeepSeek Harness 归档会话管理

[English](README.md) | 简体中文

集中查看、恢复或永久删除 DeepSeek Harness 已归档的对话。删除后，侧栏入口立即消失。

## 功能

- 查看归档会话的标题、工作区、创建时间和日志大小。
- 将归档对话恢复到工作区。
- 永久删除对话日志，不生成备份。
- 勾选并确认后，记住「今后不再提醒」的删除偏好。
- 支持中英文界面。

## 安装

当前版本 **v0.1.1**，针对 DSH **0.2.0-rc.2** 开发。

| 系统 | 在桌面端「添加插件」中粘贴的链接 |
| --- | --- |
| Windows | `https://github.com/Jeffry-Z/dsh-plugin-archived-sessions#v0.1.1` |
| macOS | `https://github.com/Jeffry-Z/dsh-plugin-archived-sessions#v0.1.1` |

两种系统使用同一个版本，安装链接相同。

1. 打开 **DeepSeek Harness Desktop → 插件 → 添加插件**。
2. 粘贴上面的链接，点击「**安装**」，完成后点击「**立即启用**」。
3. 完全退出并重新打开 DSH，进入「**设置 → 归档会话**」。

无需命令行或手动下载。验证范围见[发布说明](CHANGELOG.md)。

## 更新与卸载

- **更新：** 在桌面端卸载旧插件，再使用新版本链接安装、启用并完整重启 DSH。
- **卸载：** 在「插件」中选择 `dsh-plugin-archived-sessions`，点击「卸载」并确认。

## 使用

「**恢复**」保留对话文件；「**删除**」永久移除文件，不可撤销。勾选「今后不再提醒」并确认删除后，偏好会保存在浏览器存储中。

在其他位置归档了对话时，点击「**刷新**」读取最新列表。只有旧版本留下备份时，才显示历史备份区域。

## 实现方式

通过 Cordis bundle 挂载宿主服务，浏览器模块添加设置页。删除时先释放已追踪的会话句柄，再删除文件、解除工作区关联、发出 DSH 已有的移除通知，最后解除归档。路径校验使用 Node 原生规则，适配 Windows 和 macOS。

插件不修改 DSH 安装包。源码：[宿主服务](lib/index.js)、[生命周期](lib/lifecycle.js)、[路径校验](lib/paths.js)、[Remote 适配](lib/protocol.js)、[设置页面](lib/client.js)。

## 许可证

[MIT](LICENSE) · [第三方声明](THIRD_PARTY_NOTICES.md)
