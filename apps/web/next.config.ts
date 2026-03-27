import type { NextConfig } from 'next';

const isDev = process.env['NODE_ENV'] === 'development';

const securityHeaders = [
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    key: 'X-Frame-Options',
    value: 'DENY',
  },
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=()',
  },
  {
    key: 'Content-Security-Policy',
    // Allow Firebase Auth domains for sign-in popups/redirects and the app's own API.
    // 'unsafe-inline' for styles is required by Tailwind CSS; tighten to a hash/nonce in a future pass.
    // 'unsafe-eval' is only included in development (Next.js HMR requires it).
    value: [
      "default-src 'self'",
      isDev ? "script-src 'self' 'unsafe-eval'" : "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self'",
      // Firebase Auth popups and API calls
      "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com wss://*.firebaseio.com",
      "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
];

const nextConfig: NextConfig = {
  transpilePackages: ['@moltgames/domain'],
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
