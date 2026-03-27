// Legacy bootstrap test removed — src/index.ts is now a stub replaced by Next.js app.
// See test/unit/firebase-config.test.ts and other unit tests for web coverage.
import { describe, it } from 'vitest';

describe('web package', () => {
  it('is bootstrapped as a Next.js app (no standalone exports)', () => {
    // This test exists to keep the test suite non-empty.
    // The web package no longer exports a bootstrap helper —
    // it is a Next.js application. See apps/web/src/app/ for entry points.
  });
});
