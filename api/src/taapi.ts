import dayjs from 'dayjs';
import { match } from 'ts-pattern';

import { getCurrentTimeframe } from './datapoints';
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

async function fetchHistoricalData(
	db: D1Database,
	symbol: string
): Promise<{
	timestamps: string[];
	y: Record<string, number>;
	x: Record<string, number[]>;
}> {
	// Use 288 datapoints = last 24 hours of 5min intervals
	const HISTORY_LIMIT = 288;

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
				data.depth.ask_size,
				data.depth.bid_levels,
				data.depth.ask_levels,
				data.liq_zones.long_size,
				data.liq_zones.short_size,
				data.liq_zones.long_accounts,
				data.liq_zones.short_accounts,
				data.liq_zones.avg_long_price,
				data.liq_zones.avg_short_price
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

	// Collect data only from complete timestamps
	timestamps.forEach((ts, i) => {
		const data = groupedData.get(completeTimestamps[i])!;

		// Target variable (y)
		y[ts] = data.candle.close;

		// Exogenous variables (x)
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
			data.obv.value,
			data.depth.bid_size,
			data.depth.ask_size,
			data.depth.bid_levels,
			data.depth.ask_levels,
			data.liq_zones.long_size,
			data.liq_zones.short_size,
			data.liq_zones.long_accounts,
			data.liq_zones.short_accounts,
			data.liq_zones.avg_long_price,
			data.liq_zones.avg_short_price
		];
	});

	return { timestamps, y, x };
}

export async function makeForecast(
	env: EnvBindings,
	symbol: string
): Promise<NixtlaForecastResponse> {
	// Get historical data
	const { timestamps, y, x } = await fetchHistoricalData(env.DB, symbol);

	const currentTimeframe = getCurrentTimeframe();
	const cacheKey = `forecast:${symbol}`;
	const lastForecastKey = `last_forecast:${symbol}`;

	// Check if the latest timestamp matches the current timeframe
	if (timestamps[timestamps.length - 1] !== currentTimeframe.format('YYYY-MM-DD HH:mm:ss')) {
		console.log(`Data fetch is still pending for ${symbol}, returning last forecast`);
		const lastForecast = await env.KV.get<NixtlaForecastResponse>(lastForecastKey, 'json');
		if (lastForecast) {
			return lastForecast;
		}
		throw new Error('No recent forecast available');
	}

	// Make forecast request
	const response = await fetch('https://api.nixtla.io/forecast', {
		method: 'POST',
		headers: {
			accept: 'application/json',
			'content-type': 'application/json',
			Authorization: `Bearer ${env.NIXTLA_API_KEY}`
		},
		body: JSON.stringify({
			model: 'timegpt-1',
			freq: '5min',
			fh: 24,
			y,
			x,
			clean_ex_first: true
		})
	});

	if (!response.ok) {
		const text = await response.text();
		console.error('[Nixtla API Error]', text);
		throw new Error(`Nixtla API error: ${response.status}`);
	}

	const forecast = (await response.json()) as NixtlaForecastResponse;

	// Store both the current cache and last successful forecast
	const kvPromises = [
		env.KV.put(cacheKey, JSON.stringify(forecast), {
			// Set TTL to expire at the end of current 5min interval
			expirationTtl: Math.ceil((currentTimeframe.add(5, 'minute').valueOf() - Date.now()) / 1000)
		}),
		// Store last successful forecast with longer TTL (24 hours)
		env.KV.put(lastForecastKey, JSON.stringify(forecast), {
			expirationTtl: 24 * 60 * 60
		})
	];

	// Store each forecasted value separately for historical tracking
	forecast.timestamp.forEach((ts, index) => {
		const forecastedTime = dayjs(ts);
		const formattedTimestamp = forecastedTime.format('YYYY-MM-DD HH:mm');
		const periodAhead = index + 1; // 1-based index for readability
		const historicKey = `forecast:${symbol}:${formattedTimestamp}#${periodAhead}`;

		// Calculate TTL as the time until this forecast's timestamp plus 5 minutes
		const ttlSeconds = Math.ceil((forecastedTime.add(5, 'minute').valueOf() - Date.now()) / 1000);

		kvPromises.push(
			env.KV.put(historicKey, JSON.stringify(forecast.value[index]), {
				// Keep forecast until 5 minutes after its predicted time
				expirationTtl: ttlSeconds
			})
		);
	});

	await Promise.all(kvPromises);

	console.log(`[${symbol}]`, '[forecast] Success:', forecast);
	return forecast;
}

async function checkForecastAccuracy(
	env: EnvBindings,
	symbol: string,
	actualClose: number,
	timestamp: string
) {
	// List all forecasts for this timestamp
	const forecastList = await env.KV.list({ prefix: `forecast:${symbol}:${timestamp}#` });

	if (!forecastList.keys.length) {
		console.log(`[${symbol}] [accuracy] No forecasts found for ${timestamp}`);
		return;
	}

	console.log(
		`[${symbol}] [accuracy] Checking ${forecastList.keys.length} forecasts for ${timestamp}`
	);
	console.log(`[${symbol}] [accuracy] Actual close: ${actualClose}`);

	// Arrays to store errors for aggregate metrics
	const errors: number[] = [];
	const absErrors: number[] = [];
	const percentErrors: number[] = [];
	const predictions: number[] = [];

	// Sort keys by period number
	const sortedKeys = forecastList.keys.sort((a, b) => {
		const periodA = parseInt(a.name.split('#')[1]);
		const periodB = parseInt(b.name.split('#')[1]);
		return periodA - periodB;
	});

	// Process each forecast
	for (const key of sortedKeys) {
		const periodAhead = parseInt(key.name.split('#')[1]);
		const forecastValue = await env.KV.get<number>(key.name, 'json');

		if (forecastValue !== null) {
			const error = forecastValue - actualClose;
			const absError = Math.abs(error);
			const percentError = (error / actualClose) * 100;

			errors.push(error);
			absErrors.push(absError);
			percentErrors.push(Math.abs(percentError)); // Use absolute values for MAPE
			predictions.push(forecastValue);

			console.log(
				`[${symbol}] [accuracy] ${periodAhead} periods ahead:`,
				`predicted=${forecastValue}`,
				`error=${percentError.toFixed(4)}%`
			);
		}
	}

	if (errors.length > 0) {
		// Calculate MAE (Mean Absolute Error)
		const mae = absErrors.reduce((a, b) => a + b, 0) / absErrors.length;

		// Calculate MAPE (Mean Absolute Percentage Error)
		const mape = percentErrors.reduce((a, b) => a + b, 0) / percentErrors.length;

		// Calculate R² Score
		const meanActual = actualClose;
		const ssRes = errors.reduce((a, b) => a + b * b, 0); // Sum of squares of residuals
		const ssTot = predictions.reduce((a, b) => a + Math.pow(b - meanActual, 2), 0); // Total sum of squares
		const rSquared = 1 - ssRes / ssTot;

		console.log(`[${symbol}] [accuracy] Aggregate Metrics:`);
		console.log(`[${symbol}] [accuracy] MAE: ${mae.toFixed(4)} (absolute error in price)`);
		console.log(`[${symbol}] [accuracy] MAPE: ${mape.toFixed(4)}%`);
		console.log(`[${symbol}] [accuracy] R² Score: ${rSquared.toFixed(4)}`);
	}
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
		console.log(`[${symbol}]`, '[forecast] Making forecast...');
		await makeForecast(env, symbol);
	} catch (error) {
		console.error('Error making forecast:', error);
		throw error;
	}
}
