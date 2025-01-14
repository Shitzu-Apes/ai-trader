import dayjs from 'dayjs';
import { Hono } from 'hono';
import { z } from 'zod';

import { makeForecast } from './taapi';
import { EnvBindings } from './types';

const app = new Hono<{ Bindings: EnvBindings }>();

const symbolSchema = z.enum(['NEAR/USDT', 'SOL/USDT', 'BTC/USDT', 'ETH/USDT'] as const);
const indicatorSchema = z.enum(['candle', 'vwap', 'atr', 'bbands', 'rsi', 'obv', 'depth'] as const);

type DataPoint = {
	id: number;
	symbol: string;
	indicator: string;
	timestamp: number;
	data: string;
	created_at: string;
};

// Helper function to get the current 5-minute timeframe
function getCurrentTimeframe() {
	const now = dayjs();
	const minutes = now.minute();
	const currentTimeframe = Math.floor(minutes / 5) * 5;
	return now.startOf('hour').add(currentTimeframe, 'minute');
}

// Get historical data with optional time range
app.get('/history/:symbol/:indicator', async (c) => {
	const symbol = c.req.param('symbol');
	const indicator = c.req.param('indicator');

	if (!symbolSchema.safeParse(symbol).success || !indicatorSchema.safeParse(indicator).success) {
		return c.json({ error: 'Invalid symbol or indicator' }, 400);
	}

	const limit = Number(c.req.query('limit') ?? '100');
	if (isNaN(limit) || limit < 1 || limit > 1000) {
		return c.json({ error: 'Invalid limit. Must be between 1 and 1000' }, 400);
	}

	// Optional time range filtering
	const from = c.req.query('from');
	const to = c.req.query('to');
	let fromTimestamp: number | undefined;
	let toTimestamp: number | undefined;

	if (from) {
		const fromDate = dayjs(from);
		if (!fromDate.isValid()) {
			return c.json({ error: 'Invalid from date' }, 400);
		}
		fromTimestamp = fromDate.valueOf();
	}

	if (to) {
		const toDate = dayjs(to);
		if (!toDate.isValid()) {
			return c.json({ error: 'Invalid to date' }, 400);
		}
		toTimestamp = toDate.valueOf();
	}

	try {
		let query = 'SELECT * FROM datapoints WHERE symbol = ? AND indicator = ?';
		const params: (string | number)[] = [symbol, indicator];

		if (fromTimestamp) {
			query += ' AND timestamp >= ?';
			params.push(fromTimestamp);
		}

		if (toTimestamp) {
			query += ' AND timestamp <= ?';
			params.push(toTimestamp);
		}

		query += ' ORDER BY timestamp DESC LIMIT ?';
		params.push(limit);

		const stmt = c.env.DB.prepare(query);
		const results = await stmt.bind(...params).all<DataPoint>();

		return c.json({
			symbol,
			indicator,
			data:
				results.results?.map((row) => ({
					timestamp: row.timestamp,
					data: JSON.parse(row.data)
				})) ?? []
		});
	} catch (error) {
		console.error('Error fetching historical data:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// Get latest data for all indicators of a symbol
app.get('/latest/:symbol', async (c) => {
	const symbol = c.req.param('symbol');

	if (!symbolSchema.safeParse(symbol).success) {
		return c.json({ error: 'Invalid symbol' }, 400);
	}

	const date = getCurrentTimeframe();
	const timestamp = date.valueOf();

	try {
		const stmt = c.env.DB.prepare('SELECT * FROM datapoints WHERE symbol = ? AND timestamp = ?');
		const results = await stmt.bind(symbol, timestamp).all<DataPoint>();

		if (!results.results?.length) {
			return c.json({ error: 'No data found' }, 404);
		}

		return c.json({
			symbol,
			timestamp,
			indicators: results.results.reduce(
				(acc, row) => {
					acc[row.indicator] = JSON.parse(row.data);
					return acc;
				},
				{} as Record<string, unknown>
			)
		});
	} catch (error) {
		console.error('Error fetching latest data for all indicators:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// Get historical data for all indicators of a symbol
app.get('/history/:symbol', async (c) => {
	const symbol = c.req.param('symbol');

	if (!symbolSchema.safeParse(symbol).success) {
		return c.json({ error: 'Invalid symbol' }, 400);
	}

	const limit = Number(c.req.query('limit') ?? '100');
	if (isNaN(limit) || limit < 1 || limit > 1000) {
		return c.json({ error: 'Invalid limit. Must be between 1 and 1000' }, 400);
	}

	// Optional time range filtering
	const from = c.req.query('from');
	const to = c.req.query('to');
	let fromTimestamp: number | undefined;
	let toTimestamp: number | undefined;

	if (from) {
		const fromDate = dayjs(from);
		if (!fromDate.isValid()) {
			return c.json({ error: 'Invalid from date' }, 400);
		}
		fromTimestamp = fromDate.valueOf();
	}

	if (to) {
		const toDate = dayjs(to);
		if (!toDate.isValid()) {
			return c.json({ error: 'Invalid to date' }, 400);
		}
		toTimestamp = toDate.valueOf();
	}

	try {
		const query = `
			WITH timestamps AS (
				SELECT DISTINCT timestamp
				FROM datapoints
				WHERE symbol = ?
				${fromTimestamp ? 'AND timestamp >= ?' : ''}
				${toTimestamp ? 'AND timestamp <= ?' : ''}
				ORDER BY timestamp DESC
				LIMIT ?
			)
			SELECT d.*
			FROM datapoints d
			INNER JOIN timestamps t ON d.timestamp = t.timestamp
			WHERE d.symbol = ?
			ORDER BY d.timestamp DESC, d.indicator
		`;

		const params: (string | number)[] = [symbol];
		if (fromTimestamp) params.push(fromTimestamp);
		if (toTimestamp) params.push(toTimestamp);
		params.push(limit, symbol);

		const stmt = c.env.DB.prepare(query);
		const results = await stmt.bind(...params).all<DataPoint>();

		if (!results.results?.length) {
			return c.json({ error: 'No data found' }, 404);
		}

		// Group results by timestamp
		const groupedData = results.results.reduce(
			(acc, row) => {
				const timestamp = row.timestamp;
				if (!acc[timestamp]) {
					acc[timestamp] = {};
				}
				acc[timestamp][row.indicator] = JSON.parse(row.data);
				return acc;
			},
			{} as Record<number, Record<string, unknown>>
		);

		// Convert to array and sort by timestamp
		const data = Object.entries(groupedData)
			.map(([timestamp, indicators]) => ({
				timestamp: Number(timestamp),
				indicators
			}))
			.sort((a, b) => b.timestamp - a.timestamp);

		return c.json({
			symbol,
			data
		});
	} catch (error) {
		console.error('Error fetching historical data for all indicators:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// Get forecast for a symbol
app.get('/forecast/:symbol', async (c) => {
	const symbol = c.req.param('symbol');

	if (!symbolSchema.safeParse(symbol).success) {
		return c.json({ error: 'Invalid symbol' }, 400);
	}

	try {
		const forecast = await makeForecast(c.env, symbol, 12); // Fixed 1-hour forecast (12 * 5min)

		return c.json(forecast);
	} catch (error) {
		console.error('Error making forecast:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

export default app;
