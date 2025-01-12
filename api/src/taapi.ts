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

	console.log('[date]', date.format('YYYY-MM-DD HH:mm'));

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
	const timestamp = date.valueOf();

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
