import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Strict Content-Security-Policy for the built app: no inline scripts or styles,
 * no third-party origins, no framing. (Only added to the build because the dev
 * server's hot-reload preamble is an inline script.) Components therefore must
 * not use inline `style` attributes.
 *
 * `frame-ancestors` is ignored in a <meta> policy, so clickjacking protection must
 * come from the hosting layer as HTTP headers:
 *   Content-Security-Policy: frame-ancestors 'none'   and   X-Frame-Options: DENY
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
    ],
  };
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  server: {
    port: 5173,
    // The API listens on loopback only; the dev server forwards /v1 to it.
    proxy: { '/v1': 'http://127.0.0.1:8787' },
  },
  preview: {
    port: 4173,
    proxy: { '/v1': 'http://127.0.0.1:8787' },
  },
});
