import { homedir } from 'os';
import { join } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import type { Credentials } from './types.js';

const CONFIG_DIR = join(homedir(), '.moltgames');
const CREDENTIALS_FILE = join(CONFIG_DIR, 'credentials.json');

export async function loadCredentials(): Promise<Credentials | null> {
  try {
    const raw = await readFile(CREDENTIALS_FILE, 'utf-8');
    const creds = JSON.parse(raw) as Credentials;
    return creds;
  } catch {
    return null;
  }
}

export async function saveCredentials(creds: Credentials): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export async function clearCredentials(): Promise<void> {
  try {
    const { unlink } = await import('fs/promises');
    await unlink(CREDENTIALS_FILE);
  } catch {
    // ignore if not found
  }
}

export function isTokenExpired(creds: Credentials, bufferMs = 60_000): boolean {
  return Date.now() >= creds.expiresAt - bufferMs;
}
