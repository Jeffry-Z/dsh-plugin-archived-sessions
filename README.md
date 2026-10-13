# Archived Sessions for DeepSeek Harness

English | [简体中文](README.zh-CN.md)

A plugin for managing archived conversations in **DeepSeek Harness (DSH)**. View archived sessions in one settings page, restore them to the workspace, or permanently delete their logs. After deletion, the conversation disappears from the workspace sidebar and the **Ungrouped** list without a page refresh.

An independent community plugin. It does not modify the installed DSH packages.

## Features

- **Archive manager:** a dedicated **Settings → Archived sessions** page with session title, workspace, creation time and log size.
- **Restore:** unarchive a conversation while keeping its files.
- **Permanent deletion:** remove the entire session log directory, including older log generations. The settings page creates no quarantine backup.
- **Sidebar synchronization:** notify all connected clients to remove the deleted session, including when an older list request is still in flight.
- **Remembered confirmation:** acknowledge the irreversible action and confirm once to skip future deletion dialogs in that browser storage context. Canceling does not save the preference.
- **Resident session cleanup:** release tracked sessions through DSH's own lifecycle handle before removing files.
- **Refresh:** manually reload archive changes made from the sidebar or another window. The page also reloads after its own actions.
- **Legacy backup cleanup:** remove quarantine backups left by earlier versions. This section appears only when such backups exist.
- **English and Simplified Chinese UI.**

Deleting a conversation is irreversible. “Restore” applies to archived conversations that have not been deleted.

## Compatibility

| Item | Scope |
| --- | --- |
| DSH version | Developed against `0.2.0-rc.2` |
| Verified environment | macOS, Desktop profile, JSONL session persistence |
| Runtime dependencies | Supplied by DSH; no npm dependencies declared by this plugin |
| Build step | None; plain JavaScript and a Cordis bundle patch |

Other DSH versions, platforms and persistence backends have not been validated. The lifecycle and Remote protocol integration depends on the host's behavior, so review compatibility before upgrading DSH.

## Installation

### Install from GitHub in Desktop (recommended)

1. Open **DeepSeek Harness Desktop** and select **Plugins** in the sidebar.
2. Click **Add plugin** and paste this repository URL into the package input:

   ```text
   https://github.com/Jeffry-Z/dsh-plugin-archived-sessions
   ```

3. Click **Install** and wait for it to finish, then click **Enable now**. If you close the dialog instead, enable the plugin from the installed plugins list.
4. **Fully quit and reopen DSH**, then open **Settings → Archived sessions**.

No manual clone, command-line installation or profile editing is needed. A full restart lets the plugin capture session lifecycle handles from creation or resume; closing a conversation or window alone does not necessarily stop its backend.

### Update and uninstall

DSH `0.2.0-rc.2` does not automatically update installed plugins. To update, uninstall `dsh-plugin-archived-sessions` from **Plugins**, install it again using the GitHub URL above, enable it, and fully restart DSH.

To remove the plugin, select it in **Plugins** and click **Uninstall**. Uninstalling does not restore deleted conversations or remove runtime deletion records.

### Install a local checkout for development

For source changes, clone this repository:

```sh
git clone https://github.com/Jeffry-Z/dsh-plugin-archived-sessions.git
cd dsh-plugin-archived-sessions
```

Open DSH Desktop at least once to initialize its profile, then fully quit it. From the checkout, use the `dsh` command installed by **DeepSeek Harness Desktop**:

```sh
dsh plugin --profile desktop add "link:$PWD"
```

The npm-distributed `dsh` command cannot manage the `desktop` profile. Keep the checkout in a permanent location because the profile links to it directly. No build or dependency installation is needed inside the plugin directory. Fully restart DSH after installing or changing the source. To update this linked checkout, run `git pull --ff-only` and restart DSH.

## How it works

### Host and settings page

`cordis.patch.yml` mounts the host plugin. The `dsh.client` package metadata and `./client` export register a browser module with DSH's existing module loader. The module adds a settings page using the host's React components and localization facilities.

The host combines the workspace archive set with session headers, projection-cache titles and persistence metadata. Listing does not read conversation message bodies. The browser calls the existing authenticated HTTP Remote carrier at `/api/archivedSessions/<method>`.

`lib/protocol.js` implements the small Remote binding and method-marker surface required by the DSH gateway. This avoids imports of host packages that are not resolvable from an external plugin directory. Host methods must remain unminified: the gateway derives argument names from their source.

### Deletion lifecycle

1. Verify that the session is archived and validate its persistence path. Reject sessions created in memory that have not yet written any artifact.
2. Serialize deletion for the same session ID and fence concurrent create/resume calls.
3. For a resident session, await its captured `AgentHandle.dispose()` so DSH closes the writer and unregisters the session. Untracked handles or incomplete release cause deletion to be refused.
4. Remove the full session directory and record the deleted ID.
5. Detach workspace membership, emit `api-session/removed`, then clear the archived state. The host forwards the event to connected clients, whose existing session manager also replays the removal over an in-flight list response.
6. Attempt to evict the session's projection-cache entry.

The plugin tracks public `agents.create()` and `agents.resume()` results, preserves the caller's Cordis ownership, and restores the original methods when unloaded. It does not directly remove entries from the host's internal Agent or Session registries.

### Deletion records and older backups

By default, runtime data lives beside the session persistence root:

```text
~/.dsh/archived-session-deletions/
├── .tombstones/
│   └── <encoded-session-id>.json
└── <legacy-backup-directory>/      # only if an older or explicit API deletion made one
```

A tombstone contains only the session ID and deletion timestamp, **not conversation contents**. Recording it is best-effort. It prevents the plugin from recreating or resuming a deleted ID after restart when the record is available. Backup cleanup preserves these records.

For backward compatibility, Remote callers may explicitly request `keepBackup: true`. The settings page always sends `keepBackup: false`; default API deletion also removes files directly. Historical backups are never automatically purged.

### Remote methods

All endpoints use the `/api/archivedSessions/` prefix:

| Method | Purpose | Wire arguments (`payload.args`) |
| --- | --- | --- |
| `list` | List archived session metadata | `{}` |
| `delete` | Delete an archived session | `{ "request": { "sessionId": "…", "keepBackup": false } }` |
| `unarchive` | Restore an archived session | `{ "request": { "sessionId": "…" } }` |
| `listBackups` | List historical quarantine backups | `{}` |
| `pruneBackups` | Remove one backup, or all backups when `name` is omitted | `{ "request": { "name": "…" } }` |

These methods use DSH's `client-request` envelope and existing authentication. Request-taking methods require the `request` wrapper. See [the client implementation](lib/client.js) for the complete envelope and error handling.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Settings page is missing | Check the profile dependency and `dsh.profile.bundles`; fully restart DSH. |
| Session is still resident or its handle is untracked | Fully quit and reopen DSH. Switching conversations does not dispose a backend session; sessions loaded before the plugin cannot have their original handles captured retroactively. |
| Release fails | Files are preserved when lifecycle release fails. Restart DSH and retry. |
| Session has not been materialized | Wait for its first persisted write before deleting. |
| Archive list appears outdated | Click **Refresh**. The page does not subscribe to archive changes made elsewhere. |
| Confirmation keeps returning | The preference uses `localStorage`. Clearing site data or using another browser storage context resets it; unavailable storage keeps confirmation enabled. |

DSH `0.2.0-rc.2` retains some session headers in an internal cache without a public eviction API. An external call may still rearchive a deleted ID; the plugin marks that entry as deleted and blocks create/resume through the tracked entry points. The normal deletion flow removes its sidebar summary immediately.

## Project layout

```text
dsh-plugin-archived-sessions/
├── lib/
│   ├── index.js                 # host service and Remote endpoints
│   ├── lifecycle.js             # handle tracking and deletion coordination
│   ├── protocol.js              # local Remote protocol adapter
│   └── client.js                # settings page and bilingual UI
├── cordis.patch.yml             # plugin bundle registration
├── package.json                 # DSH metadata and exports
├── README.md
├── README.zh-CN.md
├── LICENSE
└── THIRD_PARTY_NOTICES.md
```

The repository contains runtime code and documentation. Local test harnesses, verification scripts, private session data and investigation records are excluded. The package is installed from source; no npm registry release is assumed.

## Contributing

Issues and pull requests are welcome. Include your DSH version, operating system, persistence backend, steps to reproduce and relevant error code. Remove conversation contents, authentication cookies and private paths from reports.

The source runs directly without a build step. For behavioral verification in DSH, create dedicated disposable sessions and check deletion, restore, restart and sidebar behavior.

## License

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for the attribution of DSH-derived protocol behavior and algorithms.
