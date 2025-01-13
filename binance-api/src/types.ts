export type BinanceOrderbookResponse = {
	lastUpdateId: number;
	bids: [string, string][]; // [price, quantity][]
	asks: [string, string][]; // [price, quantity][]
};

export type BinanceOpenInterestResponse = {
	symbol: string;
	sumOpenInterest: string;
	sumOpenInterestValue: string;
	timestamp: number;
};

export type BinanceFundingRateResponse = {
	symbol: string;
	markPrice: string;
	lastFundingRate: string;
	nextFundingTime: number;
	timestamp: number;
};

export type DepthResponse = {
	bid_size: number;
	ask_size: number;
	bid_levels: number;
	ask_levels: number;
};

export type LiquidationZonesResponse = {
	long_size: number;
	short_size: number;
	long_accounts: number;
	short_accounts: number;
	avg_long_price: number;
	avg_short_price: number;
};
