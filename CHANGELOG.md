# Release notes / 发布说明

## v0.1.1 — 2026-10-13

### English

- Fix Windows deletion path validation using Node's native relative-path rules. Support drive letters, case-insensitive comparisons, mixed separators, UNC shares and namespaced paths.
- Refuse paths outside persistence storage, storage roots themselves and unknown storage roots before releasing or removing a session.
- Use bounded recursive-removal retries for temporary busy-file conditions. Session teardown still completes before deletion; persistent filesystem errors are reported.
- Publish one version for Windows and macOS, with a pinned GitHub installation link in concise bilingual documentation.

Validation: 49 path and host-service checks passed, including macOS filesystem operations and Windows path semantics with filesystem calls mapped to temporary local storage. Integration with the shipped DSH Cordis, AgentRegistry, SessionStore and JSONL writer also passed on macOS using an idle agent factory. Windows kernel file locking and the Windows Desktop UI have not been tested on a Windows machine. Test and verification scripts are kept outside this repository.

### 中文

- 使用 Node 原生相对路径规则修复 Windows 删除校验，覆盖盘符、大小写、混合分隔符、UNC 共享及命名空间路径。
- 在释放或删除会话前，拒绝越界路径、持久化根目录本身及未知根目录。
- 为文件暂时占用增加有限次数的递归删除重试；仍先完成会话释放，持续的文件系统错误正常报告。
- Windows 与 macOS 共用一个版本，中英文文档精简并提供固定版本安装链接。

验证：49 个路径及宿主服务检查通过，覆盖 macOS 文件系统操作，以及映射到本机临时存储的 Windows 路径模拟。使用空闲 Agent 工厂，在 macOS 上对发行包真实的 Cordis、AgentRegistry、SessionStore 和 JSONL 写入句柄进行集成验证并通过。尚未在 Windows 实机验证内核文件锁和桌面界面。测试及验证脚本保留在仓库之外。
