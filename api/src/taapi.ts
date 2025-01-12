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

async function fetchDepth(symbol: string): Promise<Indicators['depth']> {
	// Binance uses different symbol format (no slash)
	const binanceSymbol = symbol.replace('/', '');

	// Use deeper orderbook for BTC and ETH
	const limit = symbol.startsWith('BTC/') || symbol.startsWith('ETH/') ? 5000 : 500;

	const response = await fetch(
		`https://api.binance.com/api/v3/depth?symbol=${binanceSymbol}&limit=${limit}`
	);
	const data = (await response.json()) as BinanceOrderbookResponse;

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
}

async function fetchLiquidationZones(symbol: string): Promise<Indicators['liq_zones']> {
	// Binance uses different symbol format (no slash)
	const binanceSymbol = symbol.replace('/', '');

	// Get current mark price
	const priceResponse = await fetch(
		`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${binanceSymbol}`
	);
	const priceData = (await priceResponse.json()) as BinanceFundingRateResponse;
	const currentPrice = Number(priceData.markPrice);

	// Get open interest
	const response = await fetch(
		`https://fapi.binance.com/futures/data/openInterestHist?symbol=${binanceSymbol}&period=5m&limit=1`
	);
	const data = (await response.json()) as BinanceOpenInterestResponse[];
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
