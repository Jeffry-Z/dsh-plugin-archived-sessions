/**
 * dsh-plugin-archived-sessions — Host half.
 *
 * DSH 0.2.0-rc.2 ships archive/unarchive for Sessions but no way to inspect the
 * archive set as a management surface and no way to delete a Session at all.
 * This plugin adds exactly that, without touching the shipped packages:
 *
 *  - `archivedSessions/list`   — the archive set joined with each Session's
 *    header, title, size and on-disk artifact path.
 *  - `archivedSessions/delete` — permanent removal: safely releases the
 *    Session, removes its artifact directory and drops the id from the archive
 *    set. Explicit backup requests remain supported for older Remote callers.
 *  - `archivedSessions/unarchive` — restore one archived Session.
 *  - `archivedSessions/listBackups` / `archivedSessions/pruneBackups` — manage
 *    the quarantine directory.
 *
 * EXPOSURE. The methods ride the Typert Gateway's **SRC** path: a service that
 * publishes a `typertRemote` binding and carries Remote method markers is
 * callable with no generated schema package. Both pieces come from
 * `./protocol.js`, which reimplements the ~60 lines of
 * `@deepseek-ai/dsh-typert-protocol` this plugin needs. That indirection is
 * required, not stylistic: a profile-installed plugin resolves its imports from
 * its own directory, which is outside the DSH installation, so a bare
 * `@deepseek-ai/...` specifier cannot resolve — and a failed import leaves the
 * Cordis entry silently `inactive`. See `./protocol.js` for the full reasoning.
 *
 * @module dsh-plugin-archived-sessions
 */

import { createRemoteServiceBase, markRemote, RemoteError } from './protocol.js';
import { SessionLifecycle } from './lifecycle.js';
import { mkdir, rename, rm, cp, readdir, readFile, writeFile, stat as fsStat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

/** Cordis plugin name. */
export const name = 'archived-sessions';

/**
 * Services this plugin needs. `workspaceRegistry` owns the archive set;
 * `sessionQuery` enumerates live + persisted Sessions; `sessionPersistence`
 * gives per-Session headers, sizes and artifact locations.
 *
 * Declaring them here makes Cordis build a fiber whose context resolves them,
 * so the service constructor can read `this.ctx.workspaceRegistry` and friends.
 * Without the declaration Cordis throws
 * `cannot get property "…" without inject` on first access.
 *
 * `sessionProjectionCache` is deliberately absent: it is read only for the
 * zero-I/O title listing hint through `ctx.get`, so a deployment without it
 * still lists archived Sessions by id, path and size.
 */
export const inject = ['workspaceRegistry', 'sessionQuery', 'sessionPersistence', 'agents'];

/**
 * Mount the archived-Session service.
 *
 * The service is constructed here, in the plugin's own fiber, because that is
 * the only context in which the declared `inject` services are visible: Cordis
 * binds injected services per fiber, and a service built against the root
 * context could not resolve them.
 *
 * @param ctx - the plugin's Cordis context, carrying the injected services.
 */
export function apply(ctx) {
	// One instance per fiber; Cordis unregisters the service when the fiber
	// unwinds because registration goes through the fiber-owned `ctx.provide`.
	new ArchivedSessionsService(ctx);
}

/** Service base publishing the SRC binding the Gateway reads. */
const RemoteServiceBase = createRemoteServiceBase();

const BACKUP_DIR_NAME = 'archived-session-deletions';
/** Tombstone ledger directory, inside the quarantine root. */
const TOMBSTONE_DIR_NAME = '.tombstones';

/** Session ids this build may address. */
function asSessionId(value) {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new RemoteError('gateway/bad-request', 'sessionId must be a non-empty string', {});
	}
	return value.trim();
}

/**
 * Refuse ids that are not archived. Deletion is deliberately scoped to the
 * archive set so the operation can never be pointed at a live conversation by
 * a mistaken caller.
 *
 * @param ctx - Host context.
 * @param sessionId - candidate Session id.
 */
function assertArchived(ctx, sessionId) {
	if (!ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)) {
		throw new RemoteError('archived-sessions/not-archived', `session "${sessionId}" is not archived; refusing to delete an unarchived conversation`, { sessionId });
	}
}

/** Deep-clone one header into a plain JSON projection. */
function headerView(header) {
	return {
		id: header.id,
		createdAt: header.createdAt,
		...(header.cwd === undefined ? {} : { cwd: header.cwd }),
		...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
		...(header.origin === undefined ? {} : { origin: header.origin })
	};
}

/**
 * The Session's title, read from the projection cache without touching the log.
 *
 * `cachedSnapshot` is the listing face: it matches the record bound to the
 * header's current lifecycle and views any projection key straight from the
 * stored rows. `cachedPredecessorTitle` is tried second because it only serves
 * a title from a record whose format version is *older* than the header's —
 * useful for a pre-migration checkpoint, but empty for a current Session.
 *
 * Both are best-effort: a Session with no cache record (never checkpointed, or
 * checkpointed elsewhere) still lists, just without a title.
 *
 * @param ctx - Host context.
 * @param header - the Session's header, used as the identity witness.
 * @returns the title, or undefined when the cache has no usable row.
 */
function cachedTitleOf(ctx, header) {
	const cache = (() => {
		try {
			return ctx.get('sessionProjectionCache');
		} catch {
			return undefined;
		}
	})();
	if (cache === undefined) return undefined;
	try {
		const current = cache.cachedSnapshot?.(header, ['title']);
		const title = current?.values?.title;
		if (typeof title === 'string' && title !== '') return title;
	} catch {
		/* fall through to the predecessor hint */
	}
	try {
		const predecessor = cache.cachedPredecessorTitle?.(header);
		const title = predecessor?.values?.title;
		if (typeof title === 'string' && title !== '') return title;
	} catch {
		/* no title available */
	}
	return undefined;
}

/**
 * Look up a live (attached) Session without requiring the `sessions` service.
 *
 * Read through `ctx.get` rather than adding `sessions` to `inject`: the service
 * is only consulted to detect an attached Agent, which is a best-effort safety
 * check, not a hard dependency. Reading it as an injected service would make
 * this plugin fail to mount on a deployment that omits it.
 *
 * @param ctx - Host context.
 * @param sessionId - Session id to look up.
 * @returns the live Session, or undefined when it is not attached.
 */
function liveSession(ctx, sessionId) {
	try {
		return ctx.get('sessions')?.get?.(sessionId);
	} catch {
		return undefined;
	}
}

/**
 * Reproduce the JSONL backend's `encodeSegment`, used for the Session directory
 * name. Kept in sync with the backend by the byte-identical algorithm; a
 * mismatch would only ever matter for a Session whose id contains characters
 * outside `[A-Za-z0-9._-]`.
 *
 * @param raw - the raw path segment.
 * @returns one filesystem-safe segment.
 */
function encodeSegment(raw) {
	if (raw === '.') return '~002E';
	if (raw === '..') return '~002E~002E';
	let out = '';
	for (let i = 0; i < raw.length; i += 1) {
		const code = raw.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
		else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
	}
	return out;
}

/**
 * Invert {@link encodeSegment} for a tombstone file name.
 *
 * Used only to recover an id from a ledger file whose JSON body is unreadable,
 * so a damaged tombstone still withholds its id rather than being ignored.
 *
 * @param raw - one encoded path segment.
 * @returns the decoded segment.
 * @throws when the segment carries a malformed escape.
 */
function decodeSegment(raw) {
	if (raw === '~002E') return '.';
	if (raw === '~002E~002E') return '..';
	let out = '';
	for (let i = 0; i < raw.length; i += 1) {
		const ch = raw[i];
		if (ch !== '~') {
			out += ch;
			continue;
		}
		const hex = raw.slice(i + 1, i + 5);
		if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw new Error(`malformed escape at ${i}`);
		out += String.fromCharCode(Number.parseInt(hex, 16));
		i += 4;
	}
	return out;
}

/**
 * Reproduce the JSONL backend's `projectKey`, used for the per-project
 * directory name. Separators collapse to a single `-`, and the whole key is
 * wrapped in `--` and truncated to the filesystem component limit.
 *
 * @param cwd - the Session's project directory.
 * @returns one filesystem-safe project directory name.
 */
function projectKey(cwd) {
	if (cwd.length === 0) throw new Error('cannot encode an empty project path');
	let readable = '';
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i += 1) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === '/' || ch === '\\' || ch === ':') {
			if (!separatorRun) readable += '-';
			separatorRun = true;
		} else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/**
 * Resolve the artifact directory for one Session. Prefers the persistence
 * backend's own `locate()` so the path always matches what the backend writes,
 * and falls back to the documented layout
 * (`<root>/<projectKey(cwd)>/<encoded id>/`) for a backend without `locate`.
 *
 * The whole session directory is returned, not one generation file: historical
 * `session.v0..vN` artifacts can coexist, and deleting the directory is the
 * only way to remove every generation.
 *
 * @param ctx - Host context.
 * @param header - Session header supplying `id` and `cwd`.
 * @returns absolute artifact directory, or undefined when it cannot be known.
 */
function artifactDirOf(ctx, header) {
	const persistence = ctx.sessionPersistence;
	const located = typeof persistence?.locate === 'function' ? persistence.locate(header) : undefined;
	if (located?.path !== undefined) return dirname(located.path);
	if (header.cwd === undefined) return undefined;
	if (typeof persistence?.root !== 'string' || persistence.root === '') return undefined;
	try {
		return join(persistence.root, projectKey(header.cwd), encodeSegment(header.id));
	} catch {
		return undefined;
	}
}

/** Quarantine root: `~/.dsh/archived-session-deletions` (or the persistence root's sibling). */
function backupRoot(ctx) {
	const root = ctx.sessionPersistence?.root;
	if (typeof root === 'string' && root !== '') return join(dirname(root), BACKUP_DIR_NAME);
	return join(homedir(), '.dsh', BACKUP_DIR_NAME);
}

/**
 * Tombstone ledger root: `~/.dsh/archived-session-deletions/.tombstones`.
 *
 * WHY A TOMBSTONE IS NEEDED. `WorkspaceRegistry.sessionKnown()` answers `true`
 * for any id still present in its in-process `headers` map, and that map is
 * ADDITIVE-ONLY: `indexHeaders` never prunes (`dsh-workspace/lib/index.js:869-871`)
 * and `replaceHeaderIndex` — the one method that clears (`:863-868`) — is not
 * part of the published registry contract. So after a deletion the id can still
 * satisfy `archiveSession` for the rest of the process, producing an archived id
 * with no Session behind it. Verified live: a deleted id re-archived with
 * `ok: true` and listed as `present: false`.
 *
 * The plugin cannot clear that cache, so it records what it deleted instead.
 * `list` and lifecycle tracking treat a tombstoned id as gone regardless of
 * what the registry still believes, which is what keeps a phantom row from
 * appearing in this plugin's own surfaces.
 *
 * The ledger lives inside the deletion-data root and backup pruning preserves
 * it. Writing is best-effort: a failure to record a tombstone
 * never fails an otherwise-successful deletion.
 *
 * @param ctx - Host context.
 * @returns the tombstone directory path.
 */
function tombstoneRoot(ctx) {
	return join(backupRoot(ctx), TOMBSTONE_DIR_NAME);
}

/**
 * Whether one path component is safe to use as a tombstone file name.
 *
 * A Session id is data from a log header; it is hex-encoded into the file name
 * (see {@link tombstonePath}) so it can never traverse out of the ledger.
 *
 * @param sessionId - candidate Session id.
 * @returns true when the id is a non-empty string.
 */
function isAddressableSessionId(sessionId) {
	return typeof sessionId === 'string' && sessionId.trim() !== '';
}

/**
 * One tombstone file for a Session id.
 *
 * The id is percent-encoded rather than used verbatim: ids are opaque strings
 * and may contain `/` or `..`, which must not become path structure.
 *
 * @param ctx - Host context.
 * @param sessionId - the deleted Session id.
 * @returns absolute tombstone file path.
 */
function tombstonePath(ctx, sessionId) {
	return join(tombstoneRoot(ctx), `${encodeSegment(sessionId)}.json`);
}

/**
 * Whether a path lies inside the session persistence root.
 *
 * A hard safety rail: this plugin only ever removes Session artifact
 * directories, and the Session header's `cwd` is data from a log file. Checking
 * containment means a corrupt or hostile header can never redirect the deletion
 * at an unrelated directory.
 *
 * @param ctx - Host context.
 * @param path - absolute candidate path.
 * @returns true when the path is the root itself or a descendant of it.
 */
function isInsidePersistenceRoot(ctx, path) {
	const root = ctx.sessionPersistence?.root;
	if (typeof root !== 'string' || root === '') return true; // unknown root: nothing to compare against
	const normalizedRoot = resolve(root);
	const normalizedPath = resolve(path);
	return normalizedPath === normalizedRoot || normalizedPath.startsWith(normalizedRoot + '/');
}

/**
 * One filesystem-safe backup folder name for a Session plus a collision-proof
 * stamp.
 *
 * The stamp is an ISO timestamp with a random suffix. Timestamp alone is not
 * enough: `delete` quarantines a directory by `rename`, which fails with ENOTEMPTY
 * if the destination exists, so two operations naming the same Session within the
 * same millisecond — a retry after a partial failure, or an operator deleting id
 * A while A's earlier quarantine is being re-created — must not share a name.
 *
 * @param sessionId - the Session being quarantined.
 * @returns one directory name, unique per call.
 */
function backupName(sessionId) {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const nonce = Math.random().toString(36).slice(2, 8);
	return `${sessionId}.${stamp}.${nonce}`;
}

/**
 * Recover the Session id from a quarantine directory name.
 *
 * A name is `<sessionId>.<iso stamp>.<nonce>`; the id itself is opaque and may
 * contain dots, so the two generated suffixes are stripped from the END. A name
 * that does not carry both suffixes (an older build's `<id>.<stamp>`, or a
 * directory a user created) still yields a usable id rather than a wrong one.
 *
 * @param name - one quarantine directory name.
 * @returns the Session id it was built from.
 */
function sessionIdOfBackupName(name) {
	// `<nonce>` is 6 lowercase base-36 chars; `<stamp>` is an ISO timestamp with
	// `:` and `.` replaced by `-`.
	const suffixed = name.match(/^(.*)\.(\d{4}-\d{2}-\d{2}T[0-9-]+Z)\.([a-z0-9]{6})$/);
	if (suffixed !== null) return suffixed[1];
	// Older layout: `<id>.<stamp>`.
	const legacy = name.match(/^(.*)\.(\d{4}-\d{2}-\d{2}T[0-9-]+Z)$/);
	if (legacy !== null) return legacy[1];
	return name;
}

/** Best-effort directory size, used only for reporting. */
async function directorySize(dir) {
	let total = 0;
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const child = join(dir, entry.name);
		try {
			if (entry.isDirectory()) total += await directorySize(child);
			else total += (await fsStat(child)).size;
		} catch {
			/* a vanished child contributes nothing */
		}
	}
	return total;
}

/** Whether a path exists and is a directory. */
async function directoryExists(dir) {
	try {
		return (await fsStat(dir)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Host Remote owner for the archived-Session management surface.
 *
 * @typert service archivedSessions
 */
class ArchivedSessionsService extends RemoteServiceBase {
	/**
	 * @param ctx - owning Host context.
	 */
	constructor(ctx) {
		super(ctx, 'archivedSessions');
		this.lifecycle = new SessionLifecycle(ctx, async (id) => (await this.readTombstones()).has(id));
	}

	/**
	 * List every archived Session with the metadata a management surface needs.
	 *
	 * Joins the registry-global archive set with the Session corpus (live and
	 * persisted) so an archived Session that is no longer on disk is still
	 * reported, and attaches the title, artifact size and artifact path.
	 *
	 * @param signal - optional cancellation.
	 * @returns archived Session rows in archive order, plus the quarantine root.
	 */
	async list(signal) {
		signal?.throwIfAborted();
		const archivedIds = [...this.ctx.workspaceRegistry.archivedSessionIds];

		// The corpus listing is the authoritative header source: it merges live
		// Sessions with persisted ones, so an archived Session still on disk is
		// reported even when no Agent is attached.
		const headerById = new Map();
		try {
			const records = await this.ctx.sessionQuery.listSessions(signal);
			for (const record of records) headerById.set(record.header.id, record.header);
		} catch {
			/* the archive set remains authoritative for membership */
		}
		signal?.throwIfAborted();

		// A Session belongs to the Workspace whose path equals its canonical
		// `cwd`; the Workspace's `title` is the display name the sidebar shows,
		// which is what the panel reports instead of the raw directory.
		const workspaceByPath = new Map();
		const workspaceBySession = new Map();
		try {
			for (const workspace of this.ctx.workspaceRegistry.list()) {
				workspaceByPath.set(workspace.path, workspace);
				const entity = this.ctx.workspaceRegistry.get?.(workspace.id);
				const accounted = entity?.record?.sessionIds ?? entity?.sessionIds ?? workspace.sessionIds ?? [];
				for (const sessionId of accounted) workspaceBySession.set(sessionId, workspace);
			}
		} catch {
			/* workspace naming is presentation-only */
		}

		const rows = [];
		// An id this plugin has already deleted is gone, whatever the registry's
		// stale header cache still believes. Tombstoned ids are reported as
		// `present: false, deleted: true` rather than hidden outright, so the row
		// stays visible as "already deleted" instead of looking like a live
		// conversation the operator could act on.
		const tombstones = await this.readTombstones();
		for (const id of archivedIds) {
			signal?.throwIfAborted();
			const tombstoned = tombstones.has(id);
			const header = tombstoned ? undefined : headerById.get(id);
			const persistence = this.ctx.sessionPersistence;
			let stored;
			if (!tombstoned) {
				try {
					stored = await persistence?.stat?.(id, signal === undefined ? undefined : { signal });
				} catch {
					stored = undefined;
				}
			}
			const effectiveHeader = stored?.header ?? header;
			const artifactDir = effectiveHeader === undefined ? undefined : artifactDirOf(this.ctx, effectiveHeader);
			const cwd = effectiveHeader?.cwd;
			const workspace = workspaceBySession.get(id) ?? (cwd === undefined ? undefined : workspaceByPath.get(cwd));
			rows.push({
				sessionId: id,
				present: stored !== undefined || header !== undefined,
				deleted: tombstoned,
				live: tombstoned ? false : liveSession(this.ctx, id) !== undefined,
				title: effectiveHeader === undefined ? undefined : cachedTitleOf(this.ctx, effectiveHeader),
				createdAt: effectiveHeader?.createdAt ?? undefined,
				cwd: cwd ?? undefined,
				workspaceId: workspace?.id,
				workspaceTitle: workspace?.title,
				parentSession: effectiveHeader?.parentSession ?? undefined,
				origin: effectiveHeader?.origin ?? undefined,
				sizeBytes: stored?.sizeBytes ?? undefined,
				artifactDir: artifactDir ?? undefined,
				hasBackup: false
			});
		}

		// Flag rows that already carry a quarantine copy so a retry is visible.
		let backups = [];
		try {
			backups = await this.listBackups(signal);
		} catch {
			backups = [];
		}
		const backedUp = new Set(backups.map((entry) => entry.sessionId));
		for (const row of rows) row.hasBackup = backedUp.has(row.sessionId);

		signal?.throwIfAborted();
		return {
			archivedSessionIds: archivedIds,
			backupRoot: backupRoot(this.ctx),
			rows
		};
	}

	/**
	 * Permanently delete one archived Session.
	 *
	 * Order of operations, chosen so a failure leaves the system consistent:
	 *  1. require archival, fence resumes, validate the path and safely release
	 *     a tracked resident Session through its factory-owned handle;
	 *  2. remove the artifact directory directly (or quarantine it only when an
	 *     existing Remote caller explicitly requests a backup);
	 *  3. detach Workspace accounting, notify clients to remove the summary,
	 *     then remove the id from the registry archive set;
	 *  4. report what happened.
	 *
	 * By default files are removed directly. Explicit `keepBackup: true` remains
	 * available to existing Remote consumers; the settings page never requests it.
	 *
	 * @param request - `{ sessionId, keepBackup? }`.
	 * @param signal - optional cancellation.
	 * @returns the deletion outcome.
	 */
	async delete(request, signal) {
		const sessionId = asSessionId(request?.sessionId);
		assertArchived(this.ctx, sessionId);
		return this.lifecycle.withDeletion(sessionId, () => this.deleteReleased(request, signal), signal);
	}

	/** Internal deletion transaction; the public entry fences same-id resumes. */
	async deleteReleased(request, signal) {
		const sessionId = asSessionId(request?.sessionId);
		const keepBackup = request?.keepBackup === true;
		assertArchived(this.ctx, sessionId);

		// An archived Session can still own a write handle. Only the factory's
		// captured AgentHandle may shut it down; never remove registry entries
		// or close another owner's persistence handle directly.
		this.lifecycle.requireHandle(sessionId);
		signal?.throwIfAborted();

		// Validate the persisted artifact before releasing a live Session.
		let header;
		try {
			header = (await this.ctx.sessionPersistence?.stat?.(sessionId, signal === undefined ? undefined : { signal }))?.header;
		} catch (cause) {
			throw new RemoteError('archived-sessions/persistence-unavailable', 'could not read the conversation log; no files were deleted', { sessionId }, { cause });
		}
		signal?.throwIfAborted();

		// A created-but-never-flushed Session answers `stat` from the backend's
		// in-memory tracker, not from disk (`dsh-session-persistence-jsonl`:
		// `stat` consults `tracker.pendingOf(id)` at :2540-2544; `list` merges the
		// same pending entries at :2592-2595). Treating that as a deletion would
		// report success while nothing was removed, and the Session would come
		// back the moment it was flushed. Detect it and refuse honestly.
		const artifactDir = header === undefined ? undefined : artifactDirOf(this.ctx, header);
		if (artifactDir !== undefined && !isInsidePersistenceRoot(this.ctx, artifactDir)) {
			throw new RemoteError('archived-sessions/unsafe-path', `refusing to delete "${artifactDir}": it is outside the session persistence root`, { sessionId, artifactDir });
		}
		if (header !== undefined && artifactDir !== undefined && !(await directoryExists(artifactDir))) {
			if (await this.sessionIsPendingOnly(sessionId)) {
				throw new RemoteError('archived-sessions/not-materialized', `session "${sessionId}" has no artifact on disk yet (it was created but never flushed); deleting it would remove nothing and it would reappear once written — send it a message or wait for it to flush, then delete it`, { sessionId, artifactDir });
			}
		}

		await this.lifecycle.release(sessionId, signal);
		assertArchived(this.ctx, sessionId);

		let backupPath;
		let removed = false;
		let bytes = 0;

		if (artifactDir !== undefined) {
			bytes = await directorySize(artifactDir);
			signal?.throwIfAborted();
			assertArchived(this.ctx, sessionId);
			if (!keepBackup) {
				removed = await directoryExists(artifactDir);
				await rm(artifactDir, { recursive: true, force: true });
			} else {
				const destinationRoot = backupRoot(this.ctx);
				const destination = join(destinationRoot, backupName(sessionId));
				await mkdir(destinationRoot, { recursive: true });
				signal?.throwIfAborted();
				assertArchived(this.ctx, sessionId);
				try {
					await rename(artifactDir, destination);
					backupPath = destination;
					removed = true;
				} catch (error) {
					// A cross-device move fails with EXDEV; fall back to copy + remove.
					if (error?.code !== 'EXDEV') {
						if (error?.code !== 'ENOENT') throw error;
					} else {
						await cp(artifactDir, destination, { recursive: true });
						backupPath = destination;
						await rm(artifactDir, { recursive: true, force: true });
						removed = true;
					}
				}
			}
			if (removed) this.lifecycle.markDeleted(sessionId);
		}

		// Once the artifact is removed, finish bookkeeping even if the requester
		// disconnects. Record deletion before writes that could fail partway, so
		// a later remount cannot resume the deleted identity.
		const tombstoned = await this.recordTombstone(sessionId);
		this.lifecycle.markDeleted(sessionId);

		// ORDER MATTERS. The Workspace accounting slot must be released BEFORE
		// the id leaves the archive set, so there is no window in which the
		// Session is unarchived (its `agent/pre-step` gate lifted) while still
		// accounted. The reverse order — unarchive first, then detach — lets a
		// resident Session be archived again in between.
		//
		// `detachSession` rewrites the record through the registry's own write
		// path, and membership is read from the UN-FILTERED record: at this
		// point the artifact is already gone, so the entity's filtered getter
		// (`dsh-workspace/lib/index.js:102-104`) can no longer see the id.
		const detached = await this.forgetSessionAccounting(sessionId);

		// Workspace changes update membership, but the client keeps a separate
		// Session-summary list. Without this existing Host event, the old summary
		// survives the detach and appears under Ungrouped when unarchived. The
		// Gateway forwards it to every connected client; the Session manager also
		// replays removals over any list response already in flight.
		this.ctx.emit('api-session/removed', sessionId);
		await this.ctx.workspaceRegistry.unarchiveSession(sessionId);

		// The Session's artifact is gone, so its projection-cache record is now
		// an orphan. Left in place it keeps serving a title/metadata row for an
		// id that no longer exists on disk, which is a second way the sidebar can
		// render a contentless entry. Best-effort: a backend without the cache
		// simply has nothing to purge.
		const cachePurged = await this.purgeProjectionCache(sessionId);

		return {
			sessionId,
			deleted: true,
			artifactRemoved: removed,
			artifactDir: artifactDir ?? undefined,
			backupPath,
			keepBackup,
			bytes,
			detachedWorkspaceIds: detached,
			cachePurged,
			tombstoned,
			archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds]
		};
	}

	/**
	 * Whether a Session is known to persistence ONLY through the backend's
	 * in-memory "created but not yet flushed" tracker.
	 *
	 * The JSONL backend materializes a Session's artifact lazily: `create()`
	 * registers it with an in-process tracker, and `stat`/`list` answer from that
	 * tracker until the first append or flush writes the file
	 * (`dsh-session-persistence-jsonl`: `stat` at :2540-2544, `list` at
	 * :2592-2595, `create`/`registerCreated` at :2431-2445). Such a Session has
	 * `header` metadata but no directory to delete, so treating it as deletable
	 * would report success while removing nothing.
	 *
	 * Best-effort and deliberately narrow: it reports `true` only when `stat`
	 * answers AND the artifact directory is absent from disk. A backend that
	 * does not expose the tracker simply answers `stat` from disk, in which case
	 * the directory exists and this returns `false`.
	 *
	 * @param sessionId - the Session id to test.
	 * @returns true when only the in-memory tracker knows the Session.
	 */
	async sessionIsPendingOnly(sessionId) {
		const persistence = this.ctx.sessionPersistence;
		let header;
		try {
			header = (await persistence?.stat?.(sessionId))?.header;
		} catch {
			return false;
		}
		if (header === undefined) return false;
		const artifactDir = artifactDirOf(this.ctx, header);
		if (artifactDir === undefined) return false;
		// The directory is absent (the caller checked) and `stat` still answers:
		// the record can only be coming from memory.
		return !(await directoryExists(artifactDir));
	}

	/**
	 * Record a durable tombstone for a deleted Session id.
	 *
	 * Best-effort by design: the artifact is already gone and the account already
	 * released when this runs, so a ledger write failure must not turn a
	 * successful deletion into an error. It returns whether the record landed so
	 * the caller can report it.
	 *
	 * @param sessionId - the deleted Session id.
	 * @returns true when the tombstone was written.
	 */
	async recordTombstone(sessionId) {
		if (!isAddressableSessionId(sessionId)) return false;
		try {
			await mkdir(tombstoneRoot(this.ctx), { recursive: true });
			await writeFile(
				tombstonePath(this.ctx, sessionId),
				JSON.stringify({ sessionId, deletedAt: new Date().toISOString() }),
				{ encoding: 'utf8', flag: 'w' }
			);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Every tombstoned Session id.
	 *
	 * A missing ledger is an empty set — the normal state before any deletion.
	 *
	 * @returns the tombstoned ids.
	 */
	async readTombstones() {
		let entries;
		try {
			entries = await readdir(tombstoneRoot(this.ctx));
		} catch {
			return new Set();
		}
		const ids = new Set();
		for (const name of entries) {
			if (!name.endsWith('.json')) continue;
			const stem = name.slice(0, -'.json'.length);
			try {
				const parsed = JSON.parse(await readFile(join(tombstoneRoot(this.ctx), name), 'utf8'));
				if (typeof parsed?.sessionId === 'string' && parsed.sessionId !== '') ids.add(parsed.sessionId);
				else ids.add(decodeSegment(stem));
			} catch {
				// A corrupt or unreadable tombstone still withholds the id: the
				// file name encodes it, so falling back keeps the ledger's promise.
				try {
					ids.add(decodeSegment(stem));
				} catch {
					/* an undecodable name withholds nothing */
				}
			}
		}
		return ids;
	}

	/**
	 * Drop the projection-cache record for a Session whose artifact is gone.
	 * WHY THIS IS WORTH ATTEMPTING. The projection cache is a separate durable
	 * store keyed by Session id (`~/.dsh/storages/session_projcache/sessions/
	 * <id>.json`). Deleting an artifact does not remove it, so it keeps serving a
	 * title and list metadata for an id that no longer exists on disk — observed
	 * directly in this workspace, where four deleted Sessions still had cache
	 * records on disk.
	 *
	 * IT IS NOT THE GHOST'S CAUSE. `cachedSnapshot`/`cachedPredecessorTitle`
	 * both require a Session *header* as the identity witness
	 * (`dsh-session-projection-cache/lib/index.js:193-215`), and this plugin
	 * passes one only for a Session it can still resolve. A cache record alone
	 * therefore cannot create a sidebar row; the row needs a live Session object
	 * or a persisted header. This is cleaned up for hygiene, not as the fix.
	 *
	 * WHY IT USUALLY REPORTS false. The shipped cache exposes only read faces —
	 * `cachedSnapshot`, `cachedPredecessorTitle`, `coldSnapshot`, `recordFor` —
	 * plus a service-private `requireTable()`; there is no public eviction seam
	 * in DSH 0.2.0-rc.2. This probes for one anyway so the plugin starts working
	 * the moment a build provides it, and never claims a purge it did not make.
	 *
	 * @param sessionId - the deleted Session id.
	 * @returns true when a cache record was actually dropped.
	 */
	async purgeProjectionCache(sessionId) {
		const cache = (() => {
			try {
				return this.ctx.get('sessionProjectionCache');
			} catch {
				return undefined;
			}
		})();
		if (cache === undefined) return false;
		// Only an id-addressed, mutating seam counts. A read face such as
		// `recordFor` must never be mistaken for one, so the candidate list holds
		// mutating verbs only.
		for (const method of ['invalidate', 'evict', 'forget', 'dropRecord', 'deleteRecord']) {
			const fn = cache[method];
			if (typeof fn !== 'function') continue;
			try {
				await fn.call(cache, sessionId);
				return true;
			} catch {
				/* try the next seam */
			}
		}
		return false;
	}

	/**
	 * Drop a deleted Session's Workspace accounting slot.
	 *
	 * WHY THIS IS NEEDED. A Session id lives in two durable places: the
	 * registry-global archive set, and each Workspace record's `sessionIds`
	 * (its ownership account and manual display order). Deleting the artifact
	 * removes neither, so a stale id would remain in the Workspace record and
	 * could be archived and deleted again indefinitely.
	 *
	 * Why the stale row is invisible in the sidebar: `WorkspaceEntity.sessionIds`
	 * is a getter that filters the record's ids down to those whose canonical
	 * path still resolves
	 * (`dsh-workspace/lib/index.js:102-104`). A deleted Session therefore drops
	 * out of the *view* while remaining in the *record* — which is exactly the
	 * reported symptom.
	 *
	 * Note the artifact is removed BEFORE this runs, which matters twice: the
	 * entity's filtered `sessionIds` getter can no longer see the id, so
	 * membership must be read from the raw `record`; and the registry's own
	 * re-filter inside `mutate` likewise drops it, so the removal always
	 * persists.
	 *
	 * The registry exposes no "remove a session id" command, but the entity
	 * does: `WorkspaceEntity.detachSession(sessionId)` rewrites the record's
	 * `sessionIds` through the registry's own durability path
	 * (`dsh-workspace/lib/index.js:149-155`). Using it keeps the write
	 * serialized with every other registry mutation instead of editing the
	 * domain state behind the registry's back.
	 *
	 * @param sessionId - the deleted Session id.
	 * @returns the Workspace ids the id was detached from.
	 */
	async forgetSessionAccounting(sessionId) {
		const registry = this.ctx.workspaceRegistry;
		if (typeof registry?.list !== 'function') return [];
		const detached = [];
		for (const listed of registry.list()) {
			// `sessionIds` is filtered by path resolution, and at this point the
			// artifact is already gone, so this getter can no longer see the very
			// id being removed. Read the owning entity instead.
			const entity = typeof registry.get === 'function' ? registry.get(listed.id) : undefined;
			const target = entity ?? listed;
			if (typeof target?.detachSession !== 'function') continue;
			// The un-filtered record is the authority for membership.
			const accounted = target.record?.sessionIds ?? target.sessionIds;
			if (!Array.isArray(accounted) || !accounted.includes(sessionId)) continue;
			await target.detachSession(sessionId);
			detached.push(listed.id);
		}
		return detached;
	}

	/**
	 * List quarantined deletions.
	 *
	 * @param signal - optional cancellation.
	 * @returns one row per quarantined Session artifact.
	 */
	async listBackups(signal) {
		signal?.throwIfAborted();
		const root = backupRoot(this.ctx);
		let entries;
		try {
			entries = await readdir(root, { withFileTypes: true });
		} catch {
			return [];
		}
		const rows = [];
		for (const entry of entries) {
			signal?.throwIfAborted();
			if (!entry.isDirectory()) continue;
			// The tombstone ledger shares the quarantine root; it is bookkeeping,
			// not a recoverable copy, so it is never offered as a backup.
			if (entry.name === TOMBSTONE_DIR_NAME) continue;
			const full = join(root, entry.name);
			// Recover the Session id without splitting on the FIRST dot: ids are
			// opaque and may contain dots themselves, so the suffix this plugin
			// appended (`.<iso stamp>.<nonce>`) is matched from the END.
			rows.push({
				name: entry.name,
				sessionId: sessionIdOfBackupName(entry.name),
				path: full,
				bytes: await directorySize(full)
			});
		}
		return rows;
	}

	/**
	 * Remove quarantined copies. With no `name`, every quarantined copy is
	 * removed; with a `name`, only that one.
	 *
	 * @param request - `{ name? }`.
	 * @param signal - optional cancellation.
	 * @returns how many quarantined copies were removed.
	 */
	async pruneBackups(request, signal) {
		signal?.throwIfAborted();
		const root = backupRoot(this.ctx);
		const name = request?.name;
		if (typeof name === 'string' && name !== '') {
			if (name.includes('/') || name.includes('\\') || name.includes('..')) {
				throw new RemoteError('gateway/bad-request', 'backup name must be a single safe path segment', { name });
			}
			// The tombstone ledger shares the quarantine root and is not a backup:
			// deleting it would let a re-archived phantom reappear.
			if (name === TOMBSTONE_DIR_NAME) {
				throw new RemoteError('gateway/bad-request', `"${TOMBSTONE_DIR_NAME}" is this plugin's deletion ledger, not a quarantine backup`, { name });
			}
			await rm(join(root, name), { recursive: true, force: true });
			return { removed: 1, backupRoot: root };
		}
		const rows = await this.listBackups(signal);
		let removed = 0;
		for (const row of rows) {
			signal?.throwIfAborted();
			await rm(row.path, { recursive: true, force: true });
			removed += 1;
		}
		return { removed, backupRoot: root };
	}

	/**
	 * Restore one archived Session to the grouping surfaces. Thin wrapper over
	 * the registry command so the management panel needs no second namespace.
	 *
	 * @param request - `{ sessionId }`.
	 * @returns the complete resulting archive set.
	 */
	async unarchive(request) {
		const sessionId = asSessionId(request?.sessionId);
		await this.ctx.workspaceRegistry.unarchiveSession(sessionId);
		return { archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds] };
	}
}

/**
 * Declare one prototype method as a Remote method.
 *
 * This file ships as plain JavaScript with no decorator pass, so the marker is
 * written directly. The marker table and its shape are what
 * `@deepseek-ai/dsh-api-gateway` reads on the SRC path, and `./protocol.js`
 * writes them under the same well-known descriptor key.
 *
 * The wire method name is the prototype method name, and the Gateway derives
 * parameter names from the method source — so these methods must stay
 * unminified and keep their parameter identifiers intact.
 *
 * @param serviceClass - the class whose prototype receives the marker.
 * @param method - prototype method name, which is also the wire method name.
 */
function declareRemote(serviceClass, method) {
	if (typeof serviceClass.prototype[method] !== 'function') {
		throw new TypeError(`archived-sessions: cannot mark missing Remote method "${method}"`);
	}
	markRemote(serviceClass.prototype, method);
}

declareRemote(ArchivedSessionsService, 'list');
declareRemote(ArchivedSessionsService, 'delete');
declareRemote(ArchivedSessionsService, 'unarchive');
declareRemote(ArchivedSessionsService, 'listBackups');
declareRemote(ArchivedSessionsService, 'pruneBackups');

// NOTE: there is deliberately NO `export default` here.
//
// Cordis resolves a plugin module through `unwrapExports`, which prefers
// `exports.default` over the namespace
// (`cordis-plugin-loader/lib/index.js:664-669`). A default export would
// therefore shadow `apply`/`inject`, and Cordis would mount the bare class
// against the root context — where the declared inject services are invisible,
// producing `cannot get property "workspaceRegistry" without inject`.
export { ArchivedSessionsService };
export { backupRoot as archivedSessionBackupRoot, artifactDirOf as archivedSessionArtifactDir };
