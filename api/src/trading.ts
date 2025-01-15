import { NixtlaForecastResponse } from './taapi';
import { EnvBindings } from './types';

// Trading algorithm configuration
const TRADING_CONFIG = {
	DECAY_ALPHA: 0.95, // Exponential decay factor for new positions
	DECAY_ALPHA_EXISTING: 0.9, // More conservative decay factor for existing positions
	UPPER_THRESHOLD: 0.003, // +0.3% threshold for buying
	LOWER_THRESHOLD: -0.003, // -0.3% threshold for selling
	STOP_LOSS_THRESHOLD: -0.02, // -2% stop loss threshold
	INITIAL_BALANCE: 1000, // Initial USDC balance
	TRADING_FEE: 0.0005 // 0.05% trading fee
} as const;

export type Position = {
	symbol: string;
	size: number; // Position size in base currency (e.g., BTC)
	entryPrice: number; // Average entry price
	openedAt: number; // Timestamp when position was opened
	unrealizedPnl: number; // Current unrealized profit/loss
	realizedPnl: number; // Total realized profit/loss for this position
	fees: number; // Total fees paid
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
	currentPrice: number
): Promise<void> {
	const key = `position:${symbol}`;
	const position = await getPosition(env, symbol);

	if (position) {
		const closingPnl = calculateUnrealizedPnl(position, currentPrice);
		position.cumulativePnl += closingPnl;
		position.totalTrades += 1;
		if (closingPnl > 0) {
			position.successfulTrades += 1;
		}

		// Update USDC balance
		const currentBalance = await getBalance(env);
		const newBalance =
			currentBalance + closingPnl - calculateTradingFees(currentPrice, position.size);
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

// Calculate unrealized PnL for a position
export function calculateUnrealizedPnl(position: Position, currentPrice: number): number {
	const priceDiff = currentPrice - position.entryPrice;
	return position.size * priceDiff;
}

// Update position with current market data
export async function updatePositionPnL(
	env: EnvBindings,
	symbol: string,
	currentPrice: number
): Promise<void> {
	const position = await getPosition(env, symbol);
	if (!position) return;

	position.unrealizedPnl = calculateUnrealizedPnl(position, currentPrice);
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
 * Calculate trading fees for a transaction
 */
function calculateTradingFees(price: number, size: number): number {
	return price * size * TRADING_CONFIG.TRADING_FEE;
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

	// Check stop loss first if we have a position
	if (currentPosition) {
		const priceDiff = (currentPrice - currentPosition.entryPrice) / currentPosition.entryPrice;
		if (priceDiff <= TRADING_CONFIG.STOP_LOSS_THRESHOLD) {
			console.log(
				`[${symbol}] [trade] Stop loss triggered:`,
				`Entry=${currentPosition.entryPrice}`,
				`Current=${currentPrice}`,
				`Diff=${(priceDiff * 100).toFixed(4)}%`
			);
			const closingPnl = calculateUnrealizedPnl(currentPosition, currentPrice);
			const finalPnl = currentPosition.realizedPnl + closingPnl;
			console.log(`[${symbol}] [trade] Final PnL: ${finalPnl} USDC`);
			await closePosition(env, symbol, currentPrice);
			return;
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

	// Calculate percentage difference
	const diffPct = (decayedAvgPrice - currentPrice) / currentPrice;

	console.log(
		`[${symbol}] [trade] Analysis:`,
		`Current=${currentPrice}`,
		`DecayedAvg=${decayedAvgPrice}`,
		`Diff=${(diffPct * 100).toFixed(4)}%`,
		`Using ${shortTermForecast.length} forecast points`,
		`Decay=${decayAlpha}`
	);

	// Generate signal based on thresholds
	let signal: 'buy' | 'sell' | 'hold';
	if (diffPct > TRADING_CONFIG.UPPER_THRESHOLD) {
		signal = 'buy';
	} else if (diffPct < TRADING_CONFIG.LOWER_THRESHOLD) {
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

			// Calculate position size in base currency
			const positionSizeUSDC = balance * 0.99; // Leave some for fees
			const size = positionSizeUSDC / currentPrice;

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
				entryPrice: currentPrice,
				openedAt: Date.now(),
				unrealizedPnl: 0,
				realizedPnl: 0,
				fees: calculateTradingFees(currentPrice, size),
				lastUpdateTime: Date.now(),
				cumulativePnl: stats?.cumulativePnl ?? 0,
				successfulTrades: stats?.successfulTrades ?? 0,
				totalTrades: stats?.totalTrades ?? 0
			};

			// Update USDC balance
			const newBalance = balance - size * currentPrice - newPosition.fees;
			await updateBalance(env, newBalance);

			console.log(
				`[${symbol}] [trade] Position size: ${size} (${size * currentPrice} USDC), Balance: ${newBalance} USDC`
			);
			await updatePosition(env, newPosition);
		} else {
			// Already have a position, update PnL
			console.log(`[${symbol}] [trade] Maintaining position`);
			await updatePositionPnL(env, symbol, currentPrice);
		}
	} else if (signal === 'sell') {
		if (currentPosition) {
			// Close position
			console.log(`[${symbol}] [trade] Closing position`);
			const closingPnl = calculateUnrealizedPnl(currentPosition, currentPrice);
			const finalPnl = currentPosition.realizedPnl + closingPnl;
			console.log(`[${symbol}] [trade] Final PnL: ${finalPnl} USDC`);
			await closePosition(env, symbol, currentPrice);
		} else {
			console.log(`[${symbol}] [trade] No position to close`);
		}
	} else {
		// Hold signal - update PnL if we have a position
		if (currentPosition) {
			console.log(`[${symbol}] [trade] Holding position`);
			await updatePositionPnL(env, symbol, currentPrice);
		} else {
			console.log(`[${symbol}] [trade] No position to hold`);
		}
	}
}
