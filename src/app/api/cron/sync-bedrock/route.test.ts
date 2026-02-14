import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from './route';

describe('GET /api/cron/sync-bedrock', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 'test-secret');
  });

  it('returns 401 without authorization header', async () => {
    const response = await GET(new Request('http://localhost/api/cron/sync-bedrock'));

    expect(response.status).toBe(401);
  });

  it('returns 401 with invalid authorization', async () => {
    const response = await GET(
      new Request('http://localhost/api/cron/sync-bedrock', {
        headers: { Authorization: 'Bearer wrong-secret' },
      })
    );

    expect(response.status).toBe(401);
  });

  it('skips when AWS env vars not configured', async () => {
    vi.stubEnv('AWS_BEDROCK_LOG_GROUP', '');
    vi.stubEnv('AWS_BEDROCK_EXPORT_BUCKET', '');

    const response = await GET(
      new Request('http://localhost/api/cron/sync-bedrock', {
        headers: { Authorization: 'Bearer test-secret' },
      })
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.skipped).toBe(true);
    expect(data.reason).toContain('not configured');
  });
});

describe('POST /api/cron/sync-bedrock', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 'test-secret');
  });

  it('returns 401 without authorization header', async () => {
    const { POST } = await import('./route');
    const response = await POST(
      new Request('http://localhost/api/cron/sync-bedrock', { method: 'POST' })
    );

    expect(response.status).toBe(401);
  });
});
