import dayjs from 'dayjs';
import { Hono } from 'hono';
import { z } from 'zod';

import { NixtlaForecastResponse } from './forecast';
import { Position } from './trading';
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
export function getCurrentTimeframe() {
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
		// Try to get the most recent forecast from cache
		const cacheKey = `forecast:${symbol}`;
		const lastForecastKey = `last_forecast:${symbol}`;

		const cached = await c.env.KV.get<NixtlaForecastResponse>(cacheKey, 'json');
		if (cached) {
			console.log(`Cache hit for ${cacheKey}`);
			return c.json(cached);
		}

		// If no cached forecast, try to get the last successful forecast
		const lastForecast = await c.env.KV.get<NixtlaForecastResponse>(lastForecastKey, 'json');
		if (lastForecast) {
			console.log(`Using last available forecast for ${symbol}`);
			return c.json(lastForecast);
		}

		return c.json({ error: 'No forecast data available yet' }, 404);
	} catch (error) {
		console.error('Error getting forecast:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// Get current USDC balance
app.get('/balance', async (c) => {
	try {
		const balance = await c.env.KV.get<number>('balance:USDC', 'json');
		return c.json({
			balance: balance ?? 1000,
			currency: 'USDC'
		});
	} catch (error) {
		console.error('Error getting balance:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// Get current position for a symbol
app.get('/position/:symbol', async (c) => {
	const symbol = c.req.param('symbol');

	if (!symbolSchema.safeParse(symbol).success) {
		return c.json({ error: 'Invalid symbol' }, 400);
	}

	try {
		const position = await c.env.KV.get<Position>(`position:${symbol}`, 'json');
		if (!position) {
			return c.json({ error: 'No active position' }, 404);
		}
		return c.json(position);
	} catch (error) {
		console.error('Error getting position:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// Get trading stats for a symbol
app.get('/stats/:symbol', async (c) => {
	const symbol = c.req.param('symbol');

	if (!symbolSchema.safeParse(symbol).success) {
		return c.json({ error: 'Invalid symbol' }, 400);
	}

	try {
		const stats = await c.env.KV.get<{
			cumulativePnl: number;
			successfulTrades: number;
			totalTrades: number;
		}>(`stats:${symbol}`, 'json');

		if (!stats) {
			return c.json({
				cumulativePnl: 0,
				successfulTrades: 0,
				totalTrades: 0,
				winRate: 0
			});
		}

		return c.json({
			...stats,
			winRate: stats.totalTrades > 0 ? stats.successfulTrades / stats.totalTrades : 0
		});
	} catch (error) {
		console.error('Error getting stats:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// Get all positions and stats
app.get('/portfolio', async (c) => {
	try {
		// Get current balance
		const balance = (await c.env.KV.get<number>('balance:USDC', 'json')) ?? 1000;

		// Get all positions
		const positions: Record<string, Position> = {};
		const stats: Record<
			string,
			{
				cumulativePnl: number;
				successfulTrades: number;
				totalTrades: number;
				winRate: number;
			}
		> = {};

		// Process each supported symbol
		for (const symbol of symbolSchema.options) {
			const position = await c.env.KV.get<Position>(`position:${symbol}`, 'json');
			if (position) {
				positions[symbol] = position;
			}

			const symbolStats = await c.env.KV.get<{
				cumulativePnl: number;
				successfulTrades: number;
				totalTrades: number;
			}>(`stats:${symbol}`, 'json');

			if (symbolStats) {
				stats[symbol] = {
					...symbolStats,
					winRate:
						symbolStats.totalTrades > 0 ? symbolStats.successfulTrades / symbolStats.totalTrades : 0
				};
			} else {
				stats[symbol] = {
					cumulativePnl: 0,
					successfulTrades: 0,
					totalTrades: 0,
					winRate: 0
				};
			}
		}

		return c.json({
			balance,
			positions,
			stats
		});
	} catch (error) {
		console.error('Error getting portfolio:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// Delete all positions and reset balance (for testing)
app.post('/reset', async (c) => {
	try {
		// Delete all positions and stats
		for (const symbol of symbolSchema.options) {
			await c.env.KV.delete(`position:${symbol}`);
			await c.env.KV.delete(`stats:${symbol}`);
		}

		// Reset balance to initial value
		await c.env.KV.put('balance:USDC', JSON.stringify(1000));

		return c.json({
			message: 'All positions deleted and balance reset',
			initialBalance: 1000
		});
	} catch (error) {
		console.error('Error resetting positions:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

export default app;
