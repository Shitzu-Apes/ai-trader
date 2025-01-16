import { D1Database, KVNamespace } from '@cloudflare/workers-types/experimental';

export interface EnvBindings {
	TAAPI_SECRET: string;
	NIXTLA_API_KEY: string;
	KV: KVNamespace;
	DB: D1Database;
	PROXY_URL?: string;
	PROXY_USERNAME?: string;
	PROXY_PASSWORD?: string;
	BINANCE_API_URL: string;
	NODE_URL: string;
	REF_CONTRACT_ID: string;
	ACCOUNT_ID: string;
}
