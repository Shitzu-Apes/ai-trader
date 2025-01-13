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

type BinanceOrderbookResponse = {
	lastUpdateId: number;
	bids: [string, string][]; // [price, quantity][]
	asks: [string, string][]; // [price, quantity][]
};

type BinanceOpenInterestResponse = {
	symbol: string;
	sumOpenInterest: string;
	sumOpenInterestValue: string;
	timestamp: number;
};

type BinanceFundingRateResponse = {
	symbol: string;
	markPrice: string;
	lastFundingRate: string;
	nextFundingTime: number;
	timestamp: number;
};

type NixtlaForecastResponse = {
	timestamp: string[];
	value: number[];
	input_tokens: number;
	output_tokens: number;
	finetune_tokens: number;
	request_id: string;
};

async function fetchDepth(symbol: string): Promise<Indicators['depth']> {
	// Binance uses different symbol format (no slash)
	const binanceSymbol = symbol.replace('/', '');

	// Use deeper orderbook for BTC and ETH
	const limit = symbol.startsWith('BTC/') || symbol.startsWith('ETH/') ? 5000 : 500;

	const response = await fetch(
		`https://api.binance.com/api/v3/depth?symbol=${binanceSymbol}&limit=${limit}`,
		{
			headers: {
				'User-Agent':
					'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
				Accept: 'application/json',
				'Accept-Encoding': 'gzip, deflate, br',
				'Accept-Language': 'en-US,en;q=0.9'
			}
		}
	);

	// Log raw response if not JSON
	const text = await response.text();
	try {
		const data = JSON.parse(text) as BinanceOrderbookResponse;

		// Convert string values to numbers and sort by price
		const bids = data.bids
			.map(([price, size]) => ({ price: Number(price), size: Number(size) }))
			.sort((a, b) => b.price - a.price); // Sort bids descending

		const asks = data.asks
			.map(([price, size]) => ({ price: Number(price), size: Number(size) }))
			.sort((a, b) => a.price - b.price); // Sort asks ascending

		const bestBid = bids[0].price;
		const bestAsk = asks[0].price;

		// Calculate thresholds (1%)
		const bidThreshold = bestBid * 0.99;
		const askThreshold = bestAsk * 1.01;

		// Calculate depths within 1%
		const bidSize = bids
			.filter((bid) => bid.price >= bidThreshold)
			.reduce((sum, bid) => sum + bid.size, 0);
		const askSize = asks
			.filter((ask) => ask.price <= askThreshold)
			.reduce((sum, ask) => sum + ask.size, 0);

		// Count price levels within 1%
		const bidLevels = bids.filter((bid) => bid.price >= bidThreshold).length;
		const askLevels = asks.filter((ask) => ask.price <= askThreshold).length;

		return {
			bid_size: bidSize,
			ask_size: askSize,
			bid_levels: bidLevels,
			ask_levels: askLevels
		};
	} catch (error) {
		console.error(`[Binance Depth API Error] Symbol: ${symbol}, Response:`, text);
		throw error;
	}
}

async function fetchLiquidationZones(symbol: string): Promise<Indicators['liq_zones']> {
	// Binance uses different symbol format (no slash)
	const binanceSymbol = symbol.replace('/', '');

	// Get current mark price
	const priceResponse = await fetch(
		`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${binanceSymbol}`,
		{
			headers: {
				'User-Agent':
					'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
				Accept: 'application/json',
				'Accept-Encoding': 'gzip, deflate, br',
				'Accept-Language': 'en-US,en;q=0.9'
			}
		}
	);
	const priceText = await priceResponse.text();
	let priceData: BinanceFundingRateResponse;
	try {
		priceData = JSON.parse(priceText) as BinanceFundingRateResponse;
	} catch (error) {
		console.error(`[Binance Premium Index API Error] Symbol: ${symbol}, Response:`, priceText);
		throw error;
	}
	const currentPrice = Number(priceData.markPrice);

	// Get open interest
	const response = await fetch(
		`https://fapi.binance.com/futures/data/openInterestHist?symbol=${binanceSymbol}&period=5m&limit=1`,
		{
			headers: {
				'User-Agent':
					'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
				Accept: 'application/json',
				'Accept-Encoding': 'gzip, deflate, br',
				'Accept-Language': 'en-US,en;q=0.9'
			}
		}
	);
	const text = await response.text();
	let data: BinanceOpenInterestResponse[];
	try {
		data = JSON.parse(text) as BinanceOpenInterestResponse[];
	} catch (error) {
		console.error(`[Binance Open Interest API Error] Symbol: ${symbol}, Response:`, text);
		throw error;
	}
	const latest = data[0];

	// Assuming average leverage of 20x for estimation
	const avgLeverage = 20;
	const riskThreshold = 0.05; // 5% from liquidation price

	// Calculate liquidation prices
	const longLiqPrice = currentPrice * (1 - 1 / avgLeverage);
	const longAtRiskPrice = longLiqPrice * (1 + riskThreshold);
	const shortLiqPrice = currentPrice * (1 + 1 / avgLeverage);
	const shortAtRiskPrice = shortLiqPrice * (1 - riskThreshold);

	// Calculate risk ratios
	const longRiskRatio =
		currentPrice <= longAtRiskPrice
			? Math.max(
					0,
					Math.min(1, (longAtRiskPrice - currentPrice) / (longAtRiskPrice - longLiqPrice))
				)
			: 0;

	const shortRiskRatio =
		currentPrice >= shortAtRiskPrice
			? Math.max(
					0,
					Math.min(1, (currentPrice - shortAtRiskPrice) / (shortLiqPrice - shortAtRiskPrice))
				)
			: 0;

	// Parse total open interest and split it based on risk ratios
	const totalOpenInterest = Number(latest.sumOpenInterest);

	// Assume 50/50 split between longs and shorts when we don't have detailed data
	const estimatedLongOpenInterest = totalOpenInterest * 0.5;
	const estimatedShortOpenInterest = totalOpenInterest * 0.5;

	// Calculate final values
	const longSize = estimatedLongOpenInterest * longRiskRatio;
	const shortSize = estimatedShortOpenInterest * shortRiskRatio;

	// Estimate number of accounts based on average position size
	const avgPositionSize = 100; // Assume average position is 100 units
	const longAccounts = Math.round(longSize / avgPositionSize);
	const shortAccounts = Math.round(shortSize / avgPositionSize);

	return {
		long_size: longSize,
		short_size: shortSize,
		long_accounts: longAccounts,
		short_accounts: shortAccounts,
		avg_long_price: longLiqPrice,
		avg_short_price: shortLiqPrice
	};
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
		const depth = await fetchDepth(symbol);
		console.log(`[${symbol}]`, '[depth]', depth);
		await storeDatapoint(env.DB, symbol, 'depth', timestamp, depth);
	} catch (error) {
		console.error('Error fetching depth:', error);
	}

	// Fetch liquidation zones
	try {
		const liqZones = await fetchLiquidationZones(symbol);
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
