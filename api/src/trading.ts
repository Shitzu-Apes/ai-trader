import { FixedNumber } from './FixedNumber';
import { Ref } from './ref';
import { NixtlaForecastResponse } from './taapi';
import { EnvBindings } from './types';

// Symbol info for token addresses
const symbolInfo = {
	'NEAR/USDT': {
		base: 'wrap.near',
		quote: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
		poolId: 5515
	}
} as const;

// Token decimals info
const tokenInfo = {
	'wrap.near': {
		decimals: 24
	},
	'17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': {
		decimals: 6
	}
} as const;

// Trading algorithm configuration
const TRADING_CONFIG = {
	DECAY_ALPHA: 0.92, // Exponential decay factor for new positions
	DECAY_ALPHA_EXISTING: 0.9, // More conservative decay factor for existing positions
	UPPER_THRESHOLD: 0.002, // +0.2% threshold for buying new positions
	LOWER_THRESHOLD: -0.002, // -0.2% threshold for selling new positions
	UPPER_THRESHOLD_EXISTING: 0.0005, // +0.05% threshold when position exists
	LOWER_THRESHOLD_EXISTING: -0.0005, // -0.05% threshold when position exists
	STOP_LOSS_THRESHOLD: -0.02, // -2% stop loss threshold
	TAKE_PROFIT_THRESHOLD: 0.03, // +3% take profit threshold
	INITIAL_BALANCE: 1000, // Initial USDC balance
	OBV_WINDOW_SIZE: 12, // 1 hour window for slope calculation
	SLOPE_THRESHOLD: 0.1, // Minimum slope difference to consider divergence

	// AI score multipliers
	AI_SCORE_MULTIPLIER: 1800, // Multiplier for new positions (1% difference = score of 1)
	AI_SCORE_MULTIPLIER_EXISTING: 1500, // More conservative multiplier for existing positions

	// TA score multipliers
	VWAP_SCORE: 1, // Base score for VWAP signals
	VWAP_EXTRA_SCORE: 1, // Additional score for stronger VWAP signals
	BBANDS_MULTIPLIER: 1.5, // Bollinger Bands score multiplier
	RSI_MULTIPLIER: 2, // RSI score multiplier
	OBV_DIVERGENCE_MULTIPLIER: 2.5, // OBV divergence score multiplier
	PROFIT_SCORE_MULTIPLIER: 1, // Profit-taking score multiplier (per 1% in profit)

	// Score thresholds for trading decisions
	TOTAL_SCORE_BUY_THRESHOLD: 5, // Score above which to buy
	TOTAL_SCORE_SELL_THRESHOLD: -3.5 // Score below which to sell
} as const;

/**
 * Calculate slope using linear regression
 */
function calculateSlope(values: number[], windowSize: number): number {
	if (values.length < windowSize) {
		return 0;
	}

	// Get the last window of values
	const subset = values.slice(-windowSize);

	// Calculate means
	let sumX = 0;
	let sumY = 0;
	for (let i = 0; i < windowSize; i++) {
		sumX += i;
		sumY += subset[i];
	}
	const xMean = sumX / windowSize;
	const yMean = sumY / windowSize;

	// Calculate slope
	let numerator = 0;
	let denominator = 0;
	for (let i = 0; i < windowSize; i++) {
		const dx = i - xMean;
		const dy = subset[i] - yMean;
		numerator += dx * dy;
		denominator += dx * dx;
	}

	return denominator !== 0 ? numerator / denominator : 0;
}

/**
 * Calculate divergence score between price and OBV slopes
 * Returns a score between -1 and 1:
 * - Negative: Bearish divergence (price up, OBV down)
 * - Positive: Bullish divergence (price down, OBV up)
 * - Magnitude indicates strength of divergence
 */
function detectSlopeDivergence(priceSlope: number, obvSlope: number, threshold: number): number {
	// If slopes are too small, no significant divergence
	if (Math.abs(priceSlope) < threshold) {
		return 0;
	}

	// Calculate how strongly the slopes diverge
	const divergenceStrength =
		(priceSlope * -obvSlope) / Math.max(Math.abs(priceSlope), Math.abs(obvSlope));

	// Scale the strength by how much price slope exceeds threshold
	const scaleFactor = Math.min(Math.abs(priceSlope) / threshold, 1);

	return divergenceStrength * scaleFactor;
}

/**
 * Calculate the expected swap outcome
 */
async function calculateSwapOutcome(
	symbol: string,
	amountIn: number,
	isBuy: boolean,
	_env: EnvBindings
): Promise<number> {
	const tokens = symbolInfo[symbol as keyof typeof symbolInfo];
	if (!tokens) {
		throw new Error(`Unsupported symbol: ${symbol}`);
	}

	// For buys: quote -> base (USDT -> NEAR)
	// For sells: base -> quote (NEAR -> USDT)
	const tokenIn = isBuy ? tokens.quote : tokens.base;
	const tokenOut = isBuy ? tokens.base : tokens.quote;
	const decimals = tokenInfo[tokenIn as keyof typeof tokenInfo].decimals;

	// Convert amount to FixedNumber with proper decimals
	const fixedAmount = new FixedNumber(BigInt(Math.floor(amountIn * 10 ** decimals)), decimals);

	// Get expected return from REF
	const expectedReturn = await Ref.getSmartRouterReturn({
		tokenIn,
		amountIn: fixedAmount,
		tokenOut,
		decimals: tokenInfo[tokenOut as keyof typeof tokenInfo].decimals
	});

	return expectedReturn.toNumber();
}

/**
 * Calculate RSI score between -1 and 1
 * - Negative: Oversold (bullish)
 * - Positive: Overbought (bearish)
 * Magnitude increases exponentially as RSI moves towards extremes
 */
function calculateRsiScore(rsi: number): number {
	// Center RSI around 50
	const centered = rsi - 50;

	// Normalize to -1 to 1 range and apply exponential scaling
	// This makes the score change more rapidly at extremes
	return Math.sign(centered) * Math.pow(Math.abs(centered) / 50, 2);
}

/**
 * Calculate Bollinger Bands score between -1.5 and 1.5
 * - Negative: Price near upper band (bearish)
 * - Positive: Price near lower band (bullish)
 * - Zero: Price in the middle
 */
function calculateBBandsScore(currentPrice: number, upperBand: number, lowerBand: number): number {
	const middleBand = (upperBand + lowerBand) / 2;
	const totalRange = upperBand - lowerBand;
	const pricePosition = (currentPrice - middleBand) / (totalRange / 2);
	return -pricePosition * TRADING_CONFIG.BBANDS_MULTIPLIER;
}

/**
 * Calculate profit-taking score
 * Returns a negative score proportional to profit percentage
 * to encourage selling when in profit
 */
function calculateProfitScore(currentPrice: number, entryPrice: number | null): number {
	if (!entryPrice) return 0;
	const priceDiff = (currentPrice - entryPrice) / entryPrice;
	return priceDiff > 0 ? -priceDiff * TRADING_CONFIG.PROFIT_SCORE_MULTIPLIER : 0;
}

/**
 * Calculate VWAP score dynamically based on price difference
 * Returns a score where:
 * - Positive: VWAP above price (bullish)
 * - Negative: VWAP below price (bearish)
 * - Zero: Within 0.5% threshold
 * Score increases by 0.5 for each additional percentage point
 */
function calculateVwapScore(currentPrice: number, vwap: number): number {
	const vwapDiff = (vwap - currentPrice) / currentPrice;
	const threshold = 0.005; // 0.5%

	if (Math.abs(vwapDiff) <= threshold) {
		return 0;
	}

	// Calculate how many additional percentage points above threshold
	const additionalPercentage = Math.abs(vwapDiff) - threshold;
	const score = 0.5 * Math.floor(additionalPercentage / 0.01); // 0.5 per 1%

	return vwapDiff > 0 ? score : -score;
}

/**
 * Calculate signal based on technical indicators
 * Returns a score where:
 * Positive: Bullish
 * Negative: Bearish
 * Magnitude indicates strength
 */
function calculateTaSignal({
	symbol,
	currentPrice,
	vwap,
	bbandsUpper,
	bbandsLower,
	rsi,
	prices,
	obvs,
	entryPrice
}: {
	symbol: string;
	currentPrice: number;
	vwap: number;
	bbandsUpper: number;
	bbandsLower: number;
	rsi: number;
	prices: number[];
	obvs: number[];
	entryPrice: number | null;
}): number {
	let score = 0;

	// Dynamic VWAP score
	const vwapScore = calculateVwapScore(currentPrice, vwap) * TRADING_CONFIG.VWAP_SCORE;
	score += vwapScore;

	// Dynamic Bollinger Bands score
	const bbandsScore = calculateBBandsScore(currentPrice, bbandsUpper, bbandsLower);
	score += bbandsScore;

	// Dynamic RSI score
	const rsiScore = calculateRsiScore(rsi) * TRADING_CONFIG.RSI_MULTIPLIER;
	score -= rsiScore; // Subtract because negative score means buy

	// Calculate slopes for both price and OBV
	const priceSlope = calculateSlope(prices, TRADING_CONFIG.OBV_WINDOW_SIZE);
	const obvSlope = calculateSlope(obvs, TRADING_CONFIG.OBV_WINDOW_SIZE);

	// Normalize slopes by their respective ranges
	const maxPrice = Math.max(...prices.slice(-TRADING_CONFIG.OBV_WINDOW_SIZE));
	const maxObv = Math.max(...obvs.slice(-TRADING_CONFIG.OBV_WINDOW_SIZE));
	const normalizedPriceSlope = (priceSlope / maxPrice) * 1000;
	const normalizedObvSlope = (obvSlope / maxObv) * 1000;

	// Calculate divergence score
	const divergenceScore =
		detectSlopeDivergence(
			normalizedPriceSlope,
			normalizedObvSlope,
			TRADING_CONFIG.SLOPE_THRESHOLD
		) * TRADING_CONFIG.OBV_DIVERGENCE_MULTIPLIER;
	score += divergenceScore;

	// Add profit-taking bias
	const profitScore = calculateProfitScore(currentPrice, entryPrice);
	score += profitScore;

	console.log(
		`[${symbol}] [trade] TA:`,
		`Score=${score.toFixed(4)}`,
		`VWAP=${vwap.toFixed(4)} (${vwapScore.toFixed(4)})`,
		`BBands=${bbandsLower.toFixed(4)}/${bbandsUpper.toFixed(4)} (${bbandsScore.toFixed(4)})`,
		`RSI=${rsi.toFixed(4)} (${rsiScore.toFixed(4)})`,
		`OBV Divergence=${divergenceScore.toFixed(4)}`,
		`Profit Score=${profitScore.toFixed(4)}`
	);

	return score;
}

export type Position = {
	symbol: string;
	size: number; // Position size in base currency (e.g., BTC)
	entryPrice: number; // Average entry price
	openedAt: number; // Timestamp when position was opened
	lastUpdateTime: number; // Last time position was updated
	cumulativePnl: number; // Total PnL including all closed positions
	successfulTrades: number; // Count of profitable trades
	totalTrades: number; // Total number of trades
};

// Get the current USDC balance
async function getBalance(env: EnvBindings): Promise<number> {
	const balance = await env.KV.get<number>('balance:USDC', 'json');
	return balance ?? TRADING_CONFIG.INITIAL_BALANCE;
}

// Update the USDC balance
async function updateBalance(env: EnvBindings, balance: number): Promise<void> {
	await env.KV.put('balance:USDC', JSON.stringify(balance));
}

export async function getPosition(env: EnvBindings, symbol: string): Promise<Position | null> {
	const key = `position:${symbol}`;
	return env.KV.get<Position>(key, 'json');
}

export async function updatePosition(env: EnvBindings, position: Position): Promise<void> {
	const key = `position:${position.symbol}`;
	await env.KV.put(key, JSON.stringify(position));
}

export async function closePosition(
	env: EnvBindings,
	symbol: string,
	expectedUsdcAmount: number
): Promise<void> {
	const key = `position:${symbol}`;
	const position = await getPosition(env, symbol);

	if (position) {
		const closingPnl = expectedUsdcAmount - position.size * position.entryPrice;
		position.cumulativePnl += closingPnl;
		position.totalTrades += 1;
		if (closingPnl > 0) {
			position.successfulTrades += 1;
		}

		// Update USDC balance
		const currentBalance = await getBalance(env);
		const newBalance = currentBalance + expectedUsdcAmount;

		console.log(
			`[${symbol}] [trade] Closing balance update:`,
			`Current=${currentBalance}`,
			`Expected USDC=${expectedUsdcAmount}`,
			`New=${newBalance}`
		);

		await updateBalance(env, newBalance);

		// Store the final state before deleting
		const statsKey = `stats:${symbol}`;
		await env.KV.put(
			statsKey,
			JSON.stringify({
				cumulativePnl: position.cumulativePnl,
				successfulTrades: position.successfulTrades,
				totalTrades: position.totalTrades
			})
		);
	}

	await env.KV.delete(key);
}

// Update position with current market data
export async function updatePositionPnL(env: EnvBindings, symbol: string): Promise<void> {
	const position = await getPosition(env, symbol);
	if (!position) return;

	// Calculate expected USDC amount from the swap
	const expectedUsdcAmount = await calculateSwapOutcome(symbol, position.size, false, env);
	const unrealizedPnl = expectedUsdcAmount - position.size * position.entryPrice;

	console.log(
		`[${symbol}] [trade] Unrealized PnL: ${unrealizedPnl} USDC`,
		`Expected USDC: ${expectedUsdcAmount}`
	);

	position.lastUpdateTime = Date.now();
	await updatePosition(env, position);
}

/**
 * Applies exponential time-decay weighting to predictions
 */
function getTimeDecayedAverage(predictions: number[], alpha: number): number {
	let weightedSum = 0;
	let weightTotal = 0;

	for (let i = 0; i < predictions.length; i++) {
		const weight = Math.pow(alpha, i);
		weightedSum += predictions[i] * weight;
		weightTotal += weight;
	}

	return weightedSum / weightTotal;
}

/**
 * Calculate actual price from swap amounts using FixedNumber
 */
function calculateActualPrice(symbol: string, baseAmount: number, quoteAmount: number): number {
	const tokens = symbolInfo[symbol as keyof typeof symbolInfo];
	if (!tokens) {
		throw new Error(`Unsupported symbol: ${symbol}`);
	}

	const baseDecimals = tokenInfo[tokens.base as keyof typeof tokenInfo].decimals;
	const quoteDecimals = tokenInfo[tokens.quote as keyof typeof tokenInfo].decimals;

	const fixedBase = new FixedNumber(
		BigInt(Math.floor(baseAmount * 10 ** baseDecimals)),
		baseDecimals
	);
	const fixedQuote = new FixedNumber(
		BigInt(Math.floor(quoteAmount * 10 ** quoteDecimals)),
		quoteDecimals
	);

	// Price = quote/base (USDT/NEAR)
	return fixedQuote.div(fixedBase).toNumber();
}

/**
 * Calculate AI score based on forecasted price difference
 * Multiply by 100 to make it comparable to other scores
 * e.g., 1% difference = score of 1
 */
function calculateAiScore(diffPct: number, hasPosition: boolean): number {
	const multiplier = hasPosition
		? TRADING_CONFIG.AI_SCORE_MULTIPLIER_EXISTING
		: TRADING_CONFIG.AI_SCORE_MULTIPLIER;
	return diffPct * multiplier;
}

/**
 * Analyze forecast and decide trading action
 */
export async function analyzeForecast(
	env: EnvBindings,
	symbol: string,
	currentPrice: number,
	forecast: NixtlaForecastResponse,
	vwap: number,
	bbandsUpper: number,
	bbandsLower: number,
	rsi: number,
	prices: number[],
	obvs: number[]
): Promise<void> {
	// Get current position if any
	const currentPosition = await getPosition(env, symbol);

	// Get actual price based on position
	let actualPrice: number;
	if (currentPosition) {
		// If we have a position, price is based on selling the full position
		const expectedUsdcAmount = await calculateSwapOutcome(symbol, currentPosition.size, false, env);
		actualPrice = calculateActualPrice(symbol, currentPosition.size, expectedUsdcAmount);

		// Check stop loss and take profit
		const priceDiff = (currentPrice - currentPosition.entryPrice) / currentPosition.entryPrice;
		if (
			priceDiff <= TRADING_CONFIG.STOP_LOSS_THRESHOLD ||
			priceDiff >= TRADING_CONFIG.TAKE_PROFIT_THRESHOLD
		) {
			console.log(
				`[${symbol}] [trade] ${priceDiff <= TRADING_CONFIG.STOP_LOSS_THRESHOLD ? 'Stop loss' : 'Take profit'} triggered:`,
				`Entry=${currentPosition.entryPrice}`,
				`Current=${currentPrice}`,
				`Actual=${actualPrice}`,
				`Diff=${(priceDiff * 100).toFixed(4)}%`
			);
			const closingPnl = expectedUsdcAmount - currentPosition.size * currentPosition.entryPrice;
			const finalPnl = closingPnl;
			console.log(`[${symbol}] [trade] Final PnL: ${finalPnl} USDC`);

			await closePosition(env, symbol, expectedUsdcAmount);
			return;
		}
	} else {
		// If we have no position, price is based on buying a full position
		const balance = await getBalance(env);
		if (balance <= 0) {
			console.log(`[${symbol}] [trade] Insufficient balance: ${balance} USDC, using current price`);
			actualPrice = currentPrice;
		} else {
			const expectedNearAmount = await calculateSwapOutcome(symbol, balance, true, env);
			actualPrice = calculateActualPrice(symbol, expectedNearAmount, balance);
		}
	}

	// Take only first 12 forecast datapoints (1 hour)
	const shortTermForecast = forecast.value.slice(0, 12);

	// Use more conservative decay for existing positions
	const decayAlpha = currentPosition
		? TRADING_CONFIG.DECAY_ALPHA_EXISTING
		: TRADING_CONFIG.DECAY_ALPHA;

	// Calculate time-decayed average of predicted prices
	const decayedAvgPrice = getTimeDecayedAverage(shortTermForecast, decayAlpha);

	// Calculate percentage difference using actual price
	const diffPct = (decayedAvgPrice - currentPrice) / currentPrice;

	// Calculate AI score
	const aiScore = calculateAiScore(diffPct, !!currentPosition);

	console.log(
		`[${symbol}] [trade] AI:`,
		`Current=${currentPrice}`,
		`Actual=${actualPrice}`,
		`DecayedAvg=${decayedAvgPrice}`,
		`Diff=${(diffPct * 100).toFixed(4)}%`
	);

	// Calculate TA score
	const taScore = calculateTaSignal({
		symbol,
		currentPrice,
		vwap,
		bbandsUpper,
		bbandsLower,
		rsi,
		prices,
		obvs,
		entryPrice: currentPosition?.entryPrice ?? null
	});

	// Combine scores
	const totalScore = aiScore + taScore;

	console.log(
		`[${symbol}] [trade] Scores:`,
		`AI=${aiScore.toFixed(4)} (${(diffPct * 100).toFixed(4)}%)`,
		`TA=${taScore.toFixed(4)}`,
		`Total=${totalScore.toFixed(4)}`
	);

	// Use score thresholds from config
	if (totalScore > TRADING_CONFIG.TOTAL_SCORE_BUY_THRESHOLD) {
		if (!currentPosition) {
			// Get current USDC balance
			const balance = await getBalance(env);
			if (balance <= 0) {
				console.log(`[${symbol}] [trade] Insufficient balance: ${balance} USDC`);
				return;
			}

			// Calculate expected NEAR amount from the swap
			const expectedNearAmount = await calculateSwapOutcome(symbol, balance, true, env);
			const size = expectedNearAmount;

			// Get previous trading stats
			const statsKey = `stats:${symbol}`;
			const stats = await env.KV.get<{
				cumulativePnl: number;
				successfulTrades: number;
				totalTrades: number;
			}>(statsKey, 'json');

			// Open new position using entire available balance
			console.log(`[${symbol}] [trade] Opening position`);
			const newPosition: Position = {
				symbol,
				size,
				entryPrice: actualPrice,
				openedAt: Date.now(),
				lastUpdateTime: Date.now(),
				cumulativePnl: stats?.cumulativePnl ?? 0,
				successfulTrades: stats?.successfulTrades ?? 0,
				totalTrades: stats?.totalTrades ?? 0
			};

			// Update USDC balance
			const newBalance = 0; // All USDC is used for the swap
			await updateBalance(env, newBalance);

			console.log(
				`[${symbol}] [trade] Position size: ${size} ${symbolInfo[symbol as keyof typeof symbolInfo].base} (${size * actualPrice} USDC), Balance: ${newBalance} USDC`
			);
			await updatePosition(env, newPosition);
		} else {
			console.log(`[${symbol}] [trade] Holding position`);
		}
	} else if (totalScore < TRADING_CONFIG.TOTAL_SCORE_SELL_THRESHOLD) {
		if (currentPosition) {
			// Calculate expected USDC amount from the swap
			const expectedUsdcAmount = await calculateSwapOutcome(
				symbol,
				currentPosition.size,
				false,
				env
			);

			// Close position
			console.log(`[${symbol}] [trade] Closing position`);
			const closingPnl = expectedUsdcAmount - currentPosition.size * currentPosition.entryPrice;
			const finalPnl = closingPnl;
			console.log(
				`[${symbol}] [trade] Final PnL: ${finalPnl} USDC`,
				`Expected USDC: ${expectedUsdcAmount}`
			);
			await closePosition(env, symbol, expectedUsdcAmount);
		} else {
			console.log(`[${symbol}] [trade] No position to close`);
		}
	} else {
		if (currentPosition) {
			console.log(`[${symbol}] [trade] Holding position`);
		} else {
			console.log(`[${symbol}] [trade] No position to hold`);
		}
	}
}
