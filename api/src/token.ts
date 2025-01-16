import { FixedNumber } from './FixedNumber';
import { view } from './near';
import { EnvBindings } from './types';

type FungibleTokenMetadata = {
	decimals: number;
	icon?: string | null;
	name: string;
	reference?: string | null;
	reference_hash?: string | null;
	spec: string;
	symbol: string;
};

const tokenMetadataCache: Record<string, FungibleTokenMetadata> = {};

export abstract class Ft {
	public static async balanceOf(
		tokenId: string,
		accountId: string,
		decimals: number,
		env: EnvBindings
	) {
		const balance = await view<string>(
			tokenId,
			'ft_balance_of',
			{
				account_id: accountId
			},
			env
		);

		return new FixedNumber(balance, decimals);
	}

	public static async totalSupply(tokenId: string, env: EnvBindings) {
		return view<string>(tokenId, 'ft_total_supply', {}, env);
	}

	public static async metadata(tokenId: string, env: EnvBindings) {
		if (tokenMetadataCache[tokenId] != null) {
			return tokenMetadataCache[tokenId];
		}
		const metadata = await view<FungibleTokenMetadata>(tokenId, 'ft_metadata', {}, env);
		tokenMetadataCache[tokenId] = metadata;
		return metadata;
	}

	public static async isUserRegistered(
		tokenId: string,
		accountId: string,
		env: EnvBindings
	): Promise<boolean> {
		const storageBalance = await view(
			tokenId,
			'storage_balance_of',
			{
				account_id: accountId
			},
			env
		);

		return storageBalance != null;
	}
}
