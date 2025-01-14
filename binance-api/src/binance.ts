import type {
	BinanceOrderbookResponse,
	BinanceFundingRateResponse,
	BinanceOpenInterestResponse,
	DepthResponse,
	LiquidationZonesResponse
} from './types';

const headers = {
	'User-Agent':
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
	Accept: 'application/json',
	'Accept-Encoding': 'gzip, deflate, br',
	'Accept-Language': 'en-US,en;q=0.9'
};

export async function fetchDepth(symbol: string): Promise<DepthResponse> {
	const binanceSymbol = symbol.replace('/', '');
	const limit = symbol.startsWith('BTC/') || symbol.startsWith('ETH/') ? 5000 : 500;

	const response = await fetch(
		`https://api.binance.com/api/v3/depth?symbol=${binanceSymbol}&limit=${limit}`,
		{ headers }
	);

	if (!response.ok) {
		throw new Error(`HTTP error: [${response.status}] ${await response.text()}`);
	}

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

export async function fetchLiquidationZones(symbol: string): Promise<LiquidationZonesResponse> {
	const binanceSymbol = symbol.replace('/', '');

	const priceResponse = await fetch(
		`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${binanceSymbol}`,
		{ headers }
	);

	if (!priceResponse.ok) {
		throw new Error(`HTTP error: [${priceResponse.status}] ${await priceResponse.text()}`);
	}

	const priceData = (await priceResponse.json()) as BinanceFundingRateResponse;
	const currentPrice = Number(priceData.markPrice);

	const response = await fetch(
		`https://fapi.binance.com/futures/data/openInterestHist?symbol=${binanceSymbol}&period=5m&limit=1`,
		{ headers }
	);

	if (!response.ok) {
		throw new Error(`HTTP error: [${response.status}] ${await response.text()}`);
	}

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
