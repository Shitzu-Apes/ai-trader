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
	OBV_WINDOW_SIZE: 8, // 2/3 hour window for slope calculation
	SLOPE_THRESHOLD: 0.1, // Minimum slope difference to consider divergence

	// AI score multipliers
	AI_SCORE_MULTIPLIER: 0, // Multiplier for new positions
	AI_SCORE_MULTIPLIER_EXISTING: 0, // More conservative multiplier for existing positions

	// TA score multipliers
	VWAP_SCORE: 0.4, // Base score for VWAP signals
	VWAP_EXTRA_SCORE: 0.6, // Additional score for stronger VWAP signals
	BBANDS_MULTIPLIER: 1.5, // Bollinger Bands score multiplier
	RSI_MULTIPLIER: 2, // RSI score multiplier
	OBV_DIVERGENCE_MULTIPLIER: 0.8, // OBV divergence score multiplier
	PROFIT_SCORE_MULTIPLIER: 1.5, // Profit-taking score multiplier (per 1% in profit)
	DEPTH_SCORE_MULTIPLIER: 1.2, // Orderbook depth imbalance score multiplier

	// Score thresholds for trading decisions
	TOTAL_SCORE_BUY_THRESHOLD: 5, // Score above which to buy
	TOTAL_SCORE_SELL_THRESHOLD: -3, // Score below which to sell

	// Partial position thresholds
	PARTIAL_POSITION_THRESHOLDS: [
		{ buy: 2.5, sell: -1 }, // 1st position (25%)
		{ buy: 5.5, sell: 1 }, // 2nd position (25%)
		{ buy: 8.5, sell: 3 }, // 3rd position (25%)
		{ buy: 11.5, sell: 5 } // 4th position (25%)
	] as const
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
	return -Math.sign(centered) * Math.pow(Math.abs(centered) / 50, 2);
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
 * Calculate VWAP score dynamically based on price difference
 * Returns a score where:
 * - Positive: VWAP above price (bullish)
 * - Negative: VWAP below price (bearish)
 * - Zero: Within 1% threshold
 * Score increases by 0.5 for each additional percentage point
 */
function calculateVwapScore(currentPrice: number, vwap: number): number {
	const vwapDiff = (vwap - currentPrice) / currentPrice;
	const threshold = 0.01; // 1%

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
 * Returns an array of scores, one for each partial position
 * For no position, returns a single score
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
	position,
	bidSize,
	askSize
}: {
	symbol: string;
	currentPrice: number;
	vwap: number;
	bbandsUpper: number;
	bbandsLower: number;
	rsi: number;
	prices: number[];
	obvs: number[];
	position: Position | null;
	bidSize: number;
	askSize: number;
}): number[] {
	// If no position, calculate a single score
	if (!position) {
		let score = 0;

		// VWAP score (only used when no position)
		const vwapScore = calculateVwapScore(currentPrice, vwap) * TRADING_CONFIG.VWAP_SCORE;
		score += vwapScore;

		// Bollinger Bands score
		const bbandsScore = calculateBBandsScore(currentPrice, bbandsUpper, bbandsLower);
		score += bbandsScore;

		// RSI score
		const rsiScore = calculateRsiScore(rsi) * TRADING_CONFIG.RSI_MULTIPLIER;
		score -= rsiScore; // Subtract because negative score means buy

		// Calculate slopes for OBV divergence
		const priceSlope = calculateSlope(prices, TRADING_CONFIG.OBV_WINDOW_SIZE);
		const obvSlope = calculateSlope(obvs, TRADING_CONFIG.OBV_WINDOW_SIZE);

		// Normalize slopes
		const maxPrice = Math.max(...prices.slice(-TRADING_CONFIG.OBV_WINDOW_SIZE));
		const maxObv = Math.max(...obvs.slice(-TRADING_CONFIG.OBV_WINDOW_SIZE));
		const normalizedPriceSlope = (priceSlope / maxPrice) * 1000;
		const normalizedObvSlope = (obvSlope / maxObv) * 1000;

		// Divergence score
		const divergenceScore =
			detectSlopeDivergence(
				normalizedPriceSlope,
				normalizedObvSlope,
				TRADING_CONFIG.SLOPE_THRESHOLD
			) * TRADING_CONFIG.OBV_DIVERGENCE_MULTIPLIER;
		score += divergenceScore;

		// Orderbook depth imbalance score
		let depthScore = 0;
		if (bidSize > askSize) {
			// Bullish imbalance
			depthScore = (bidSize - askSize) / askSize;
		} else if (askSize > bidSize) {
			// Bearish imbalance
			depthScore = -(askSize - bidSize) / bidSize;
		}
		score += depthScore * TRADING_CONFIG.DEPTH_SCORE_MULTIPLIER;

		console.log(
			`[${symbol}] [trade] TA (new position):`,
			`Score=${score.toFixed(4)}`,
			`VWAP=${vwap.toFixed(4)} (${vwapScore.toFixed(4)})`,
			`BBands=${bbandsLower.toFixed(4)}/${bbandsUpper.toFixed(4)} (${bbandsScore.toFixed(4)})`,
			`RSI=${rsi.toFixed(4)} (${rsiScore.toFixed(4)})`,
			`OBV Divergence=${divergenceScore.toFixed(4)}`,
			`Depth Score=${depthScore.toFixed(4)} (Bid=${bidSize.toFixed(2)}, Ask=${askSize.toFixed(2)})`
		);

		return [score];
	}

	// Calculate individual scores for each partial position
	const scores = position.partials.map((partial, index) => {
		let score = 0;

		// Bollinger Bands score
		const bbandsScore = calculateBBandsScore(currentPrice, bbandsUpper, bbandsLower);
		score += bbandsScore;

		// RSI score
		const rsiScore = calculateRsiScore(rsi) * TRADING_CONFIG.RSI_MULTIPLIER;
		score -= rsiScore;

		// Calculate slopes for OBV divergence
		const priceSlope = calculateSlope(prices, TRADING_CONFIG.OBV_WINDOW_SIZE);
		const obvSlope = calculateSlope(obvs, TRADING_CONFIG.OBV_WINDOW_SIZE);

		// Normalize slopes
		const maxPrice = Math.max(...prices.slice(-TRADING_CONFIG.OBV_WINDOW_SIZE));
		const maxObv = Math.max(...obvs.slice(-TRADING_CONFIG.OBV_WINDOW_SIZE));
		const normalizedPriceSlope = (priceSlope / maxPrice) * 1000;
		const normalizedObvSlope = (obvSlope / maxObv) * 1000;

		// Divergence score
		const divergenceScore =
			detectSlopeDivergence(
				normalizedPriceSlope,
				normalizedObvSlope,
				TRADING_CONFIG.SLOPE_THRESHOLD
			) * TRADING_CONFIG.OBV_DIVERGENCE_MULTIPLIER;
		score += divergenceScore;

		// Orderbook depth imbalance score
		let depthScore = 0;
		if (bidSize > askSize) {
			// Bullish imbalance
			depthScore = (bidSize - askSize) / askSize;
		} else if (askSize > bidSize) {
			// Bearish imbalance
			depthScore = -(askSize - bidSize) / bidSize;
		}
		score += depthScore * TRADING_CONFIG.DEPTH_SCORE_MULTIPLIER;

		// Profit score for this specific partial
		const priceDiff = (currentPrice - partial.entryPrice) / partial.entryPrice;
		const profitScore =
			priceDiff > 0 ? -priceDiff * TRADING_CONFIG.PROFIT_SCORE_MULTIPLIER * (1 + index * 0.5) : 0;
		score += profitScore;

		console.log(
			`[${symbol}] [trade] TA (partial #${index + 1}):`,
			`Score=${score.toFixed(4)}`,
			`BBands=${bbandsLower.toFixed(4)}/${bbandsUpper.toFixed(4)} (${bbandsScore.toFixed(4)})`,
			`RSI=${rsi.toFixed(4)} (${rsiScore.toFixed(4)})`,
			`OBV Divergence=${divergenceScore.toFixed(4)}`,
			`Depth Score=${depthScore.toFixed(4)} (Bid=${bidSize.toFixed(2)}, Ask=${askSize.toFixed(2)})`,
			`Profit Score=${profitScore.toFixed(4)}`
		);

		return score;
	});

	return scores;
}

export type PartialPosition = {
	size: number;
	entryPrice: number;
	openedAt: number;
};

export type Position = {
	symbol: string;
	size: number; // Total position size (sum of partial positions)
	lastUpdateTime: number;
	cumulativePnl: number;
	successfulTrades: number;
	totalTrades: number;
	partials: PartialPosition[]; // Array of partial positions
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

// Helper function to calculate weighted average entry price
function calculateAverageEntryPrice(partials: PartialPosition[]): number {
	let totalValue = 0;
	let totalSize = 0;
	for (const partial of partials) {
		totalValue += partial.size * partial.entryPrice;
		totalSize += partial.size;
	}
	return totalValue / totalSize;
}

export async function closePosition(
	env: EnvBindings,
	symbol: string,
	expectedUsdcAmount: number
): Promise<void> {
	const key = `position:${symbol}`;
	const position = await getPosition(env, symbol);

	if (position) {
		const avgEntryPrice = calculateAverageEntryPrice(position.partials);
		const closingPnl = expectedUsdcAmount - position.size * avgEntryPrice;
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
	const avgEntryPrice = calculateAverageEntryPrice(position.partials);
	const unrealizedPnl = expectedUsdcAmount - position.size * avgEntryPrice;

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
 * - For small differences (<=0.2%), use linear scaling
 * - For larger differences, apply logarithmic dampening
 * Multiply by configured multiplier to make it comparable to other scores
 */
function calculateAiScore(diffPct: number, position: Position | null): number {
	const threshold = 0.002; // ±0.2%
	const multiplier = position
		? TRADING_CONFIG.AI_SCORE_MULTIPLIER_EXISTING
		: TRADING_CONFIG.AI_SCORE_MULTIPLIER;

	// For small differences, use normal linear scaling
	if (Math.abs(diffPct) <= threshold) {
		return diffPct * multiplier;
	}

	// For larger differences, apply logarithmic dampening
	// Keep the sign but dampen the magnitude
	const sign = Math.sign(diffPct);
	const baseDiff = sign * threshold;
	const excessDiff = Math.abs(diffPct) - threshold;
	const dampened = baseDiff + sign * Math.log10(1 + excessDiff * 10) * threshold;

	return dampened * multiplier;
}

// Helper function to get thresholds based on partial positions
function getPositionThresholds(partialCount: number) {
	return (
		TRADING_CONFIG.PARTIAL_POSITION_THRESHOLDS[partialCount] ??
		TRADING_CONFIG.PARTIAL_POSITION_THRESHOLDS[
			TRADING_CONFIG.PARTIAL_POSITION_THRESHOLDS.length - 1
		]
	);
}

// Helper function to calculate next position size
function calculateNextPositionSize(balance: number, partialCount: number): number {
	const remainingPositions = 4 - partialCount;
	if (remainingPositions <= 0) return 0;
	return balance / remainingPositions;
}

// Helper function to check if a partial position should be closed
function shouldClosePartial(
	partial: PartialPosition,
	currentPrice: number,
	partialIndex: number,
	thresholds: { buy: number; sell: number }
): boolean {
	const priceDiff = (currentPrice - partial.entryPrice) / partial.entryPrice;

	// Check stop loss first
	if (priceDiff <= TRADING_CONFIG.STOP_LOSS_THRESHOLD) {
		console.log(
			`[trade] Stop loss triggered for partial #${partialIndex + 1}:`,
			`Entry=${partial.entryPrice}`,
			`Current=${currentPrice}`,
			`Diff=${(priceDiff * 100).toFixed(4)}%`
		);
		return true;
	}

	// Check take profit
	if (priceDiff >= TRADING_CONFIG.TAKE_PROFIT_THRESHOLD) {
		console.log(
			`[trade] Take profit triggered for partial #${partialIndex + 1}:`,
			`Entry=${partial.entryPrice}`,
			`Current=${currentPrice}`,
			`Diff=${(priceDiff * 100).toFixed(4)}%`
		);
		return true;
	}

	// Check sell threshold based on position index
	if (priceDiff < thresholds.sell) {
		console.log(
			`[trade] Sell threshold triggered for partial #${partialIndex + 1}:`,
			`Entry=${partial.entryPrice}`,
			`Current=${currentPrice}`,
			`Diff=${(priceDiff * 100).toFixed(4)}%`,
			`Threshold=${thresholds.sell}`
		);
		return true;
	}

	return false;
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
	obvs: number[],
	bidSize: number,
	askSize: number
): Promise<void> {
	// Get current position if any
	const currentPosition = await getPosition(env, symbol);
	const partialCount = currentPosition?.partials.length ?? 0;

	// Get thresholds based on current partial positions
	const thresholds = getPositionThresholds(partialCount);

	// Get actual price based on position
	let actualPrice: number;
	if (currentPosition && currentPosition.partials.length > 0) {
		// If we have a position, check each partial position
		const expectedUsdcAmount = await calculateSwapOutcome(symbol, currentPosition.size, false, env);
		actualPrice = calculateActualPrice(symbol, currentPosition.size, expectedUsdcAmount);
	} else {
		// If we have no position, price is based on buying the next partial position
		const balance = await getBalance(env);
		if (balance <= 0) {
			console.log(`[${symbol}] [trade] Insufficient balance: ${balance} USDC, using current price`);
			actualPrice = currentPrice;
		} else {
			const nextPositionSize = calculateNextPositionSize(balance, partialCount);
			const expectedNearAmount = await calculateSwapOutcome(symbol, nextPositionSize, true, env);
			actualPrice = calculateActualPrice(symbol, expectedNearAmount, nextPositionSize);
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
	const aiScore = calculateAiScore(diffPct, currentPosition);

	console.log(
		`[${symbol}] [trade] AI:`,
		`Score=${aiScore.toFixed(4)}`,
		`Current=${currentPrice}`,
		`Actual=${actualPrice}`,
		`DecayedAvg=${decayedAvgPrice}`,
		`Diff=${(diffPct * 100).toFixed(4)}%`
	);

	// Calculate TA scores (one per partial position or single score for new position)
	const taScores = calculateTaSignal({
		symbol,
		currentPrice,
		vwap,
		bbandsUpper,
		bbandsLower,
		rsi,
		prices,
		obvs,
		position: currentPosition,
		bidSize,
		askSize
	});

	// Calculate total scores for each partial position
	const totalScores = currentPosition
		? currentPosition.partials.map((_, index) => aiScore + taScores[index])
		: [aiScore + taScores[0]];

	console.log(
		`[${symbol}] [trade] Scores:`,
		`AI=${aiScore.toFixed(4)} (${(diffPct * 100).toFixed(4)}%)`,
		...totalScores.map(
			(score, i) => `Total #${i + 1}=${score.toFixed(4)} (TA=${taScores[i].toFixed(4)})`
		)
	);

	// Check if any partial positions need to be closed
	if (currentPosition && currentPosition.partials.length > 0) {
		const position = currentPosition; // Create local reference that's definitely not null
		const partialsToClose: number[] = [];

		position.partials.forEach((partial: PartialPosition, index: number) => {
			const thresholds = getPositionThresholds(index);
			if (
				totalScores[index] < thresholds.sell ||
				shouldClosePartial(partial, currentPrice, index, thresholds)
			) {
				partialsToClose.push(index);
			}
		});

		// If any partials need to be closed
		if (partialsToClose.length > 0) {
			console.log(
				`[${symbol}] [trade] Closing ${partialsToClose.length} partial positions:`,
				partialsToClose.map((i) => `#${i + 1}`).join(', ')
			);

			// Calculate total size to close
			const sizeToClose = partialsToClose.reduce(
				(sum, index) => sum + position.partials[index].size,
				0
			);

			// Calculate expected USDC amount for the closing size
			const closeUsdcAmount = await calculateSwapOutcome(symbol, sizeToClose, false, env);

			// Calculate PnL for closing partials
			const closingPnl = partialsToClose.reduce((sum, index) => {
				const partial = position.partials[index];
				const partialValue = (closeUsdcAmount * partial.size) / sizeToClose;
				return sum + (partialValue - partial.size * partial.entryPrice);
			}, 0);

			console.log(
				`[${symbol}] [trade] Closing PnL: ${closingPnl} USDC`,
				`Size=${sizeToClose}`,
				`Expected USDC=${closeUsdcAmount}`
			);

			// If closing all positions
			if (partialsToClose.length === position.partials.length) {
				await closePosition(env, symbol, closeUsdcAmount);
				return;
			}

			// Otherwise, update the position
			const remainingPartials = position.partials.filter(
				(_, index) => !partialsToClose.includes(index)
			);
			const newSize = remainingPartials.reduce((sum, p) => sum + p.size, 0);

			const updatedPosition: Position = {
				...position,
				size: newSize,
				lastUpdateTime: Date.now(),
				partials: remainingPartials,
				cumulativePnl: position.cumulativePnl + closingPnl,
				totalTrades: position.totalTrades + 1,
				successfulTrades: position.successfulTrades + (closingPnl > 0 ? 1 : 0)
			};

			// Update USDC balance
			const currentBalance = await getBalance(env);
			const newBalance = currentBalance + closeUsdcAmount;
			await updateBalance(env, newBalance);

			await updatePosition(env, updatedPosition);
			return;
		}
	} else if (totalScores[0] > thresholds.buy) {
		// Opening logic for new position
		const balance = await getBalance(env);
		if (balance <= 0) {
			console.log(`[${symbol}] [trade] Insufficient balance: ${balance} USDC`);
			return;
		}

		// Calculate size for next partial position
		const nextPositionSize = calculateNextPositionSize(balance, partialCount);
		const expectedNearAmount = await calculateSwapOutcome(symbol, nextPositionSize, true, env);
		const size = expectedNearAmount;

		// Get previous trading stats
		const statsKey = `stats:${symbol}`;
		const stats = await env.KV.get<{
			cumulativePnl: number;
			successfulTrades: number;
			totalTrades: number;
		}>(statsKey, 'json');

		// Open new position with first partial
		console.log(`[${symbol}] [trade] Opening first partial position`);
		const firstPartial: PartialPosition = {
			size,
			entryPrice: actualPrice,
			openedAt: Date.now()
		};

		const newPosition: Position = {
			symbol,
			size,
			lastUpdateTime: Date.now(),
			cumulativePnl: stats?.cumulativePnl ?? 0,
			successfulTrades: stats?.successfulTrades ?? 0,
			totalTrades: stats?.totalTrades ?? 0,
			partials: [firstPartial]
		};

		await updatePosition(env, newPosition);

		// Update USDC balance
		const newBalance = balance - nextPositionSize;
		await updateBalance(env, newBalance);

		console.log(
			`[${symbol}] [trade] Position update:`,
			`Added=${size} ${symbolInfo[symbol as keyof typeof symbolInfo].base}`,
			`Value=${size * actualPrice} USDC`,
			`Remaining Balance=${newBalance} USDC`
		);
	} else {
		// Display current position state if it exists
		if (currentPosition && currentPosition.partials.length > 0) {
			const position = currentPosition;
			console.log(
				`[${symbol}] [trade] Current position:`,
				`Total Size=${position.size}`,
				`Partials=${position.partials.length}/4`
			);
			position.partials.forEach((partial: PartialPosition, index: number) => {
				console.log(
					`[${symbol}] [trade] Partial #${index + 1}:`,
					`Size=${partial.size}`,
					`Entry=${partial.entryPrice}`,
					`Age=${Math.floor((Date.now() - partial.openedAt) / (1000 * 60))}min`
				);
			});
		} else {
			console.log(`[${symbol}] [trade] No position to hold`);
		}
	}
}
