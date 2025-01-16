import { FixedNumber } from './FixedNumber';
import { view } from './near';
import { EnvBindings } from './types';

export type PoolInfo = {
	pool_kind: string;
	token_account_ids: string[];
	amounts: string[];
	total_fee: number;
	shares_total_supply: string;
	amp: number;
};

type SmartRouterResponse = {
	result_code: number;
	result_message: string;
	result_data: {
		routes: {
			pools: {
				pool_id: string;
				token_in: string;
				token_out: string;
				amount_in: string;
				amount_out: string;
				min_amount_out: string;
			}[];
			amount_in: string;
			min_amount_out: string;
			amount_out: string;
		}[];
		contract_in: string;
		contract_out: string;
		amount_in: string;
		amount_out: string;
	};
};

export abstract class Ref {
	public static getPoolByIds(poolIds: number[], env: EnvBindings) {
		return view<PoolInfo[]>(
			env.REF_CONTRACT_ID,
			'get_pool_by_ids',
			{
				pool_ids: poolIds
			},
			env
		);
	}

	public static async findBestRoute({
		tokenIn,
		tokenOut,
		amountIn,
		slippage = 0.005,
		pathDeep = 3
	}: {
		tokenIn: string;
		tokenOut: string;
		amountIn: string;
		slippage?: number;
		pathDeep?: number;
	}): Promise<SmartRouterResponse> {
		const url = `https://smartrouter.ref.finance/findPath?amountIn=${amountIn}&tokenIn=${tokenIn}&tokenOut=${tokenOut}&pathDeep=${pathDeep}&slippage=${slippage}`;

		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Smart Router API error: ${response.status}`);
		}

		return response.json();
	}

	public static async getSmartRouterReturn({
		tokenIn,
		amountIn,
		tokenOut,
		decimals,
		slippage = 0.005
	}: {
		tokenIn: string;
		amountIn: FixedNumber;
		tokenOut: string;
		decimals: number;
		slippage?: number;
	}) {
		const response = await this.findBestRoute({
			tokenIn,
			tokenOut,
			amountIn: amountIn.toU128(),
			slippage
		});

		if (response.result_code !== 0) {
			throw new Error(`Smart Router error: ${response.result_message}`);
		}

		return new FixedNumber(response.result_data.amount_out, decimals);
	}

	public static async getReturn({
		poolId,
		tokenIn,
		amountIn,
		tokenOut,
		decimals,
		env
	}: {
		poolId: number;
		tokenIn: string;
		amountIn: FixedNumber;
		tokenOut: string;
		decimals: number;
		env: EnvBindings;
	}) {
		const args = {
			pool_id: poolId,
			token_in: tokenIn,
			amount_in: amountIn.toU128(),
			token_out: tokenOut
		};
		const out = await view<string>(env.REF_CONTRACT_ID, 'get_return', args, env);

		return new FixedNumber(out, decimals);
	}

	public static async getPool(poolId: number, env: EnvBindings): Promise<PoolInfo> {
		return view<PoolInfo>(
			env.REF_CONTRACT_ID,
			'get_pool',
			{
				pool_id: poolId
			},
			env
		);
	}
}
