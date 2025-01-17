import dayjs from 'dayjs';

import { getCurrentTimeframe } from './datapoints';
import { fetchHistoricalData } from './taapi';
import { EnvBindings } from './types';

export type NixtlaForecastResponse = {
	timestamp: string[];
	value: number[];
	input_tokens: number;
	output_tokens: number;
	finetune_tokens: number;
	request_id: string;
};

export async function makeForecast(
	env: EnvBindings,
	symbol: string
): Promise<{
	forecast: NixtlaForecastResponse;
	vwap: number;
	bbandsUpper: number;
	bbandsLower: number;
	rsi: number;
	obvDelta: number;
}> {
	// Get historical data
	const { timestamps, y, x, vwap, bbandsUpper, bbandsLower, rsi, obvDelta } =
		await fetchHistoricalData(env.DB, symbol);

	const currentTimeframe = getCurrentTimeframe();
	const cacheKey = `forecast:${symbol}`;
	const lastForecastKey = `last_forecast:${symbol}`;

	// Check if the latest timestamp matches the current timeframe
	if (timestamps[timestamps.length - 1] !== currentTimeframe.format('YYYY-MM-DD HH:mm:ss')) {
		console.log(`Data fetch is still pending for ${symbol}, returning last forecast`);
		const lastForecast = await env.KV.get<NixtlaForecastResponse>(lastForecastKey, 'json');
		if (lastForecast) {
			return { forecast: lastForecast, vwap, bbandsUpper, bbandsLower, rsi, obvDelta };
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
			clean_ex_first: true,
			finetune_steps: 20,
			finetune_loss: 'mae'
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
	return { forecast, vwap, bbandsUpper, bbandsLower, rsi, obvDelta };
}

export async function checkForecastAccuracy(
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
