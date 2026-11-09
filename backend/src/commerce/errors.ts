/** Business error with a stable code; tools return it to Claude as { ok: false, error: { code, message } }. */
export class CommerceError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
