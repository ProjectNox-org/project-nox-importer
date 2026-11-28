import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
// Multi-path dotenv resolution for Discloud container environments
const candidateEnvPaths = [
    path.resolve(process.cwd(), '.env'),
    '/home/node/.env',
    '/home/node/app/.env',
];
try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    candidateEnvPaths.push(path.resolve(currentDir, '../.env'));
    candidateEnvPaths.push(path.resolve(currentDir, '../../.env'));
}
catch {
    // ignore
}
for (const envPath of candidateEnvPaths) {
    if (fs.existsSync(envPath)) {
        dotenv.config({ path: envPath });
    }
}
for (const baseEnvPath of candidateEnvPaths) {
    const overridePath = `${baseEnvPath}.pg18.override`;
    if (fs.existsSync(overridePath)) {
        dotenv.config({ path: overridePath, override: true });
    }
}
dotenv.config();
const ConfigSchema = z.object({
    SUPABASE_URL: z.string().url().default('https://placeholder.supabase.co'),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).default('placeholder-service-role-key'),
    STORAGE_PROVIDER: z.enum(['worker', 'telegram', 'mock', 'direct_telegram']).default('direct_telegram'),
    NOX_STORAGE_BRIDGE_TOKEN: z.string().optional(),
    NOX_MANGA_URL: z.string().url().default('https://projectnox.org'),
    NOX_IMPORTER_GATEWAY_URL: z.string().url().default('https://project-nox-importer-gateway.project-nox-awerkori.workers.dev'),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_CHAT_ID: z.string().optional(),
    IMPORTER_USER_ID: z.string().uuid().optional(),
    WORKER_ID: z.string().min(1).default(() => `nox-worker-${process.pid}-${Math.random().toString(36).slice(2, 7)}`),
    POLL_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(60),
    QUEUE_LEASE_DURATION_SECONDS: z.coerce.number().int().min(30).default(600),
    QUEUE_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(60),
    MAX_CONCURRENT_CHAPTERS: z.coerce.number().int().min(1).max(128).default(4),
    // V3: allow bounded multi-worker pipeline (4 workers + WebP semaphore + short TXs)
    // while keeping RSS <= 520 MiB and preserving site headroom via SiteProtectionController.
    LITE_CHAPTER_WORKERS: z.coerce.number().int().min(1).max(32).default(4),
    ADAPTIVE_INITIAL_CONCURRENCY: z.coerce.number().int().min(1).max(128).default(4),
    TESTED_CONCURRENCY_CEILING: z.coerce.number().int().min(1).max(128).default(8),
    BATCH_PAGE_DOWNLOAD_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
    WEBP_MAX_CONCURRENT: z.coerce.number().int().min(1).max(4).default(3),
    WEBP_MAX_CONCURRENT_HEAVY: z.coerce.number().int().min(1).max(2).default(1),
    // V3 PostgreSQL OVH pool headroom: up to 4 connections default (max 6) eliminates poolMax=1
    // serialization bottleneck while protecting public Reader/Lançamentos queries.
    DIRECT_DB_POOL_MAX: z.coerce.number().int().min(1).max(6).default(4),
    METADATA_DB_POOL_MAX: z.coerce.number().int().min(1).max(1).default(1),
    // At the measured 52.75 MiB median chapter size, the former 4 MiB/s global
    // ceiling could never reach the 8/min acceptance floor (4.55/min before
    // network and publication overhead). Eight MiB/s is the first reversible
    // ramp; bot, shard, request and global-media limits still apply.
    UPLOAD_RATE_LIMIT_BYTES_PER_SEC: z.coerce.number().int().default(8 * 1024 * 1024),
    // Bounded media concurrency to protect DB connection manager and CPU.
    TELEGRAM_MEDIA_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(6),
    DOWNLOAD_INFLIGHT_CONCURRENCY: z.coerce.number().int().min(1).max(48).default(12),
    BUFFERED_PAGE_CONCURRENCY: z.coerce.number().int().min(1).max(96).default(24),
    // Upstream adapter calls are network work, not a reason to monopolize a
    // chapter slot. The timeout is deliberately independent from the durable
    // task lease and results in capped retry/cooldown handling.
    SOURCE_OPERATION_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(120_000).default(30_000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    IMPORTER_DB_MODE: z.enum(['direct', 'gateway']).default('direct'),
    // This branch is the approved Lite cutover artifact.  An explicit `legacy`
    // setting remains available only for the documented rollback procedure; a
    // fresh deployment must never silently revive the v1 scheduler because an
    // environment variable was omitted by the native DIScloud Git integration.
    IMPORTER_RUNTIME_MODE: z.enum(['legacy', 'lite']).default('lite'),
    YUGABYTE_HOST: z.string().default('sa-east-1.b49305ea-8536-43e6-936e-b2fd77fc07b0.aws.yugabyte.cloud'),
    YUGABYTE_PORT: z.coerce.number().default(5433),
    YUGABYTE_USER: z.string().default('admin'),
    YUGABYTE_PASSWORD: z.string().min(1, 'YUGABYTE_PASSWORD environment variable is required'),
    YUGABYTE_DATABASE: z.string().default('project_nox_prod'),
    YUGABYTE_SSL_CERT: z.string().default('certs/yugabyte-root.crt'),
    YUGABYTE_SSL_MODE: z.enum(['verify-full', 'require', 'disable']).default('verify-full'),
    DB_MTLS_ENABLED: z.coerce.boolean().default(false),
    DB_MTLS_CA_CERT: z.string().optional(),
    DB_MTLS_CLIENT_CERT: z.string().optional(),
    DB_MTLS_CLIENT_KEY: z.string().optional(),
    DB_MTLS_SERVERNAME: z.string().default('pg-importer.nox.internal'),
});
let _config = null;
export function getConfig() {
    if (!_config) {
        const result = ConfigSchema.safeParse(process.env);
        if (!result.success) {
            console.error('Invalid configuration:', result.error.format());
            throw new Error('Invalid environment configuration');
        }
        _config = result.data;
    }
    return _config;
}
export function setTestConfig(overrides) {
    _config = { ...getConfig(), ...overrides };
}
