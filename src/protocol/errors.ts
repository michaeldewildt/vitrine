/**
 * errors.ts — the protocol error type (one typed failure per condition;
 * the `code` is the machine-readable surface, the message the human one).
 */
export type ProtocolErrorCode =
	| "bad-path"
	| "bad-spec"
	| "bad-state"
	| "bad-events"
	| "no-state"
	| "no-spec"
	| "no-session"
	| "bad-session"
	| "bad-marker"
	| "bad-lease"
	| "exists"
	| "session-exists"
	| "marker-exists"
	| "no-boot-id"
	| "bad-config"
	| "bad-agent"
	| "bad-input"
	| "no-compositor"
	| "invalid-task-dir"
	| "io";

export class ProtocolError extends Error {
	constructor(
		public readonly code: ProtocolErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ProtocolError";
	}
}
