import dayjs from 'dayjs';
import { match } from 'ts-pattern';

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

type NixtlaForecastResponse = {
	timestamp: string[];
	value: number[];
	input_tokens: number;
	output_tokens: number;
	finetune_tokens: number;
	request_id: string;
};

async function fetchDepth(symbol: string, env?: EnvBindings): Promise<Indicators['depth']> {
	if (!env?.BINANCE_API_URL) {
		throw new Error('BINANCE_API_URL environment variable is not set');
	}

	const encodedSymbol = encodeURIComponent(symbol);
	const response = await fetch(`${env.BINANCE_API_URL}/depth/${encodedSymbol}`);

	if (!response.ok) {
		const text = await response.text();
		console.error(`[Binance API Error] Symbol: ${symbol}, Response:`, text);
		throw new Error(`HTTP error! status: ${response.status}`);
	}

	return response.json();
}

async function fetchLiquidationZones(
	symbol: string,
	env?: EnvBindings
): Promise<Indicators['liq_zones']> {
	if (!env?.BINANCE_API_URL) {
		throw new Error('BINANCE_API_URL environment variable is not set');
	}

	const encodedSymbol = encodeURIComponent(symbol);
	const response = await fetch(`${env.BINANCE_API_URL}/liquidation-zones/${encodedSymbol}`);

	if (!response.ok) {
		const text = await response.text();
		console.error(`[Binance API Error] Symbol: ${symbol}, Response:`, text);
		throw new Error(`HTTP error! status: ${response.status}`);
	}

	return response.json();
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
	symbol: string,
	limit: number = 50
): Promise<{
	timestamps: string[];
	y: Record<string, number>;
	x: Record<string, number[]>;
}> {
	const query = `
		WITH timestamps AS (
			SELECT DISTINCT timestamp
			FROM datapoints
			WHERE symbol = ? AND indicator = 'candle'
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
	const results = await stmt.bind(symbol, limit, symbol).all<{
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

	// Initialize arrays for all indicators
	const x: Record<string, number[]> = {
		high: [],
		low: [],
		close: [],
		volume: [],
		vwap: [],
		atr: [],
		bbands_upper: [],
		bbands_middle: [],
		bbands_lower: [],
		rsi: [],
		obv: [],
		bid_size: [],
		ask_size: [],
		bid_levels: [],
		ask_levels: [],
		long_size: [],
		short_size: [],
		long_accounts: [],
		short_accounts: [],
		avg_long_price: [],
		avg_short_price: []
	};

	// Filter timestamps to only include those with complete data
	const completeTimestamps = Array.from(groupedData.keys())
		.filter((ts) => {
			const data = groupedData.get(ts)!;
			// Check for required indicators
			if (
				!(
					data.candle &&
					data.vwap &&
					data.atr &&
					data.bbands &&
					data.rsi &&
					data.obv &&
					data.depth &&
					data.liq_zones
				)
			) {
				return false;
			}

			// Check for NaN values in all fields
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

			return values.every((v) => !isNaN(v) && v !== null && v !== undefined);
		})
		.sort((a, b) => a - b);

	console.log(
		`Found ${completeTimestamps.length} valid timestamps out of ${groupedData.size} total`
	);

	// Convert to Nixtla format
	const timestamps = completeTimestamps.map((ts) => dayjs(ts).format('YYYY-MM-DD HH:mm:ss'));
	const y: Record<string, number> = {};

	// Collect data only from complete timestamps
	timestamps.forEach((ts, i) => {
		const data = groupedData.get(completeTimestamps[i])!;

		// Target variable (y)
		y[ts] = data.candle.open;

		// Exogenous variables (x)
		x.high.push(data.candle.high);
		x.low.push(data.candle.low);
		x.close.push(data.candle.close);
		x.volume.push(data.candle.volume);
		x.vwap.push(data.vwap.value);
		x.atr.push(data.atr.value);
		x.bbands_upper.push(data.bbands.valueUpperBand);
		x.bbands_middle.push(data.bbands.valueMiddleBand);
		x.bbands_lower.push(data.bbands.valueLowerBand);
		x.rsi.push(data.rsi.value);
		x.obv.push(data.obv.value);
		x.bid_size.push(data.depth.bid_size);
		x.ask_size.push(data.depth.ask_size);
		x.bid_levels.push(data.depth.bid_levels);
		x.ask_levels.push(data.depth.ask_levels);
		x.long_size.push(data.liq_zones.long_size);
		x.short_size.push(data.liq_zones.short_size);
		x.long_accounts.push(data.liq_zones.long_accounts);
		x.short_accounts.push(data.liq_zones.short_accounts);
		x.avg_long_price.push(data.liq_zones.avg_long_price);
		x.avg_short_price.push(data.liq_zones.avg_short_price);
	});

	// Verify all arrays have the same length
	const targetLength = timestamps.length;
	Object.entries(x).forEach(([key, values]) => {
		if (values.length !== targetLength) {
			console.error(`Array length mismatch for ${key}: ${values.length}/${targetLength}`);
			throw new Error('Data integrity error: array length mismatch');
		}
	});

	return { timestamps, y, x };
}

export async function makeForecast(
	env: EnvBindings,
	symbol: string,
	fh: number = 12 // 1 hour by default (12 * 5min)
): Promise<NixtlaForecastResponse> {
	// Get historical data
	const { y, x } = await fetchHistoricalData(env.DB, symbol);

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
			fh,
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

	return response.json();
}

export async function fetchTaapiIndicators(symbol: string, env: EnvBindings) {
	const now = dayjs();
	const minutes = now.minute();
	const currentTimeframe = Math.floor(minutes / 5) * 5;
	const date = now.startOf('hour').add(currentTimeframe, 'minute');
	const timestamp = date.valueOf();

	console.log('[date]', date.format('YYYY-MM-DD HH:mm'));

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
}
