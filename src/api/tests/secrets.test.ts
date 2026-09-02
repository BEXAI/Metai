/**
 * Gate A14: no key material or API-key-looking literals anywhere under src/,
 * and .gitignore covers .dev.vars and *.secret. (The other half of A14 — the
 * front door stating that no key is ever requested — is doc.test.ts.)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url).href);

/** Patterns that match real credential shapes, not hex test fixtures. */
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{8}/ },
  { name: 'OpenAI-style key', re: /sk-proj-[A-Za-z0-9_-]{8}/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'private key PEM', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'hardcoded secret assignment', re: /(?:api_key|apikey|secret_key|auth_token)\s*[:=]\s*['"][A-Za-z0-9+/_-]{20,}['"]/i },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === '.wrangler') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|js|mjs|json|jsonc|sql|md|txt|html|css)$/.test(name)) out.push(full);
  }
  return out;
}

describe('A14 secrets hygiene', () => {
  it('no file under src/ contains an API-key-looking literal', () => {
    const files = walk(join(REPO_ROOT, 'src'));
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(content)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('schema.sql and wrangler.jsonc are clean too', () => {
    for (const rel of ['schema.sql', 'wrangler.jsonc', 'package.json']) {
      const content = readFileSync(join(REPO_ROOT, rel), 'utf8');
      for (const { name, re } of SECRET_PATTERNS) {
        expect(re.test(content), `${rel}: ${name}`).toBe(false);
      }
    }
  });

  it('.gitignore covers .dev.vars, *.secret, and .wrangler', () => {
    const gitignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.dev.vars');
    expect(gitignore).toContain('*.secret');
    expect(gitignore).toContain('.wrangler');
  });

  it('the Worker reads secrets only from env bindings (spot check)', () => {
    const index = readFileSync(join(REPO_ROOT, 'src', 'index.ts'), 'utf8');
    expect(index).toContain('CHECKPOINT_SK?: string');
    // No literal assignment of the secret anywhere.
    expect(/CHECKPOINT_SK\s*=\s*['"]/.test(index)).toBe(false);
  });
});
