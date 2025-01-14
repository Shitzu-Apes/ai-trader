import { serve } from '@hono/node-server';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { fetchDepth, fetchLiquidationZones } from './binance';

const app = new Hono();

const symbolSchema = z.string().transform((val) => decodeURIComponent(val));

// Add logging middleware
app.use('*', async (c, next) => {
	const start = Date.now();
	const timestamp = new Date().toISOString();
	const method = c.req.method;
	const path = c.req.path;

	console.log(`[${timestamp}] ${method} ${path} - Request received`);

	await next();

	const duration = Date.now() - start;
	console.log(`[${timestamp}] ${method} ${path} - Response sent (${duration}ms)`);
});

app.get('/depth/:symbol', zValidator('param', z.object({ symbol: symbolSchema })), async (c) => {
	const timestamp = new Date().toISOString();
	try {
		const { symbol } = c.req.valid('param');
		if (!['NEAR/USDT', 'SOL/USDT', 'BTC/USDT', 'ETH/USDT'].includes(symbol)) {
			console.log(`[${timestamp}] Invalid symbol requested: ${symbol}`);
			return c.json({ error: 'Invalid symbol' }, 400);
		}
		console.log(`[${timestamp}] Fetching depth data for symbol: ${symbol}`);
		const depth = await fetchDepth(symbol);
		return c.json(depth);
	} catch (error) {
		console.error(`[${timestamp}] Error fetching depth:`, error);
		return c.json({ error: 'Failed to fetch depth data' }, 500);
	}
});

app.get(
	'/liquidation-zones/:symbol',
	zValidator('param', z.object({ symbol: symbolSchema })),
	async (c) => {
		const timestamp = new Date().toISOString();
		try {
			const { symbol } = c.req.valid('param');
			if (!['NEAR/USDT', 'SOL/USDT', 'BTC/USDT', 'ETH/USDT'].includes(symbol)) {
				console.log(`[${timestamp}] Invalid symbol requested: ${symbol}`);
				return c.json({ error: 'Invalid symbol' }, 400);
			}
			console.log(`[${timestamp}] Fetching liquidation zones for symbol: ${symbol}`);
			const zones = await fetchLiquidationZones(symbol);
			return c.json(zones);
		} catch (error) {
			console.error(`[${timestamp}] Error fetching liquidation zones:`, error);
			return c.json({ error: 'Failed to fetch liquidation zones data' }, 500);
		}
	}
);

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
console.log(`[${new Date().toISOString()}] Server is running on port ${port}`);

serve({
	fetch: app.fetch,
	port
});
