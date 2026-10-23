// Keep the workspace path URI-safe: its URL path is used by the runtime's
// in-memory file system, which does not decode percent-escaped path segments.
export const workspacePath = '/Three.js-Demo'
export const workspaceUri = `memfs://${workspacePath}`
