import { Hono } from 'hono';
import type { PlatformConfig } from './platform-config.js';
import { Store } from './store.js';
import { syncElevenLabsUsage, usageReport } from './usage.js';

export function usageRoutes(store: Store, config: PlatformConfig) {
  const app = new Hono();
  app.get('/usage', async (c) => {
    const value = c.req.query('days');
    const days = value === undefined ? 30 : Number(value);
    if (!Number.isInteger(days) || days < 1 || days > 90)
      return c.json({ error: 'Days must be an integer from 1 to 90.' }, 400);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        syncElevenLabsUsage(store, {
          apiKey: config.voiceKey,
          agentId: config.elevenlabsAgentId,
        }),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 8_000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    return c.json(usageReport(store, days));
  });
  return app;
}
