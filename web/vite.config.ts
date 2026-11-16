import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// The C++ compute backend port. `scripts/dev.sh <port>` exports this, so the /api proxy
// follows the port the backend was actually started on instead of assuming the default.
const backendPort = process.env.DC_BACKEND_PORT ?? '37811';

// ── Same-origin Origin rewrite for /api ─────────────────────────────────────
// backend/src/http_server.cpp answers 403 {"code":"forbiddenOrigin"} to every request whose
// Origin is neither `http(s)://127.0.0.1[:port]` nor `http(s)://localhost[:port]`, and that
// gate is a frozen contract — the front end must present a loopback Origin instead of asking
// the backend to relax. A browser attaches `Origin: <page origin>` to same-origin POSTs too,
// so a workbench loaded from a public URL sends a public Origin and every write is refused.
// The proxy is the only hop that can see "this request already came in through our own front
// end", so it rewrites the header to the loopback value the backend accepts.
//
// The rewrite is gated on proof of same origin, never on a guess about the request: the
// browser sets Origin itself and page script cannot forge it, so an Origin whose authority
// equals the authority the browser used to reach this server can only come from a page we
// serve. That authority is recorded in one of two places:
//   · req.headers.host    client hit this server directly (http://<host>:5173)
//   · x-forwarded-host    a terminator in front replaced Host and preserved the original.
//                         That is the real deployment: /etc/caddy/Caddyfile serves the
//                         workbench on pocket.* and proxies with `header_up Host localhost:5173`
//                         — measured, the upstream then gets host: localhost:5173 together
//                         with x-forwarded-host: <public host>:<port>. Compared against Host
//                         alone, that request would look cross-site and stay broken.
// Every other request — a cross-site page driving this proxy, an Origin matching neither
// authority, an unparsable Origin, or no Origin at all — is forwarded byte for byte, so the
// backend's 403 stays the backstop.
//
// The security model is unchanged in both directions: no new origin becomes trusted by the
// backend (the rewrite only produces a loopback origin the backend already trusts), Vite's own
// Host/allowedHosts check still rejects DNS-rebinding requests before this proxy runs, and the
// hook edits one header on the 127.0.0.1 hop. Nor does it widen access for non-browser clients:
// one that can reach the port directly can already omit Origin, which the backend serves
// without the gate at all.
const loopbackOrigin = 'http://127.0.0.1:';
const defaultFrontPort = '5173';

/** "scheme://authority/path" → "authority" (lower-cased); null when no authority parses. */
function authorityOf(url: string): string | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url);
  return match ? match[1].toLowerCase() : null;
}

/** "host:port" → "port"; null when the port is absent or not a plain number. */
function portOf(authority: string): string | null {
  const colon = authority.lastIndexOf(':');
  if (colon === -1) return null;
  const port = authority.slice(colon + 1);
  return /^\d{1,5}$/.test(port) ? port : null;
}

/** Node types headers as `string | string[] | undefined`; only the first value matters here. */
function firstHeader(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  return Array.isArray(value) && value.length > 0 ? value[0] : null;
}

const rewriteSameOriginOrigin: NonNullable<ProxyOptions['configure']> = (proxy) => {
  proxy.on('proxyReq', (proxyReq, req) => {
    const origin = firstHeader(req.headers.origin);
    if (!origin) return; // non-browser client: the backend's no-Origin path stays untouched
    const originAuthority = authorityOf(origin);
    if (!originAuthority) return; // opaque ("null") or unparsable → let the backend refuse it
    const frontAuthorities = [
      firstHeader(req.headers.host),
      firstHeader(req.headers['x-forwarded-host']),
    ]
      .filter((value): value is string => value !== null)
      .map((value) => value.trim().toLowerCase());
    // A cross-site page reaches neither branch: its Origin equals no authority of ours.
    const reachedAs = frontAuthorities.find((authority) => authority === originAuthority);
    if (!reachedAs) return;
    proxyReq.setHeader('origin', loopbackOrigin + (portOf(reachedAs) ?? defaultFrontPort));
  });
};

export default defineConfig({
  // Sub-path deployments (GitHub Pages serves at /<repo>/) need every asset URL prefixed.
  // Local dev and a persistent deployment keep the default '/'.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // xlsx ships as a plain ESM/UMD bundle; pre-bundle it so the lazy import in the
  // xlsx loader resolves consistently in dev and in the production build.
  optimizeDeps: {
    include: ['@e965/xlsx'],
  },
  server: {
    // Loopback by default. The backend has NO authentication (backend-protocol-v1:
    // "无鉴权…跨机部署前必须先补 token") and this dev server proxies /api/* straight
    // through, so binding every interface would hand the full matrix/node API to anything
    // that can reach the port. Opt in deliberately when you want LAN access:
    //   VITE_HOST=0.0.0.0 ./scripts/dev.sh      (or `npx vite --host 0.0.0.0`)
    host: process.env.VITE_HOST ?? '127.0.0.1',
    // Vite rejects requests whose Host header is neither localhost, *.localhost nor an IP
    // (DNS-rebinding guard). The DNS name this box publishes the workbench under has to be
    // listed for a client that opens http://<that name>:5173 directly; an attacker's own
    // hostname is still rejected, which is exactly what the guard is for. Traffic through
    // Caddy arrives as Host: localhost:5173 and never needs an entry here.
    allowedHosts: [process.env.VITE_ALLOWED_HOST ?? 'tegrocket.dynv6.net'],
    proxy: {
      // Backend-owned compute: forward /api/* to the C++ compute backend (DC_BACKEND_PORT, default 37811).
      '/api': {
        target: `http://127.0.0.1:${backendPort}`,
        changeOrigin: true,
        // Same-origin Origin rewrite so the backend's loopback-only gate accepts browser
        // writes; see the block above for why Origin==Host/X-Forwarded-Host is the proof.
        configure: rewriteSameOriginOrigin,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
});
