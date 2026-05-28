// redact.ts — credential-leakage sanitizer for any string that may
// transit untrusted intermediaries (proxy 502 bodies, third-party log
// sinks, error envelopes that get JSON.stringified into LLM context).
//
// Threat model: a reverse proxy / Kubernetes ingress with debug
// headers, or an HTML error page that echoes request headers, can put
// `Authorization: Bearer <jwt>` into an upstream response body. If
// that body gets interpolated into an exception message that bubbles
// to a Claude tool call, the JWT lands in the LLM's context and may
// be exfiltrated. Redact at the boundary, not at the use site.
//
// Two patterns are stripped:
//   1. `Bearer <token>` — the wire form in HTTP request headers
//   2. Bare `eyJ…` — the EIP-712 JWT prefix, in case the token
//      appears without the `Bearer` qualifier (e.g. logged solo)
//
// Shared by mcp-servers/protocol-api/server.ts (apiCall error path)
// and src/forge/quadphase-flow.ts (six flow-helper error throws).

export function redactBearer(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]{8,}/g, "Bearer <redacted>")
    .replace(/\beyJ[A-Za-z0-9._\-+/=]{20,}/g, "<redacted-jwt>");
}
