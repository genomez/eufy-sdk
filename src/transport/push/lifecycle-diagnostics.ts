/** Finite lifecycle evidence; no messages, peer addresses, credentials or payloads are retained. */
export type PushLifecycleEvent =
  | "connecting"
  | "tls_connected"
  | "login_accepted"
  | "login_rejected"
  | "server_close"
  | "socket_error"
  | "socket_closed"
  | "reconnect_scheduled"
  | "close_requested";

/** Only explicitly recognized runtime error codes cross the diagnostic boundary. */
export type PushSocketErrorCode =
  | "ECONNRESET"
  | "ECONNREFUSED"
  | "ETIMEDOUT"
  | "EPIPE"
  | "ENETUNREACH"
  | "EHOSTUNREACH"
  | "ENOTFOUND"
  | "EAI_AGAIN"
  | "ERR_TLS_CERT_ALTNAME_INVALID"
  | "CERT_HAS_EXPIRED"
  | "DEPTH_ZERO_SELF_SIGNED_CERT"
  | "other";

const errorCodes = new Set<string>([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
]);

/** A transport observation, not a claim about why the peer or network closed a connection. */
export interface PushLifecycleObservation {
  atMs: number;
  attempt: number;
  event: PushLifecycleEvent;
  errorCode: PushSocketErrorCode | null;
  hadError: boolean | null;
  loggedIn: boolean;
  closing: boolean;
  staleSocket: boolean;
  retryDelayMs: number | null;
}

/** Detached bounded history spanning successive clients in one recorder lifetime. */
export interface PushLifecycleDiagnostics {
  attempts: number;
  total: number;
  evicted: number;
  recent: PushLifecycleObservation[];
}

/** Retains the latest 32 observations and cumulative counts without retaining error objects. */
export class PushLifecycleRecorder {
  private attempts = 0;
  private total = 0;
  private readonly recent: PushLifecycleObservation[] = [];

  beginAttempt(): number {
    return ++this.attempts;
  }

  record(
    event: PushLifecycleEvent,
    attempt: number,
    state: { loggedIn: boolean; closing: boolean; staleSocket?: boolean },
    detail: { errorCode?: unknown; hadError?: boolean; retryDelayMs?: number } = {},
  ): void {
    this.total++;
    this.recent.push({
      atMs: Date.now(),
      attempt,
      event,
      errorCode:
        event === "socket_error"
          ? typeof detail.errorCode === "string" && errorCodes.has(detail.errorCode)
            ? (detail.errorCode as PushSocketErrorCode)
            : "other"
          : null,
      hadError: typeof detail.hadError === "boolean" ? detail.hadError : null,
      loggedIn: state.loggedIn,
      closing: state.closing,
      staleSocket: state.staleSocket === true,
      retryDelayMs: detail.retryDelayMs ?? null,
    });
    if (this.recent.length > 32) this.recent.shift();
  }

  diagnostics(): PushLifecycleDiagnostics {
    return {
      attempts: this.attempts,
      total: this.total,
      evicted: this.total - this.recent.length,
      recent: this.recent.map((row) => ({ ...row })),
    };
  }
}
