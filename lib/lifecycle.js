import { RemoteError } from './protocol.js';

// Cordis's documented identity symbol unwraps a traced service. Calling the
// saved method with the original receiver still preserves the caller's fiber.
const ORIGINAL = Symbol.for('cordis.original');

function sessionIdOf(method, request) {
	const id = method === 'resume' ? request?.resumeSessionId : request?.sessionId;
	return typeof id === 'string' && id !== '' ? id : undefined;
}

/** Capture public AgentHandles without taking ownership of unrelated Agents. */
export class SessionLifecycle {
	constructor(ctx, isDeleted) {
		this.ctx = ctx;
		this.isDeleted = isDeleted;
		this.handles = new Map();
		this.pending = new Map();
		this.deleting = new Set();
		this.deleted = new Set();
		this.restorers = [];
		this.closed = false;
		const traced = ctx.get('agents');
		const agents = traced?.[ORIGINAL] ?? traced;
		if (agents === undefined) return;
		ctx.effect(() => () => this.close(), 'archived-sessions: lifecycle tracking');
		try {
			this.install(agents);
		} catch (error) {
			this.close();
			throw error;
		}
	}

	install(agents) {
		for (const method of ['create', 'resume']) {
			const original = agents[method];
			if (typeof original !== 'function') continue;
			const descriptor = Object.getOwnPropertyDescriptor(agents, method);
			const lifecycle = this;
			const wrapper = function (request, ...args) {
				return lifecycle.run(sessionIdOf(method, request), () => Reflect.apply(original, this, [request, ...args]));
			};
			Object.defineProperty(agents, method, { configurable: true, writable: true, value: wrapper });
			this.restorers.push(() => {
				if (agents[method] !== wrapper) return;
				if (descriptor === undefined) delete agents[method];
				else Object.defineProperty(agents, method, descriptor);
			});
		}
		const off = this.ctx.on('session/disposed', (session) => {
			if (this.handles.get(session.id)?.agent.session === session) this.handles.delete(session.id);
		});
		if (typeof off === 'function') this.restorers.push(off);
	}

	assertAvailable(id) {
		if (id === undefined) return;
		if (this.deleting.has(id)) {
			throw new RemoteError('archived-sessions/delete-in-progress', `session "${id}" is being deleted`, { sessionId: id });
		}
		if (this.deleted.has(id)) {
			throw new RemoteError('archived-sessions/session-deleted', `session "${id}" has been deleted`, { sessionId: id });
		}
	}

	run(id, invoke) {
		if (this.closed) return Promise.resolve().then(invoke);
		// Register before the first await, so deletion can drain an already
		// admitted create/resume, including one whose handle has not returned yet.
		const operation = (async () => {
			this.assertAvailable(id);
			if (id !== undefined && await this.isDeleted(id)) this.deleted.add(id);
			this.assertAvailable(id);
			const handle = await invoke();
			if (!this.closed && handle?.agent?.session !== undefined && typeof handle.dispose === 'function') {
				const live = this.live(handle.agent.id);
				if (live.session === handle.agent.session && live.agent === handle.agent) this.handles.set(handle.agent.id, handle);
			}
			return handle;
		})();
		if (id !== undefined) {
			const operations = this.pending.get(id) ?? new Set();
			operations.add(operation);
			this.pending.set(id, operations);
			const settled = () => {
				operations.delete(operation);
				if (operations.size === 0 && this.pending.get(id) === operations) this.pending.delete(id);
			};
			void operation.then(settled, settled);
		}
		return operation;
	}

	live(id) {
		return { session: this.ctx.get('sessions')?.get(id), agent: this.ctx.get('agents')?.get(id) };
	}

	requireHandle(id) {
		const { session, agent } = this.live(id);
		if (session === undefined && agent === undefined) return undefined;
		const handle = this.handles.get(id);
		if (handle === undefined || (session !== undefined && handle.agent.session !== session) || (agent !== undefined && handle.agent !== agent)) {
			throw new RemoteError('archived-sessions/session-live', `session "${id}" has no tracked release handle; fully quit and reopen the app once to activate lifecycle tracking, then retry — closing the conversation page does not release it`, { sessionId: id });
		}
		return handle;
	}

	async release(id, signal) {
		signal?.throwIfAborted();
		const handle = this.requireHandle(id);
		if (handle === undefined) return;
		try {
			// Do not abandon an in-flight teardown on cancellation: the factory
			// owns the ordering of loop shutdown, persistence close and unregister.
			await handle.dispose();
		} catch (cause) {
			throw new RemoteError('archived-sessions/release-failed', `could not safely release session "${id}"; conversation files were not deleted`, { sessionId: id }, { cause });
		}
		const { session, agent } = this.live(id);
		if (session !== undefined || agent !== undefined) {
			throw new RemoteError('archived-sessions/release-failed', `session "${id}" is still registered after release; conversation files were not deleted`, { sessionId: id });
		}
		this.handles.delete(id);
		signal?.throwIfAborted();
	}

	async withDeletion(id, action, signal) {
		if (this.deleting.has(id)) {
			throw new RemoteError('archived-sessions/delete-in-progress', `session "${id}" is being deleted`, { sessionId: id });
		}
		this.deleting.add(id);
		try {
			const drained = Promise.allSettled([...(this.pending.get(id) ?? [])]);
			let onAbort;
			try {
				signal?.throwIfAborted();
				const cancelled = signal === undefined ? undefined : new Promise((_, reject) => {
					onAbort = () => reject(signal.reason);
					signal.addEventListener('abort', onAbort, { once: true });
				});
				await (cancelled === undefined ? drained : Promise.race([drained, cancelled]));
			} finally {
				if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
			}
			signal?.throwIfAborted();
			return await action();
		} finally {
			this.deleting.delete(id);
		}
	}

	markDeleted(id) {
		this.deleted.add(id);
	}

	close() {
		this.closed = true;
		for (const restore of this.restorers.splice(0).reverse()) restore();
		this.handles.clear();
		// Unloading this plugin only removes tracking; the original caller and
		// factory continue to own every live Agent's disposal.
	}
}
