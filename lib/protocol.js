/**
 * The slice of `@deepseek-ai/dsh-typert-protocol` this plugin needs, implemented
 * locally.
 *
 * WHY THIS EXISTS
 * ---------------
 * A profile-installed plugin's own directory is the module root Node resolves
 * its imports from. That directory lives outside the DSH installation (here it
 * is a workspace folder), so a bare `@deepseek-ai/...` specifier does NOT
 * resolve — and the Cordis loader treats an import failure as a log line, not a
 * startup error, leaving the plugin entry silently `inactive`.
 *
 * The alternative would be to mount the plugin inside the DSH installation,
 * which the plugin manager is explicitly built to avoid.
 *
 * Everything below is behaviour the Gateway's SRC path reads, and the shapes
 * are fixed by `@deepseek-ai/dsh-api-gateway`:
 *
 *  - a service whose original object owns a `typertRemote` property
 *    (`readBinding` in `dsh-api-gateway/lib/index.js`), and
 *  - a prototype descriptor at the well-known key
 *    `"@deepseek-ai/dsh-typert-protocol/remote-methods"` listing
 *    `{ method, invocation, [exportName], [mode] }` markers
 *    (`remoteMethods` / `readRemoteMethodDescriptor`).
 *
 * `RemoteError` is reproduced too, because the Gateway identifies a Remote
 * failure structurally (`isDSHRemoteError === true` + string `code`) rather than
 * by `instanceof`, so a local class crosses the wire identically.
 *
 * Nothing here reaches into Cordis internals: the service is registered through
 * the public `ctx.provide()` seam that Cordis's own `Service` constructor uses.
 *
 * @module dsh-plugin-archived-sessions/protocol
 */

/** Remote names cross the Connection endpoint grammar verbatim. */
const SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

/**
 * @param subject - name kind, for the diagnostic.
 * @param value - candidate name.
 */
function validateName(subject, value) {
	if (typeof value !== 'string' || value === '.' || value === '..' || !SEGMENT_PATTERN.test(value)) {
		throw new TypeError(`archived-sessions: ${subject} must contain only RPC endpoint segment characters`);
	}
}

/** Property key carrying a service's Remote method markers. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/**
 * One Remote call failure: a real Error carrying its stable code and details.
 *
 * Structurally identical to the shipped class so the Gateway encodes it as a
 * typed failure and the browser rebuilds an equivalent error object.
 */
export class RemoteError extends Error {
	/**
	 * @param code - stable failure code.
	 * @param message - human diagnostic carried across the wire.
	 * @param details - structured payload for the code.
	 * @param options - standard Error options.
	 */
	constructor(code, message, details, options) {
		super(message, options);
		this.code = code;
		this.details = details;
		this.name = 'RemoteError';
		this.isDSHRemoteError = true;
	}
}

/**
 * Bind one visible service field to a Cordis key and Remote namespace.
 *
 * The returned object is frozen because the Gateway validates it strictly: it
 * must carry the exact service instance it is attached to, plus the Cordis
 * service key and the wire namespace.
 *
 * @param service - owning service instance.
 * @param serviceKey - exact Cordis service key.
 * @param options - optional distinct wire namespace.
 * @returns the frozen binding.
 */
export function bindTypertRemote(service, serviceKey, options = {}) {
	validateName('service key', serviceKey);
	const namespace = options.namespace ?? serviceKey;
	validateName('namespace', namespace);
	return Object.freeze({ service, serviceKey, namespace });
}

/**
 * Record one `@Remote`-style marker on a prototype.
 *
 * Mirrors the shipped `mark()`: markers accumulate under one versioned
 * descriptor, and a conflicting re-mark is refused rather than silently
 * replacing the first.
 *
 * @param prototype - the prototype receiving the marker.
 * @param method - method name, which is also the wire method name.
 * @param exportName - optional distinct wire name.
 */
export function markRemote(prototype, method, exportName) {
	const existing = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR);
	const descriptor = existing?.value;
	const marker = Object.freeze({
		method,
		...(exportName === undefined || exportName === method ? {} : { exportName }),
		invocation: Object.freeze({ kind: 'direct' })
	});
	const current = descriptor?.methods?.find((candidate) => candidate.method === method);
	if (current !== undefined) {
		if (current.exportName === marker.exportName) return;
		throw new Error(`archived-sessions: Remote method "${method}" has conflicting invocation markers`);
	}
	Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
		configurable: true,
		value: Object.freeze({
			version: 1,
			methods: Object.freeze([...(descriptor?.methods ?? []), marker])
		})
	});
}

/**
 * Read a service's Remote markers in declaration order.
 *
 * @param service - live service instance.
 * @returns the markers.
 */
export function remoteMethods(service) {
	const prototype = Object.getPrototypeOf(service);
	if (prototype === null) return [];
	const descriptor = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR)?.value;
	if (descriptor === undefined) return [];
	if (descriptor === null || typeof descriptor !== 'object' || descriptor.version !== 1 || !Array.isArray(descriptor.methods)) {
		throw new TypeError('archived-sessions: unsupported Remote method descriptor');
	}
	return descriptor.methods.map((marker) => ({ ...marker }));
}

/**
 * Build a service base class that registers through the public Cordis
 * `ctx.provide()` seam and publishes the Typert binding the Gateway reads.
 *
 * Cordis's own `Service` class does exactly these two things in its
 * constructor; this reproduces them without importing Cordis, so the plugin
 * stays import-clean.
 *
 * @returns a base class whose constructor is `(ctx, serviceKey)`.
 */
export function createRemoteServiceBase() {
	return class RemoteService {
		/**
		 * @param ctx - owning Cordis context.
		 * @param serviceKey - exact Cordis service key and default wire namespace.
		 */
		constructor(ctx, serviceKey) {
			validateName('service key', serviceKey);
			this.ctx = ctx;
			this.name = serviceKey;
			// `ctx.provide` is the documented registration seam; the returned
			// disposer is owned by the calling fiber, which unregisters the service.
			ctx.provide(serviceKey, this);
			this.typertRemote = bindTypertRemote(this, serviceKey);
		}
	};
}

export { REMOTE_METHOD_DESCRIPTOR };
