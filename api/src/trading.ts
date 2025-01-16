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
	STOP_LOSS_THRESHOLD: -0.005, // -0.5% stop loss threshold
	INITIAL_BALANCE: 1000 // Initial USDC balance
} as const;

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
 * Analyze forecast and decide trading action
 */
export async function analyzeForecast(
	env: EnvBindings,
	symbol: string,
	currentPrice: number,
	forecast: NixtlaForecastResponse
): Promise<void> {
	console.log(`[${symbol}] [trade] Analyzing forecast...`);

	// Get current position if any
	const currentPosition = await getPosition(env, symbol);

	// Get actual price based on position
	let actualPrice: number;
	if (currentPosition) {
		// If we have a position, price is based on selling the full position
		const expectedUsdcAmount = await calculateSwapOutcome(symbol, currentPosition.size, false, env);
		actualPrice = calculateActualPrice(symbol, currentPosition.size, expectedUsdcAmount);

		// Check stop loss
		const priceDiff = (currentPrice - currentPosition.entryPrice) / currentPosition.entryPrice;
		if (priceDiff <= TRADING_CONFIG.STOP_LOSS_THRESHOLD) {
			console.log(
				`[${symbol}] [trade] Stop loss triggered:`,
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

	// Use more conservative parameters for existing positions
	const decayAlpha = currentPosition
		? TRADING_CONFIG.DECAY_ALPHA_EXISTING
		: TRADING_CONFIG.DECAY_ALPHA;
	const upperThreshold = currentPosition
		? TRADING_CONFIG.UPPER_THRESHOLD_EXISTING
		: TRADING_CONFIG.UPPER_THRESHOLD;
	const lowerThreshold = currentPosition
		? TRADING_CONFIG.LOWER_THRESHOLD_EXISTING
		: TRADING_CONFIG.LOWER_THRESHOLD;

	// Calculate time-decayed average of predicted prices
	const decayedAvgPrice = getTimeDecayedAverage(shortTermForecast, decayAlpha);

	// Calculate percentage difference using actual price
	const diffPct = (decayedAvgPrice - currentPrice) / currentPrice;

	console.log(
		`[${symbol}] [trade] Analysis:`,
		`Current=${currentPrice}`,
		`Actual=${actualPrice}`,
		`DecayedAvg=${decayedAvgPrice}`,
		`Diff=${(diffPct * 100).toFixed(4)}%`,
		`Using ${shortTermForecast.length} forecast points`,
		`Decay=${decayAlpha}`,
		`Thresholds=${(upperThreshold * 100).toFixed(3)}%/${(lowerThreshold * 100).toFixed(3)}%`
	);

	// Generate signal based on thresholds
	let signal: 'buy' | 'sell' | 'hold';
	if (diffPct > upperThreshold) {
		signal = 'buy';
	} else if (diffPct < lowerThreshold) {
		signal = 'sell';
	} else {
		signal = 'hold';
	}

	// Position management logic
	if (signal === 'buy') {
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
	} else if (signal === 'sell') {
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
		// Hold signal - no need to update PnL since it will be calculated from actual prices
		if (currentPosition) {
			console.log(`[${symbol}] [trade] Holding position`);
		} else {
			console.log(`[${symbol}] [trade] No position to hold`);
		}
	}
}
