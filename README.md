# Archived Sessions for DeepSeek Harness

English | [简体中文](README.zh-CN.md)

Manage archived conversations in DeepSeek Harness: view, restore or permanently delete them. Deleted conversations disappear from the sidebar immediately.

## Features

- View archived sessions, including title, workspace, creation time and log size.
- Restore archived conversations to the workspace.
- Permanently delete conversation logs without creating a backup.
- Remember the deletion confirmation preference after you acknowledge it and confirm.
- English and Simplified Chinese UI.

## Installation

Version **v0.1.1**, developed for DSH **0.2.0-rc.2**.

| System | Paste this link into Desktop's Add plugin dialog |
| --- | --- |
| Windows | `https://github.com/Jeffry-Z/dsh-plugin-archived-sessions#v0.1.1` |
| macOS | `https://github.com/Jeffry-Z/dsh-plugin-archived-sessions#v0.1.1` |

Both systems use the same version and installation link.

1. Open **DeepSeek Harness Desktop → Plugins → Add plugin**.
2. Paste the link above, click **Install**, then **Enable now**.
3. Fully quit and reopen DSH, then open **Settings → Archived sessions**.

No terminal commands or manual download are needed. Validation scope: [release notes](CHANGELOG.md).

## Update and uninstall

- **Update:** uninstall the old plugin in Desktop, then install the link for the new version, enable it and fully restart DSH.
- **Uninstall:** open **Plugins**, select `dsh-plugin-archived-sessions`, click **Uninstall** and confirm.

## Usage

**Restore** keeps conversation files. **Delete** permanently removes them and cannot be undone. Checking the confirmation's “Don't ask again” option and confirming saves your choice in browser storage.

Click **Refresh** to load archive changes made elsewhere. A legacy backup section appears only when earlier versions left backups.

## Implementation

A Cordis bundle mounts the host service and a browser module adds the settings page. Deletion releases the tracked session handle, removes its files and workspace membership, emits DSH's existing removal event, then clears the archived state. Node's native path rules handle Windows and macOS directories.

The plugin does not modify DSH's installed packages. Source: [host service](lib/index.js), [lifecycle](lib/lifecycle.js), [path validation](lib/paths.js), [Remote adapter](lib/protocol.js), [settings page](lib/client.js).

## License

[MIT](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)
