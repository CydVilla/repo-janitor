import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { JanitorConfig } from './types.js';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const linkFeatureSchema = z
  .object({
    enabled: z.boolean().default(true),
    report: z.enum(['issue', 'none']).default('issue'),
    email: z.array(z.string().regex(EMAIL_RE, 'invalid email address')).default([]),
    ignoreUrlPatterns: z.array(z.string()).default([]),
    failThreshold: z.number().int().min(1).default(3),
  })
  .default({
    enabled: true,
    report: 'issue',
    email: [],
    ignoreUrlPatterns: [],
    failThreshold: 3,
  });

const deadCodeFeatureSchema = z
  .object({
    enabled: z.boolean().default(false),
    openPRs: z.boolean().default(true),
    fixTypes: z.array(z.string()).default(['exports', 'types']),
    verifyCommands: z.array(z.string()).optional(),
  })
  .default({
    enabled: false,
    openPRs: true,
    fixTypes: ['exports', 'types'],
  });

const repoSchema = z.object({
  repo: z.string().regex(REPO_RE, 'expected "owner/name"'),
  branch: z.string().optional(),
  links: linkFeatureSchema,
  deadCode: deadCodeFeatureSchema,
});

const configSchema = z.object({
  repos: z.array(repoSchema).default([]),
});

/**
 * Load and validate repos.json, applying defaults so downstream code always
 * sees fully-populated feature configs.
 */
export async function loadConfig(path = 'repos.json'): Promise<JanitorConfig> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  return configSchema.parse(raw);
}
