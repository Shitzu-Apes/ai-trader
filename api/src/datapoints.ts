import dayjs from 'dayjs';
import { Hono } from 'hono';
import { z } from 'zod';

import { EnvBindings } from './types';

const app = new Hono<{ Bindings: EnvBindings }>();

const symbolSchema = z.enum(['NEAR/USDT', 'SOL/USDT', 'BTC/USDT', 'ETH/USDT'] as const);
const indicatorSchema = z.enum(['candle', 'vwap', 'atr', 'bbands', 'rsi', 'obv'] as const);

app.get('/latest/:symbol/:indicator', async (c) => {
	const symbol = c.req.param('symbol');
	const indicator = c.req.param('indicator');

	if (!symbolSchema.safeParse(symbol).success || !indicatorSchema.safeParse(indicator).success) {
		return c.json({ error: 'Invalid symbol or indicator' }, 400);
	}

	const now = dayjs();
	const minutes = now.minute();
	const currentTimeframe = Math.floor(minutes / 5) * 5;
	const date = now.startOf('hour').add(currentTimeframe, 'minute');

	console.log('[date]', date.format('YYYY-MM-DD HH:mm'));

	const key = `${symbol}-${indicator}-${date.valueOf()}`;
	const data = await c.env.KV.get(key);

	if (!data) {
		return c.json({ error: 'No data found' }, 404);
	}

	return c.json({
		symbol,
		indicator,
		timestamp: date.valueOf(),
		data: JSON.parse(data)
	});
});

export default app;
