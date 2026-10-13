import * as path from 'node:path';

/**
 * Allow only descendants of a known directory, using the runtime's path rules.
 * `relative` handles Windows drive letters, case, separators and UNC shares;
 * an absolute result denotes another drive/share. Reject the root itself so a
 * malformed persistence location cannot remove every session.
 *
 * The optional path implementation lets callers verify win32/posix semantics
 * without changing the platform used by the rest of the process.
 */
export function isInsideDirectory(root, candidate, paths = path) {
	if (typeof root !== 'string' || root === '' || typeof candidate !== 'string' || candidate === '') return false;
	const relativePath = paths.relative(paths.resolve(root), paths.resolve(candidate));
	return relativePath !== ''
		&& !paths.isAbsolute(relativePath)
		&& relativePath !== '..'
		&& !relativePath.startsWith(`..${paths.sep}`);
}
