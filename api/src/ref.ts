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
