import dayjs from 'dayjs';
import { match } from 'ts-pattern';

import { getCurrentTimeframe } from './datapoints';
import { checkForecastAccuracy, makeForecast } from './forecast';
import { analyzeForecast } from './trading';
import { EnvBindings } from './types';

export type Indicators = {
	candle: {
		open: number;
		high: number;
		low: number;
		close: number;
		volume: number;
	};
	vwap: {
		value: number;
	};
	atr: {
		value: number;
	};
	bbands: {
		valueUpperBand: number;
		valueMiddleBand: number;
		valueLowerBand: number;
	};
	rsi: {
		value: number;
	};
	obv: {
		value: number;
	};
	depth: {
		bid_size: number;
		ask_size: number;
		bid_levels: number;
		ask_levels: number;
	};
	liq_zones: {
		long_size: number;
		short_size: number;
		long_accounts: number;
		short_accounts: number;
		avg_long_price: number;
		avg_short_price: number;
	};
};

type BulkResponseItem<T> = {
	id: string;
	result: T;
	errors: string[];
};

type BulkResponse = {
	data: (
		| BulkResponseItem<Indicators['candle']>
		| BulkResponseItem<Indicators['vwap']>
		| BulkResponseItem<Indicators['atr']>
		| BulkResponseItem<Indicators['bbands']>
		| BulkResponseItem<Indicators['rsi']>
		| BulkResponseItem<Indicators['obv']>
	)[];
};

export type NixtlaForecastResponse = {
	timestamp: string[];
	value: number[];
	input_tokens: number;
	output_tokens: number;
	finetune_tokens: number;
	request_id: string;
};

async function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry<T>(
	url: string,
	maxRetries: number = 3,
	baseDelay: number = 1000
): Promise<T> {
	let lastError: Error | null = null;

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			const response = await fetch(url);
			if (!response.ok) {
				const text = await response.text();
				throw new Error(`HTTP error: [${response.status}] ${text}`);
			}
			return response.json();
		} catch (error) {
			lastError = error as Error;
			console.error(`Attempt ${attempt + 1}/${maxRetries} failed:`, error);

			if (attempt < maxRetries - 1) {
				const delay = baseDelay * (attempt + 1); // Linear backoff
				console.log(`Retrying in ${delay}ms...`);
				await sleep(delay);
			}
		}
	}

	throw lastError ?? new Error('All retry attempts failed');
}

async function fetchDepth(symbol: string, env?: EnvBindings): Promise<Indicators['depth']> {
	if (!env?.BINANCE_API_URL) {
		throw new Error('BINANCE_API_URL environment variable is not set');
	}

	const encodedSymbol = encodeURIComponent(symbol);
	return fetchWithRetry(`${env.BINANCE_API_URL}/depth/${encodedSymbol}`);
}

async function fetchLiquidationZones(
	symbol: string,
	env?: EnvBindings
): Promise<Indicators['liq_zones']> {
	if (!env?.BINANCE_API_URL) {
		throw new Error('BINANCE_API_URL environment variable is not set');
	}

	const encodedSymbol = encodeURIComponent(symbol);
	return fetchWithRetry(`${env.BINANCE_API_URL}/liquidation-zones/${encodedSymbol}`);
}

async function storeDatapoint(
	db: D1Database,
	symbol: string,
	indicator: string,
	timestamp: number,
	data: unknown
) {
	const stmt = db.prepare(
		'INSERT OR REPLACE INTO datapoints (symbol, indicator, timestamp, data) VALUES (?, ?, ?, ?)'
	);
	await stmt.bind(symbol, indicator, timestamp, JSON.stringify(data)).run();
}

export async function fetchHistoricalData(db: D1Database, symbol: string) {
	const HISTORY_LIMIT = 12 * 24 * 7; // 7 days * 24 hours * 12 intervals per hour

	// Get the current 5min interval using the helper function
	const currentTimeframe = getCurrentTimeframe();

	const query = `
		WITH timestamps AS (
			SELECT DISTINCT timestamp
			FROM datapoints
			WHERE symbol = ? 
			AND indicator = 'candle'
			AND timestamp <= ?
			ORDER BY timestamp DESC
			LIMIT ?
		)
		SELECT d.*
		FROM datapoints d
		INNER JOIN timestamps t ON d.timestamp = t.timestamp
		WHERE d.symbol = ?
		ORDER BY d.timestamp ASC, d.indicator
	`;

	const stmt = db.prepare(query);
	const results = await stmt.bind(symbol, currentTimeframe.valueOf(), HISTORY_LIMIT, symbol).all<{
		indicator: string;
		timestamp: number;
		data: string;
	}>();

	if (!results.results?.length) {
		throw new Error('No historical data found');
	}

	// Group data by timestamp
	const groupedData = new Map<number, Record<string, Record<string, number>>>();
	results.results.forEach((row) => {
		if (!groupedData.has(row.timestamp)) {
			groupedData.set(row.timestamp, {});
		}
		groupedData.get(row.timestamp)![row.indicator] = JSON.parse(row.data);
	});

	// Filter timestamps to only include those with complete data
	const completeTimestamps = Array.from(groupedData.keys())
		.filter((ts) => {
			const data = groupedData.get(ts)!;

			// Check for required indicators
			const requiredIndicators = [
				'candle',
				'vwap',
				'atr',
				'bbands',
				'rsi',
				'obv',
				'depth',
				'liq_zones'
			];
			const hasAllIndicators = requiredIndicators.every((indicator) => data[indicator]);
			if (!hasAllIndicators) {
				return false;
			}

			// Extract all values that will be used
			const values = [
				data.candle.open,
				data.candle.high,
				data.candle.low,
				data.candle.close,
				data.candle.volume,
				data.vwap.value,
				data.atr.value,
				data.bbands.valueUpperBand,
				data.bbands.valueMiddleBand,
				data.bbands.valueLowerBand,
				data.rsi.value,
				data.obv.value,
				data.depth.bid_size,
				data.depth.ask_size
			];

			// Check for any invalid values
			const hasInvalidValue = values.some((v) => {
				const isInvalid = v === null || v === undefined || isNaN(v) || !isFinite(v);
				return isInvalid;
			});

			return !hasInvalidValue;
		})
		.sort((a, b) => a - b);

	if (completeTimestamps.length === 0) {
		throw new Error('No complete data found for any timestamp');
	}

	// Convert to Nixtla format
	const timestamps = completeTimestamps.map((ts) => dayjs(ts).format('YYYY-MM-DD HH:mm:ss'));
	const y: Record<string, number> = {};
	const x: Record<string, number[]> = {};
	const prices: number[] = [];
	const obvs: number[] = [];

	// Collect data only from complete timestamps
	let lastObv = 0;
	let vwap = 0;
	let bbandsUpper = 0;
	let bbandsLower = 0;
	let rsi = 0;
	let obvDelta = 0;
	timestamps.forEach((ts, i) => {
		const data = groupedData.get(completeTimestamps[i])!;

		// Target variable (y)
		y[ts] = data.candle.close;

		// Store price and OBV data for divergence analysis
		prices.push(data.candle.close);
		obvs.push(data.obv.value);

		// Exogenous variables (x)
		vwap = data.vwap.value;
		bbandsUpper = data.bbands.valueUpperBand;
		bbandsLower = data.bbands.valueLowerBand;
		rsi = data.rsi.value;
		obvDelta = data.obv.value - lastObv;
		x[ts] = [
			data.candle.open,
			data.candle.high,
			data.candle.low,
			data.candle.volume,
			data.vwap.value,
			data.atr.value,
			data.bbands.valueUpperBand,
			data.bbands.valueMiddleBand,
			data.bbands.valueLowerBand,
			data.rsi.value,
			obvDelta,
			data.depth.bid_size,
			data.depth.ask_size
		];
		lastObv = data.obv.value;
	});

	return { timestamps, y, x, vwap, bbandsUpper, bbandsLower, rsi, prices, obvs };
}

export async function fetchTaapiIndicators(symbol: string, env: EnvBindings) {
	const now = dayjs();
	const minutes = now.minute();
	const currentTimeframe = Math.floor(minutes / 5) * 5;
	const date = now.startOf('hour').add(currentTimeframe, 'minute');
	const timestamp = date.valueOf();
	const formattedTimestamp = date.format('YYYY-MM-DD HH:mm');

	console.log('[date]', formattedTimestamp);

	// Fetch depth
	try {
		const depth = await fetchDepth(symbol, env);
		console.log(`[${symbol}]`, '[depth]', depth);
		await storeDatapoint(env.DB, symbol, 'depth', timestamp, depth);
	} catch (error) {
		console.error('Error fetching depth:', error);
	}

	// Fetch liquidation zones
	try {
		const liqZones = await fetchLiquidationZones(symbol, env);
		console.log(`[${symbol}]`, '[liq_zones]', liqZones);
		await storeDatapoint(env.DB, symbol, 'liq_zones', timestamp, liqZones);
	} catch (error) {
		console.error('Error fetching liquidation zones:', error);
	}

	// Fetch other indicators
	const response = await fetch('https://api.taapi.io/bulk', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			secret: env.TAAPI_SECRET,
			construct: {
				exchange: 'binance',
				symbol,
				interval: '5m',
				indicators: [
					{ id: 'candle', indicator: 'candle' },
					{ id: 'vwap', indicator: 'vwap' },
					{ id: 'atr', indicator: 'atr' },
					{ id: 'bbands', indicator: 'bbands' },
					{ id: 'rsi', indicator: 'rsi' },
					{ id: 'obv', indicator: 'obv' }
				]
			}
		})
	});

	const { data: bulkData } = (await response.json()) as BulkResponse;

	await Promise.all(
		bulkData.map(async (item) => {
			match(item.id)
				.with('candle', () => {
					console.log(`[${symbol}]`, '[candle]', item.result);
					// Check forecast accuracy with the actual close price
					try {
						checkForecastAccuracy(
							env,
							symbol,
							(item.result as Indicators['candle']).close,
							formattedTimestamp
						);
					} catch (error) {
						console.error(`[${symbol}] [accuracy] Error checking forecast accuracy:`, error);
					}
					return storeDatapoint(env.DB, symbol, item.id, timestamp, item.result);
				})
				.with('vwap', () => {
					console.log(`[${symbol}]`, '[vwap]', item.result);
					return storeDatapoint(env.DB, symbol, item.id, timestamp, item.result);
				})
				.with('atr', () => {
					console.log(`[${symbol}]`, '[atr]', item.result);
					return storeDatapoint(env.DB, symbol, item.id, timestamp, item.result);
				})
				.with('bbands', () => {
					console.log(`[${symbol}]`, '[bbands]', item.result);
					return storeDatapoint(env.DB, symbol, item.id, timestamp, item.result);
				})
				.with('rsi', () => {
					console.log(`[${symbol}]`, '[rsi]', item.result);
					return storeDatapoint(env.DB, symbol, item.id, timestamp, item.result);
				})
				.with('obv', () => {
					console.log(`[${symbol}]`, '[obv]', item.result);
					return storeDatapoint(env.DB, symbol, item.id, timestamp, item.result);
				})
				.otherwise(() => {
					console.log(`Unknown indicator: ${item.id}`);
				});
		})
	);

	// Make forecast after all indicators are fetched and stored
	try {
		await new Promise((resolve) => setTimeout(resolve, 10_000));
		const { forecast, vwap, bbandsUpper, bbandsLower, rsi, prices, obvs } = await makeForecast(
			env,
			symbol
		);

		// Get current price from candle data
		const candleData = bulkData.find((d) => d.id === 'candle');
		if (!candleData) {
			throw new Error('Could not find candle data');
		}
		const currentPrice = (candleData.result as Indicators['candle']).close;
		if (!currentPrice) {
			throw new Error('Could not get current price from candle data');
		}

		// Analyze forecast and potentially open/close positions
		await analyzeForecast(
			env,
			symbol,
			currentPrice,
			forecast,
			vwap,
			bbandsUpper,
			bbandsLower,
			rsi,
			prices,
			obvs
		);
	} catch (error) {
		console.error('Error making forecast:', error);
		throw error;
	}
}
