import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration';
import relativeTime from 'dayjs/plugin/relativeTime';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { Hono, type Env } from 'hono';
import { cors } from 'hono/cors';
import { poweredBy } from 'hono/powered-by';
import type { HTTPResponseError } from 'hono/types';

import datapoints from './datapoints';
import { fetchTaapiIndicators } from './taapi';
import { EnvBindings } from './types';

// eslint-disable-next-line import/no-named-as-default-member
dayjs.extend(duration);
// eslint-disable-next-line import/no-named-as-default-member
dayjs.extend(relativeTime);
// eslint-disable-next-line import/no-named-as-default-member
dayjs.extend(timezone);
// eslint-disable-next-line import/no-named-as-default-member
dayjs.extend(utc);

const app = new Hono<Env>();

app.route('/api', datapoints);

app.use('*', poweredBy());
app.use(
	'*',
	cors({
		origin: '*',
		credentials: true
	})
);

app.onError(async (err) => {
	if (typeof (err as HTTPResponseError)['getResponse'] !== 'undefined') {
		const httpErr = err as HTTPResponseError;
		const res = httpErr.getResponse();
		const text = await res.clone().text();
		console.log(`[HTTPError ${res.status}]: ${text}`);
		return res;
	}
	console.log('Unknown error:', (err as Error).message);
	return new Response(null, {
		status: 500
	});
});

app.notFound(() => {
	return new Response(null, { status: 404 });
});

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return app.fetch(request, env, ctx);
	},
	async scheduled(controller: ScheduledController, env: EnvBindings, ctx: ExecutionContext) {
		switch (controller.cron) {
			case '*/5 * * * *':
				ctx.waitUntil(fetchTaapiIndicators('NEAR/USDT', env));
				// ctx.waitUntil(fetchTaapiIndicators('SOL/USDT', env));
				// ctx.waitUntil(fetchTaapiIndicators('BTC/USDT', env));
				// ctx.waitUntil(fetchTaapiIndicators('ETH/USDT', env));
				break;
		}
	}
};
