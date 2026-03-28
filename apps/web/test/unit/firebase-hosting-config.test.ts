import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface FirebaseHeader {
  key: string;
  value: string;
}

interface FirebaseHostingConfig {
  cleanUrls?: boolean;
  rewrites?: Array<{
    source: string;
    destination: string;
  }>;
  headers?: Array<{
    source: string;
    headers: FirebaseHeader[];
  }>;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function readHostingConfig(): FirebaseHostingConfig {
  const raw = readFileSync(resolve(repoRoot, 'firebase/firebase.json'), 'utf8');
  const parsed = JSON.parse(raw) as { hosting?: FirebaseHostingConfig };

  if (parsed.hosting === undefined) {
    throw new Error('firebase hosting config is missing');
  }

  return parsed.hosting;
}

function findCspHeader(hosting: FirebaseHostingConfig): string {
  const value = hosting.headers
    ?.flatMap((entry) => entry.headers)
    .find((header) => header.key === 'Content-Security-Policy')?.value;

  if (value === undefined) {
    throw new Error('Content-Security-Policy header is missing');
  }

  return value;
}

describe('firebase hosting config', () => {
  it('uses clean URLs instead of rewriting every route to index.html', () => {
    const hosting = readHostingConfig();

    expect(hosting.cleanUrls).toBe(true);
    expect(hosting.rewrites ?? []).not.toContainEqual(
      expect.objectContaining({
        source: '**',
        destination: '/index.html',
      }),
    );
  });

  it('allows the production gateway origin in connect-src', () => {
    const csp = findCspHeader(readHostingConfig());

    expect(csp).toMatch(/connect-src[^;]*https:\/\/api\.moltgame\.com/);
  });
});
