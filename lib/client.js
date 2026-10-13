/**
 * dsh-plugin-archived-sessions — browser half.
 *
 * Adds an "归档会话" (Archived Sessions) page to Settings that lists every
 * archived Session and lets the operator restore or permanently delete one.
 *
 * Two constraints shape this file:
 *
 * 1. It ships as PLAIN JavaScript wrapped in `window.__ModuleLoader__.load`,
 *    the envelope `@deepseek-ai/dsh-client-modules` serves. There is no bundler
 *    step and no import of a Host package.
 *
 * 2. It reaches its Host half with a plain `fetch` POST to
 *    `/api/archivedSessions/<method>` rather than `ctx.remote.<namespace>`.
 *    `ctx.remote` is a build-time-frozen assembly in `@deepseek-ai/dsh-api-remotes`
 *    and its generated face refuses the `src-json` codecs an ungenerated
 *    plugin produces; the Gateway's own `/api` carrier resolves endpoints
 *    dynamically, so it accepts any plugin's namespace.
 *
 * The page reads the archived id set from the already-trusted
 * `ctx.remote.workspace` namespace and joins it with the plugin's own richer
 * rows, so the archive list never depends on this plugin alone being loaded.
 */
window.__ModuleLoader__.load({
	id: 'dsh-plugin-archived-sessions',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const react = require('react');
		const { jsx, jsxs } = require('react/jsx-runtime');
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
		const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store');

		//#region locale
		/** Dictionary namespace owned by this plugin. */
		const NS = 'archivedSessions';

		/** Simplified-Chinese copy. */
		const zh = {
			nav: '归档会话',
			title: '归档会话管理',
			intro: '列出全部已归档的会话，可将其恢复到工作区，或永久删除。',
			refresh: '刷新',
			loading: '正在读取归档会话…',
			failed: '读取失败：{message}',
			retry: '重试',
			empty: '没有已归档的会话。',
			count: '{count} 个已归档会话',
			columnTitle: '标题',
			columnWorkspace: '工作区',
			columnCreated: '创建时间',
			columnSize: '大小',
			columnActions: '操作',
			untitled: '（无标题）',
			noWorkspace: '未归属工作区',
			missing: '日志已不存在',
			alreadyDeleted: '已删除',
			subagent: '子会话',
			restore: '恢复到工作区',
			restoring: '正在恢复…',
			delete: '永久删除',
			deleting: '正在删除…',
			restored: '已恢复会话「{title}」',
			deleted: '已删除会话「{title}」',
			actionFailed: '操作失败：{message}',
			residentUntracked: '此会话的释放句柄尚未被插件追踪。请完全退出并重新打开应用一次，再重试；仅关闭对话页面不会释放它。',
			releaseFailed: '未能安全释放会话，对话文件尚未删除。请完全退出并重新打开应用后重试。',
			deleteInProgress: '此会话正在删除，请等待操作完成。',
			persistenceUnavailable: '暂时无法读取对话日志，尚未删除任何文件。请稍后重试。',
			confirmTitle: '永久删除已归档会话？',
			confirmBody: '这会从磁盘移除会话「{title}」的全部日志文件，并从归档列表中移除。此操作不可撤销。',
			confirmAcknowledge: '我了解此操作不可撤销，今后不再提醒',
			confirmCancel: '取消',
			confirmDelete: '永久删除',
			backups: '历史隔离备份',
			backupsIntro: '早期版本保留的隔离备份，可在此清空。',
			backupsEmpty: '没有隔离的备份。',
			backupPath: '位置：{path}',
			pruneAll: '清空全部备份',
			pruneOne: '删除此备份',
			pruned: '已清空 {count} 份备份',
			close: '关闭'
		};

		/** English copy. */
		const en = {
			nav: 'Archived sessions',
			title: 'Archived session management',
			intro: 'Every archived Session, ready to restore to its workspace or delete permanently.',
			refresh: 'Refresh',
			loading: 'Reading archived sessions…',
			failed: 'Could not load: {message}',
			retry: 'Retry',
			empty: 'No archived sessions.',
			count: '{count} archived sessions',
			columnTitle: 'Title',
			columnWorkspace: 'Workspace',
			columnCreated: 'Created',
			columnSize: 'Size',
			columnActions: 'Actions',
			untitled: '(untitled)',
			noWorkspace: 'No workspace',
			missing: 'log already gone',
			alreadyDeleted: 'already deleted',
			subagent: 'subagent',
			restore: 'Restore to workspace',
			restoring: 'Restoring…',
			delete: 'Delete permanently',
			deleting: 'Deleting…',
			restored: 'Restored “{title}”',
			deleted: 'Deleted “{title}”',
			actionFailed: 'Action failed: {message}',
			residentUntracked: 'The plugin has not tracked this conversation’s release handle. Fully quit and reopen the app once, then retry; closing the conversation page does not release it.',
			releaseFailed: 'The conversation could not be safely released. Its files were not deleted. Fully quit and reopen the app, then retry.',
			deleteInProgress: 'This conversation is being deleted. Wait for the operation to finish.',
			persistenceUnavailable: 'The conversation log could not be read. No files were deleted. Try again later.',
			confirmTitle: 'Permanently delete this archived Session?',
			confirmBody: 'This removes every log file of “{title}” from disk and drops it from the archive list. It cannot be undone.',
			confirmAcknowledge: 'I understand this cannot be undone; don’t remind me again',
			confirmCancel: 'Cancel',
			confirmDelete: 'Delete permanently',
			backups: 'Historical quarantine backups',
			backupsIntro: 'Quarantine backups kept by earlier versions can be cleared here.',
			backupsEmpty: 'No quarantined backups.',
			backupPath: 'Location: {path}',
			pruneAll: 'Clear all backups',
			pruneOne: 'Delete this backup',
			pruned: 'Cleared {count} backups',
			close: 'Close'
		};
		//#endregion

		//#region host calls
		/**
		 * Call the plugin's own Host namespace over the Gateway's unary RPC
		 * carrier. The reply envelope is the shared Connection shape
		 * `{ type, rpcId, result: { ok, value | error } }`.
		 *
		 * ARGUMENT SHAPE. The Gateway resolves this plugin's methods through its
		 * SRC path, which derives the wire field names from the Host method's
		 * **parameter names** (it reads `Function.prototype.toString()`). Every
		 * Host method that takes a request therefore declares a parameter named
		 * `request`, and each call must nest its payload under that name — a flat
		 * `{ sessionId }` is rejected with `gateway/arguments-invalid`. Methods
		 * taking no request at all (`list`, `listBackups`) send `{}`.
		 *
		 * @param method - Remote method name.
		 * @param args - complete wire arguments, already wrapper-shaped.
		 * @returns the method's value.
		 */
		async function callHost(method, args) {
			const rpcId = globalThis.crypto?.randomUUID?.() ?? String(Date.now()) + String(Math.random());
			const endpoint = `archivedSessions/${method}`;
			const response = await fetch(`/api/${endpoint}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					type: 'client-request',
					rpcId,
					method: endpoint,
					payload: { args: args ?? {} }
				})
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const envelope = await response.json();
			const result = envelope?.result;
			if (result?.ok === true) return result.value;
			const message = result?.error?.message ?? 'unknown failure';
			const error = new Error(message);
			error.code = result?.error?.code;
			throw error;
		}
		//#endregion

		//#region formatting helpers
		/**
		 * Join class names, dropping the falsy ones.
		 *
		 * A local helper rather than a `clsx` import: the browser module loader
		 * only serves modules the boot graph lists, and this plugin declares no
		 * `dsh.client.external` dependency on one.
		 *
		 * @param parts - class names or falsy values.
		 * @returns the joined class attribute.
		 */
		function clsx(...parts) {
			return parts.filter(Boolean).join(' ');
		}

		/** Render a byte count through the shared formatter. */
		function sizeText(bytes) {
			if (typeof bytes !== 'number' || bytes <= 0) return '—';
			return primitives.fileSizeText(bytes);
		}

		/** Render an epoch-millisecond stamp as a local date-time string. */
		function dateText(at, locale) {
			if (typeof at !== 'number' || at <= 0) return '—';
			const tag = typeof locale === 'string' && locale.startsWith('zh') ? 'zh-CN' : locale || undefined;
			try {
				return new Date(at).toLocaleString(tag, {
					year: 'numeric',
					month: '2-digit',
					day: '2-digit',
					hour: '2-digit',
					minute: '2-digit'
				});
			} catch {
				return new Date(at).toLocaleString();
			}
		}

		/**
		 * The Workspace label for one row.
		 *
		 * The Host sends `workspaceTitle`, the registered display name — the same
		 * label the sidebar shows. It falls back to the last path segment of
		 * `cwd` so a row still reads sensibly against a Host that predates the
		 * field, rather than claiming the Session belongs to no Workspace.
		 *
		 * @param row - the listing row.
		 * @returns the label, or undefined when nothing identifies a Workspace.
		 */
		function workspaceLabel(row) {
			if (typeof row.workspaceTitle === 'string' && row.workspaceTitle !== '') return row.workspaceTitle;
			if (typeof row.cwd !== 'string' || row.cwd === '') return undefined;
			const parts = row.cwd.split(/[/\\]/).filter(Boolean);
			return parts.length === 0 ? row.cwd : parts[parts.length - 1];
		}
		//#endregion

		//#region styles
		const CSS_TAG = 'dsh-plugin-archived-sessions/settings.module.css';
		const css = {
			section: 'dsas_section',
			head: 'dsas_head',
			heading: 'dsas_heading',
			intro: 'dsas_intro',
			toolbar: 'dsas_toolbar',
			count: 'dsas_count',
			table: 'dsas_table',
			row: 'dsas_row',
			headerRow: 'dsas_headerRow',
			cell: 'dsas_cell',
			titleCell: 'dsas_titleCell',
			titleText: 'dsas_titleText',
			tagRow: 'dsas_tagRow',
			workspace: 'dsas_workspace',
			muted: 'dsas_muted',
			numeric: 'dsas_numeric',
			actions: 'dsas_actions',
			empty: 'dsas_empty',
			error: 'dsas_error',
			status: 'dsas_status',
			subHead: 'dsas_subHead',
			subHeading: 'dsas_subHeading',
			backupRow: 'dsas_backupRow',
			backupName: 'dsas_backupName',
			iconButton: 'dsas_iconButton',
			danger: 'dsas_danger',
			refreshButton: 'dsas_refreshButton',
			notice: 'dsas_notice',
			noticeError: 'dsas_noticeError',
		};

		const cssText = `
.dsas_section{max-width:720px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:20px}
.dsas_head{display:flex;flex-direction:column;gap:10px}
.dsas_heading{margin:0;font-size:18px;font-weight:600;line-height:26px}
.dsas_intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dsas_toolbar{display:flex;align-items:center;gap:8px}
/* The shipped compact Button is 12px; this page's body copy is 13px, so the
   toolbar control is sized down but keeps the page's type scale. */
.dsas_refreshButton{height:28px;padding:0 10px;font-size:13px;line-height:20px}
.dsas_count{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;font-variant-numeric:tabular-nums}
.dsas_status{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dsas_error{display:flex;align-items:center;gap:10px;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}
.dsas_error button{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;padding:4px 10px}
.dsas_empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;margin:0;padding:8px 0}
.dsas_table{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
/* Four evenly-weighted columns: title, workspace, created, size, then actions. */
.dsas_row{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr) minmax(0,1.1fr) 72px 64px;align-items:center;gap:16px;border-bottom:.5px solid var(--dsw-alias-border-l2);padding:12px 0}
.dsas_row:last-child{border-bottom:0}
.dsas_headerRow{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;border-bottom:.5px solid var(--dsw-alias-border-l3);padding-bottom:8px}
.dsas_cell{min-width:0;font-size:13px;line-height:20px}
.dsas_titleCell{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsas_titleText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsas_tagRow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsas_workspace{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsas_muted{color:var(--dsw-alias-label-tertiary)}
.dsas_numeric{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsas_actions{display:flex;align-items:center;gap:4px;justify-content:flex-end}
.dsas_iconButton{border-radius:var(--dsw-radius-sm);width:24px;height:24px;color:var(--dsw-alias-label-caption);cursor:pointer;background:0 0;border:0;display:inline-flex;align-items:center;justify-content:center;padding:0}
.dsas_iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsas_iconButton:disabled{opacity:.5;cursor:default}
.dsas_danger{color:var(--dsw-alias-state-error-primary)}
.dsas_danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary)}
.dsas_subHead{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.dsas_subHeading{margin:0;font-size:14px;font-weight:600;line-height:22px}
.dsas_backupRow{display:flex;align-items:center;gap:12px;border-bottom:.5px solid var(--dsw-alias-border-l2);padding:8px 0}
.dsas_backupRow:last-child{border-bottom:0}
.dsas_backupName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsas_notice{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dsas_noticeError{margin:0;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}
`;

		/** Inject the page stylesheet once per document. */
		function ensureStyles() {
			if (typeof document === 'undefined') return;
			if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']') !== null) return;
			const tag = document.createElement('style');
			tag.setAttribute('data-plugin-css', CSS_TAG);
			tag.textContent = cssText;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region deletion preferences
		const DELETE_PREFERENCES_KEY = 'dsh.archivedSessions.deletePreferences.v1';

		function deletionPreferences() {
			try {
				const value = JSON.parse(globalThis.localStorage.getItem(DELETE_PREFERENCES_KEY));
				// Older preferences also stored keepBackup; it no longer affects deletion.
				if (value?.skipConfirmation === true) return { skipConfirmation: true };
			} catch {
				/* Unavailable or malformed storage keeps the confirmation enabled. */
			}
			return { skipConfirmation: false };
		}

		function rememberDeletionPreference() {
			try {
				globalThis.localStorage.setItem(DELETE_PREFERENCES_KEY, JSON.stringify({ skipConfirmation: true }));
			} catch {
				/* A failed preference write never prevents the confirmed deletion. */
			}
		}
		//#endregion

		//#region page
		/**
		 * The archived-session management page.
		 *
		 * @param props - slot props: the owner's `close`, the page's injected
		 *   face (`useArchived`, actions, and the shared locale lookup).
		 * @returns the rendered section.
		 */
		function ArchivedSessionsSection({ close, useArchived, actions, t, locale }) {
			ensureStyles();
			const state = useArchived((snapshot) => snapshot);
			const [confirming, setConfirming] = react.useState(null);
			const [acknowledged, setAcknowledged] = react.useState(false);
			const [notice, setNotice] = react.useState(null);

			react.useEffect(() => {
				actions.refresh();
			}, []);

			const rows = state.rows ?? [];
			const busy = state.busy ?? null;

			const askDelete = (row) => {
				if (busy !== null) return;
				// Read on each click so another window's saved preference also applies.
				const preference = deletionPreferences();
				if (preference.skipConfirmation) {
					void deleteRow(row);
					return;
				}
				setAcknowledged(false);
				setConfirming(row);
			};

			const doDelete = async () => {
				const row = confirming;
				if (row === null || !acknowledged || busy !== null) return;
				// Cancel or close never saves the checkbox: the choice is committed
				// only when the user presses the enabled confirmation button.
				rememberDeletionPreference();
				setConfirming(null);
				await deleteRow(row);
			};

			const deleteRow = async (row) => {
				const outcome = await actions.remove(row.sessionId, false);
				if (outcome?.ok === true) {
					const label = row.title ?? t('untitled');
					setNotice({ tone: 'ok', text: t('deleted', { title: label }) });
				} else if (outcome !== undefined) {
					setNotice({ tone: 'error', text: t('actionFailed', { message: outcome.message ?? '' }) });
				}
			};

			const restore = async (row) => {
				const outcome = await actions.restore(row.sessionId);
				if (outcome?.ok === true) setNotice({ tone: 'ok', text: t('restored', { title: row.title ?? t('untitled') }) });
				else if (outcome !== undefined) setNotice({ tone: 'error', text: t('actionFailed', { message: outcome.message ?? '' }) });
			};

			const pruneAll = async () => {
				const outcome = await actions.pruneAll();
				if (outcome?.ok === true) setNotice({ tone: 'ok', text: t('pruned', { count: String(outcome.removed ?? 0) }) });
				else if (outcome !== undefined) setNotice({ tone: 'error', text: t('actionFailed', { message: outcome.message ?? '' }) });
			};

			const body = state.error !== null && rows.length === 0
				? jsxs('div', {
					className: css.error,
					children: [
						jsx(primitives.IconWarningOutlineRegular, { size: 16 }),
						jsx('span', { children: t('failed', { message: state.error }) }),
						jsx('button', { type: 'button', onClick: () => actions.refresh(), children: t('retry') })
					]
				})
				: rows.length === 0
					? jsx('p', { className: css.empty, children: state.loading ? t('loading') : t('empty') })
					: jsxs('ul', {
						className: css.table,
						children: [
							jsxs('li', {
								className: `${css.row} ${css.headerRow}`,
								children: [
									jsx('span', { className: css.cell, children: t('columnTitle') }),
									jsx('span', { className: css.cell, children: t('columnWorkspace') }),
									jsx('span', { className: css.cell, children: t('columnCreated') }),
									jsx('span', { className: css.cell, children: t('columnSize') }),
									jsx('span', { className: css.cell, children: t('columnActions') })
								]
							}),
							...rows.map((row) => jsxs('li', {
								className: css.row,
								children: [
									jsxs('div', {
										className: `${css.cell} ${css.titleCell}`,
										children: [
											// The Session's own title is the row identity; a
											// Session with no title row yet still lists.
											jsx('span', {
												className: clsx(css.titleText, row.title === undefined && css.muted),
												title: row.title ?? undefined,
												children: row.title ?? t('untitled')
											}),
											jsxs('span', {
												className: css.tagRow,
												children: [
													// A tombstoned row is one this plugin already deleted; it can
													// still be re-archived in-process through the registry's stale
													// header cache, so it is labelled distinctly from a Session
													// whose log merely vanished.
													row.deleted === true ? jsx(primitives.Tag, { children: t('alreadyDeleted') }) : null,
													row.deleted !== true && row.present === false ? jsx(primitives.Tag, { children: t('missing') }) : null,
													row.origin === 'subagent' ? jsx(primitives.Tag, { children: t('subagent') }) : null,
													row.hasBackup ? jsx(primitives.Tag, { children: t('backups') }) : null
												]
											})
										]
									}),
									// Workspace NAME, not the directory: that is the label the
									// sidebar shows for the same conversation.
									jsx('span', {
										className: clsx(css.cell, css.workspace, workspaceLabel(row) === undefined && css.muted),
										title: row.workspaceTitle ?? row.cwd ?? undefined,
										children: workspaceLabel(row) ?? t('noWorkspace')
									}),
									jsx('span', { className: clsx(css.cell, css.numeric), children: dateText(row.createdAt, locale) }),
									jsx('span', { className: clsx(css.cell, css.numeric), children: sizeText(row.sizeBytes) }),
									jsxs('span', {
										className: css.actions,
										children: [
											jsx(primitives.Tooltip, {
												label: t('restore'),
												children: jsx('button', {
													type: 'button',
													className: css.iconButton,
													disabled: busy !== null,
													'aria-label': t('restore'),
													onClick: () => restore(row),
													children: jsx(primitives.IconUnarchiveOutlineRegular, { size: 15 })
												})
											}),
											jsx(primitives.Tooltip, {
												label: t('delete'),
												children: jsx('button', {
													type: 'button',
													className: clsx(css.iconButton, css.danger),
													disabled: busy !== null,
													'aria-label': t('delete'),
													onClick: () => askDelete(row),
													children: jsx(primitives.IconTrashOutlineRegular, { size: 15 })
												})
											})
										]
									})
								]
							}, row.sessionId))
						]
					});

			const backups = state.backups ?? [];

			return jsxs('section', {
				className: css.section,
				children: [
					jsxs('div', {
						className: css.head,
						children: [
							jsx('h2', { className: css.heading, children: t('title') }),
							jsx('p', { className: css.intro, children: t('intro') })
						]
					}),
					jsxs('div', {
						className: css.toolbar,
						children: [
							jsx(primitives.Button, {
								variant: 'outline',
								size: 'sm',
								className: css.refreshButton,
								disabled: state.loading,
								onClick: () => actions.refresh(),
								children: t('refresh')
							}),
							jsx('span', { className: css.count, children: t('count', { count: String(rows.length) }) }),
							state.loading ? jsx('span', { className: css.status, children: t('loading') }) : null
						]
					}),
					notice !== null ? jsx('p', {
						className: notice.tone === 'error' ? css.noticeError : css.notice,
						children: notice.text
					}) : null,
					body,
					backups.length > 0 ? jsxs('div', {
						children: [
							jsxs('div', {
								className: css.subHead,
								children: [
									jsx('h3', { className: css.subHeading, children: t('backups') }),
									jsx('span', { className: css.count, children: String(backups.length) }),
									jsx('span', { style: { marginLeft: 'auto' } }),
									jsx(primitives.Button, {
										variant: 'outline',
										size: 'sm',
										onClick: () => pruneAll(),
										children: t('pruneAll')
									})
								]
							}),
							jsx('p', { className: css.intro, children: t('backupPath', { path: state.backupRoot ?? '' }) }),
							jsx('p', { className: css.intro, children: t('backupsIntro') }),
							jsxs('ul', {
								className: css.table,
								children: backups.map((entry) => jsxs('li', {
									className: css.backupRow,
									children: [
										jsx('span', { className: css.backupName, children: entry.name }),
										jsx('span', { className: css.cell, children: sizeText(entry.bytes) }),
										jsx('button', {
											type: 'button',
											className: css.iconButton,
											'aria-label': t('pruneOne'),
											style: { color: 'var(--dsw-alias-state-error-primary)' },
											onClick: () => actions.pruneOne(entry.name),
											children: jsx(primitives.IconTrashOutlineRegular, { size: 16 })
										})
									]
								}, entry.name))
							})
						]
					}) : null,
					jsx(primitives.RiskConfirmation, {
						open: confirming !== null,
						title: t('confirmTitle'),
						description: t('confirmBody', { title: confirming?.title ?? t('untitled') }),
						acknowledgeLabel: t('confirmAcknowledge'),
						cancelLabel: t('confirmCancel'),
						confirmLabel: t('confirmDelete'),
						closeLabel: t('close'),
						acknowledged,
						onAcknowledgedChange: setAcknowledged,
						onCancel: () => setConfirming(null),
						onConfirm: () => {
							void doDelete();
						}
					})
				]
			});
		}
		//#endregion

		//#region controller
		/**
		 * Observable page state plus the actions the section binds. Kept outside
		 * React so a refresh survives re-renders and concurrent calls coalesce.
		 *
		 * @param ctx - the browser plugin context.
		 * @param t - locale lookup for this plugin's namespace.
		 * @returns the page's injected face.
		 */
		function createController(ctx, t) {
			function deletionError(error) {
				const key = {
					'archived-sessions/session-live': 'residentUntracked',
					'archived-sessions/release-failed': 'releaseFailed',
					'archived-sessions/delete-in-progress': 'deleteInProgress',
					'archived-sessions/persistence-unavailable': 'persistenceUnavailable'
				}[error?.code];
				return key === undefined ? String(error?.message ?? error) : t(key);
			}
			const store = createSnapshotStore({
				rows: [],
				backups: [],
				backupRoot: null,
				loading: true,
				busy: null,
				error: null
			});

			let inflight = null;

			/** Read the archive set through this plugin's Host namespace. */
			async function refresh() {
				if (inflight !== null) return inflight;
				store.update((draft) => {
					draft.loading = true;
					draft.error = null;
				});
				inflight = (async () => {
					try {
						const value = await callHost('list', {});
						store.update((draft) => {
							draft.rows = value?.rows ?? [];
							draft.backupRoot = value?.backupRoot ?? null;
							draft.error = null;
						});
						const backupsValue = await callHost('listBackups', {});
						store.update((draft) => {
							draft.backups = backupsValue ?? [];
						});
					} catch (error) {
						store.update((draft) => {
							draft.error = String(error?.message ?? error);
						});
					} finally {
						store.update((draft) => {
							draft.loading = false;
						});
						inflight = null;
					}
				})();
				return inflight;
			}

			/**
			 * Delete one archived Session. Returns a plain outcome so the caller
			 * renders a notice without catching.
			 *
			 * @param sessionId - the Session to delete.
			 * @returns `{ ok }` or `{ ok: false, message }`.
			 */
			async function remove(sessionId) {
				store.update((draft) => {
					draft.busy = sessionId;
				});
				try {
					const value = await callHost('delete', { request: { sessionId, keepBackup: false } });
					await refresh();
					return { ok: true, backupPath: value?.backupPath ?? undefined, bytes: value?.bytes ?? 0 };
				} catch (error) {
					const message = deletionError(error);
					store.update((draft) => {
						draft.error = message;
					});
					return { ok: false, message };
				} finally {
					store.update((draft) => {
						draft.busy = null;
					});
				}
			}

			/**
			 * Restore one archived Session to the grouping surfaces.
			 *
			 * @param sessionId - the Session to restore.
			 * @returns `{ ok }` or `{ ok: false, message }`.
			 */
			async function restore(sessionId) {
				store.update((draft) => {
					draft.busy = sessionId;
				});
				try {
					await callHost('unarchive', { request: { sessionId } });
					await refresh();
					return { ok: true };
				} catch (error) {
					return { ok: false, message: String(error?.message ?? error) };
				} finally {
					store.update((draft) => {
						draft.busy = null;
					});
				}
			}

			/** Remove every quarantined backup. */
			async function pruneAll() {
				try {
					const value = await callHost('pruneBackups', {});
					await refresh();
					return { ok: true, removed: value?.removed ?? 0 };
				} catch (error) {
					return { ok: false, message: String(error?.message ?? error) };
				}
			}

			/** Remove one quarantined backup by name. */
			async function pruneOne(name) {
				try {
					await callHost('pruneBackups', { request: { name } });
					await refresh();
					return { ok: true };
				} catch (error) {
					return { ok: false, message: String(error?.message ?? error) };
				}
			}

			return {
				useArchived: (selector) => useStoreSelector(store, selector),
				actions: { refresh, remove, restore, pruneAll, pruneOne }
			};
		}

		/**
		 * Subscribe one component to a snapshot store without pulling in an
		 * external state library. Uses `useSyncExternalStore` with the store's
		 * own snapshot identity, which is stable between updates.
		 *
		 * @param store - a `createSnapshotStore` result.
		 * @param selector - maps the snapshot to the subscribed value.
		 * @returns the selected value, re-rendering on change.
		 */
		function useStoreSelector(store, selector) {
			const lastRef = react.useRef({ snapshot: undefined, selected: undefined });
			const getSnapshot = react.useCallback(() => {
				const snapshot = store.getSnapshot();
				if (lastRef.current.snapshot !== snapshot) {
					lastRef.current = { snapshot, selected: selector(snapshot) };
				}
				return lastRef.current.selected;
			}, [store, selector]);
			return react.useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
		}
		//#endregion

		/** Required client services. */
		const inject = ['slots', 'locale'];

		/**
		 * The active locale id, used only to pick a date formatting convention.
		 *
		 * @param ctx - the browser plugin context.
		 * @returns the active locale id, or undefined when unreadable.
		 */
		function activeLocale(ctx) {
			try {
				return ctx.locale.getSnapshot()?.active ?? undefined;
			} catch {
				return undefined;
			}
		}

		/**
		 * Mount the archived-session settings section.
		 *
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'archived-sessions: dictionaries');
			const controller = createController(ctx, t);
			const face = () => ({
				useArchived: controller.useArchived,
				actions: controller.actions,
				t,
				locale: activeLocale(ctx)
			});
			ctx.slots.inject('settings.section', () => ctx.slots.register({
				name: 'settings.section',
				id: 'archived-sessions',
				order: 32,
				label: () => t('nav'),
				locale: NS,
				inject: face
			}, ArchivedSessionsSection));
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
