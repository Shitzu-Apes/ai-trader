# AI Trader

An automated trading bot that uses machine learning to predict price movements and execute trades on the NEAR blockchain using the REF Finance DEX.

## Overview

The bot combines several components to make trading decisions:

- Cloudflare D1 (SQLite) for storing historical market data
- TimeGPT (Nixtla) for price predictions
- Technical indicators from TAAPI
- Market data from Binance (via proxy)
- REF Finance DEX for executing trades
- Cloudflare Workers for serverless deployment
- Cloudflare KV for state management

## How it Works

1. **Data Collection (Every 5 minutes)**
   - Gets technical indicators from TAAPI (VWAP, ATR, Bollinger Bands, RSI, OBV)
   - Fetches orderbook depth and liquidation zones from Binance
   - Stores everything in Cloudflare D1

2. **Price Prediction**
   - Uses TimeGPT to forecast next 24 5-minute price points
   - Applies time-decay weighting to prioritize near-term predictions
   - Uses fine-tuning with MAE loss for better accuracy

3. **Trading Strategy**
   The bot uses a dual-signal approach, combining AI predictions with technical analysis:

   **AI Signal:**
   - Applies time-decay weighting to short-term predictions
   - Uses tighter thresholds when position is open
   - Generates buy/sell/hold signal based on weighted forecast vs current price

   **Technical Analysis Signal:**
   - Calculates a score based on multiple indicators:
     - VWAP crossovers and divergence
     - Bollinger Bands breakouts
     - RSI oversold/overbought levels
     - OBV momentum (using square root scaling)
   - Generates buy/sell/hold signal based on final score

   **Trading Decision:**
   - Only executes trades when both signals agree (both buy or both sell)
   - Uses REF Finance Smart Router API for best swap prices
   - Implements stop loss protection
   - All positions are unidirectional (no shorts)

4. **Position Management**
   - Paper trading with simulated USDC balance
   - Tracks PnL, win rate, and other statistics
   - All positions are unidirectional (no shorts)
   - Uses actual DEX prices/liquidity for realistic simulation
   - State stored in Cloudflare KV

## Configuration

The main configuration is in `trading.ts`:

```typescript
const TRADING_CONFIG = {
    DECAY_ALPHA: 0.92,              // Exponential decay for new positions
    DECAY_ALPHA_EXISTING: 0.9,      // More conservative decay for existing
    UPPER_THRESHOLD: 0.002,         // +0.2% threshold for buying
    LOWER_THRESHOLD: -0.002,        // -0.2% threshold for selling
    UPPER_THRESHOLD_EXISTING: 0.0005, // +0.05% when position exists
    LOWER_THRESHOLD_EXISTING: -0.0005, // -0.05% when position exists
    STOP_LOSS_THRESHOLD: -0.02,     // -2% stop loss
    INITIAL_BALANCE: 1000           // Starting USDC balance
}
```

## Setup

1. Environment Variables:

```bash
NODE_URL=<NEAR RPC URL>
NIXTLA_API_KEY=<TimeGPT API Key>
TAAPI_SECRET=<TAAPI API Key>
BINANCE_API_URL=<Binance API Proxy URL>
```

2. Database:

- Uses Cloudflare D1 (SQLite) for market data
- Uses Cloudflare KV for positions and state
- Schema includes tables for market data and indicators

3. Deploy:

```bash
yarn install
wrangler d1 create ai-trader-db
wrangler kv:namespace create ai-trader-kv
wrangler deploy
```

## API Endpoints

- `/history/:symbol` - Get historical market data
- `/latest/:symbol` - Get latest market data
- `/forecast/:symbol` - Get current price forecast
- `/position/:symbol` - Get current position
- `/stats/:symbol` - Get trading statistics
- `/portfolio` - Get overall portfolio status

## Monitoring

The bot logs detailed information about:

- Data collection status
- Forecast accuracy metrics (MAE, MAPE, R²)
- Technical analysis scores
- Trade decisions and reasoning
- Position updates and PnL
- Error conditions and recovery

## Supported Markets

Currently supports NEAR/USDT on REF Finance with the following features:

- Real-time price data via Binance API proxy
- Full orderbook depth
- Smart Router API for best swap prices
- Position tracking

## Development

To run locally:

1. Clone the repository
2. Install dependencies: `yarn install`
3. Set up environment variables
4. Create local D1 database: `wrangler d1 create ai-trader-db --local`
5. Start local development: `yarn dev`

## Architecture Notes

- Uses a separate Binance API proxy service since Cloudflare Workers IP ranges are blocked by Binance
- Trading decisions use current market price for signals but actual DEX prices for execution
- All state is maintained in Cloudflare KV for serverless operation
- Uses REF Finance Smart Router API with fallback to single pool for best prices

## Contributing

Feel free to submit issues and pull requests for:

- New trading strategies
- Additional technical indicators
- Market support
- Performance improvements
- Documentation updates 