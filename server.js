import { config } from 'dotenv';
import express, { json } from 'express';
import cors from 'cors';
import { schedule } from 'node-cron';
import YahooFinance from 'yahoo-finance2';
import connectDB from './config/db.js';
import Stock from './models/Stock.js';
import Watchlist from './models/Watchlist.js';

config();

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const app = express();

app.use(cors());
app.use(json());

const normalizeTicker = (ticker = '') => ticker.trim().toUpperCase();

const isWeekday = () => {
  const day = new Date().getDay();
  return day >= 1 && day <= 5;
};

const saveWatchlistQuote = async (ticker, metadata = {}, quote = null) => {
  const q = quote || await yahooFinance.quote(ticker);
  if (!q?.regularMarketPrice) throw new Error('Price unavailable');
  if (q.marketState !== 'REGULAR') return null;

  const summary = await yahooFinance.quoteSummary(ticker, {
    modules: ['summaryDetail', 'defaultKeyStatistics']
  }).catch(() => ({}));

  return Stock.create({
    ticker,
    name: q.longName || q.shortName || metadata.name || ticker,
    price: q.regularMarketPrice,
    high: q.fiftyTwoWeekHigh ?? summary.summaryDetail?.fiftyTwoWeekHigh ?? null,
    low: q.fiftyTwoWeekLow ?? summary.summaryDetail?.fiftyTwoWeekLow ?? null,
    faceValue: null,
    marketCap: q.marketCap ?? summary.summaryDetail?.marketCap ?? null,
    currency: q.currency || ''
  });
};

const fetchAndStoreWatchlist = async () => {
  if (!isWeekday()) return;

  const watched = await Watchlist.find().lean();
  await Promise.allSettled(watched.map(async (item) => {
    try {
      await saveWatchlistQuote(item.ticker, item);
    } catch (error) {
      console.error(`Failed to store ${item.ticker}:`, error.message);
    }
  }));
};

const latestSnapshots = async (tickers = null) => {
  const match = tickers?.length ? { ticker: { $in: tickers } } : {};
  return Stock.aggregate([
    { $match: match },
    { $sort: { timestamp: -1 } },
    { $group: { _id: '$ticker', snapshot: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$snapshot' } }
  ]);
};

const NSE_UNIVERSE = [
  'RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'INFY.NS', 'ICICIBANK.NS',
  'HINDUNILVR.NS', 'ITC.NS', 'SBIN.NS', 'BHARTIARTL.NS', 'KOTAKBANK.NS',
  'LT.NS', 'AXISBANK.NS', 'MARUTI.NS', 'SUNPHARMA.NS', 'TITAN.NS',
  'ULTRACEMCO.NS', 'WIPRO.NS', 'ONGC.NS', 'NTPC.NS', 'POWERGRID.NS',
  'IOC.NS', 'BAJFINANCE.NS', 'M&M.NS', 'ADANIENT.NS', 'HCLTECH.NS'
];

const isIndianSymbol = (symbol = '') => /\.(NS|BO)$/i.test(symbol);

const quoteToMover = (quote, ticker = '') => ({
  ticker: quote.symbol || ticker,
  name: quote.longName || quote.shortName || ticker || quote.symbol,
  exchange: quote.fullExchangeName || quote.exchange || '',
  price: quote.regularMarketPrice ?? null,
  changePercent: quote.regularMarketChangePercent ?? null,
  currency: quote.currency || 'INR'
});

const screenerToMover = (q) => quoteToMover(q, q.symbol);

const fetchUniverseMovers = async () => {
  const settled = await Promise.allSettled(
    NSE_UNIVERSE.map(async (ticker) => quoteToMover(await yahooFinance.quote(ticker), ticker))
  );
  const stocks = settled
    .filter((r) => r.status === 'fulfilled' && r.value.changePercent != null && r.value.price != null)
    .map((r) => r.value);
  const sorted = [...stocks].sort((a, b) => b.changePercent - a.changePercent);
  return {
    gainers: sorted.slice(0, 3),
    losers: sorted.slice(-3).reverse()
  };
};

const fetchScreenerMovers = async (scrIds, count = 50) => {
  const result = await yahooFinance.screener({ scrIds, count, region: 'IN', lang: 'en-IN' });
  return (result.quotes || [])
    .filter((q) => isIndianSymbol(q.symbol))
    .map(screenerToMover)
    .filter((s) => s.changePercent != null && s.price != null);
};

app.get('/api/stocks/movers', async (_req, res) => {
  try {
    const [gainerQuotes, loserQuotes] = await Promise.all([
      fetchScreenerMovers('day_gainers'),
      fetchScreenerMovers('day_losers')
    ]);

    if (gainerQuotes.length >= 3 && loserQuotes.length >= 3) {
      return res.json({
        gainers: gainerQuotes.slice(0, 3),
        losers: loserQuotes.slice(0, 3)
      });
    }

    const universe = await fetchUniverseMovers();
    res.json({
      gainers: gainerQuotes.length >= 3 ? gainerQuotes.slice(0, 3) : universe.gainers,
      losers: loserQuotes.length >= 3 ? loserQuotes.slice(0, 3) : universe.losers
    });
  } catch (error) {
    try {
      res.json(await fetchUniverseMovers());
    } catch {
      res.status(500).json({ message: error.message });
    }
  }
});

app.get('/api/stocks/search', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (!query) return res.json([]);

    const result = await yahooFinance.search(query, { quotesCount: 25, newsCount: 0 });
    const stocks = (result.quotes || [])
      .filter((q) => q.symbol && q.isYahooFinance !== false)
      .filter((q) => !q.quoteType || ['EQUITY', 'ETF'].includes(q.quoteType))
      .map((q) => ({
        ticker: q.symbol,
        name: q.longname || q.shortname || q.symbol,
        exchange: q.exchDisp || q.exchange || ''
      }));

    res.json(stocks);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/watchlist', async (_req, res) => {
  try {
    const items = await Watchlist.find().sort({ ticker: 1 }).lean();
    const snapshots = await latestSnapshots(items.map((i) => i.ticker));
    const byTicker = Object.fromEntries(snapshots.map((s) => [s.ticker, s]));

    const enriched = await Promise.all(items.map(async (item) => {
      try {
        const quote = await yahooFinance.quote(item.ticker);
        return {
          ...item,
          live: {
            price: quote.regularMarketPrice ?? null,
            changePercent: quote.regularMarketChangePercent ?? null,
            currency: quote.currency || '',
            marketCap: quote.marketCap ?? null,
            high52: quote.fiftyTwoWeekHigh ?? null,
            low52: quote.fiftyTwoWeekLow ?? null,
            updatedAt: quote.regularMarketTime || null
          },
          snapshot: byTicker[item.ticker] || null
        };
      } catch {
        return { ...item, live: null, snapshot: byTicker[item.ticker] || null };
      }
    }));

    res.json(enriched);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/watchlist', async (req, res) => {
  try {
    const ticker = normalizeTicker(req.body.ticker);
    if (!ticker) return res.status(400).json({ message: 'Ticker is required' });

    const quote = await yahooFinance.quote(ticker);
    if (!quote?.regularMarketPrice) return res.status(404).json({ message: 'Stock not found' });

    const item = await Watchlist.findOneAndUpdate(
      { ticker },
      {
        ticker,
        name: quote.longName || quote.shortName || ticker,
        exchange: quote.fullExchangeName || quote.exchange || ''
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    if (quote.marketState === 'REGULAR') {
      await saveWatchlistQuote(ticker, item.toObject(), quote);
    }

    res.status(201).json(item);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.delete('/api/watchlist/:ticker', async (req, res) => {
  try {
    const ticker = normalizeTicker(req.params.ticker);
    const removed = await Watchlist.findOneAndDelete({ ticker });
    if (!removed) return res.status(404).json({ message: 'Not in watchlist' });
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/stocks/:ticker', async (req, res) => {
  try {
    const ticker = normalizeTicker(req.params.ticker);
    const period1 = new Date();
    period1.setFullYear(period1.getFullYear() - 1);

    const [quote, summary, history, watchlisted, snapshots] = await Promise.all([
      yahooFinance.quote(ticker),
      yahooFinance.quoteSummary(ticker, {
        modules: ['summaryDetail', 'defaultKeyStatistics', 'financialData']
      }).catch(() => ({})),
      yahooFinance.chart(ticker, { period1, interval: '1d' }).catch(() => ({ quotes: [] })),
      Watchlist.exists({ ticker }),
      latestSnapshots([ticker])
    ]);

    if (!quote?.regularMarketPrice) return res.status(404).json({ message: 'Stock not found' });

    const details = summary || {};

    res.json({
      ticker,
      name: quote.longName || quote.shortName || ticker,
      exchange: quote.fullExchangeName || quote.exchange || '',
      currency: quote.currency || '',
      price: quote.regularMarketPrice,
      changePercent: quote.regularMarketChangePercent ?? null,
      marketState: quote.marketState || 'CLOSED',
      updatedAt: quote.regularMarketTime || null,
      watchlisted: Boolean(watchlisted),
      snapshot: snapshots[0] || null,
      marketCap: quote.marketCap ?? details.summaryDetail?.marketCap ?? null,
      high52: quote.fiftyTwoWeekHigh ?? details.summaryDetail?.fiftyTwoWeekHigh ?? null,
      low52: quote.fiftyTwoWeekLow ?? details.summaryDetail?.fiftyTwoWeekLow ?? null,
      pe: quote.trailingPE ?? details.summaryDetail?.trailingPE ?? null,
      bookValue: details.defaultKeyStatistics?.bookValue ?? null,
      dividendYield: quote.trailingAnnualDividendYield ?? details.summaryDetail?.dividendYield ?? null,
      roe: details.financialData?.returnOnEquity ?? null,
      roce: details.financialData?.returnOnAssets ?? null,
      faceValue: snapshots[0]?.faceValue ?? null,
      history: (history.quotes || [])
        .filter(({ close }) => Number.isFinite(close))
        .map(({ date, close, volume }) => ({ date, close, volume: volume ?? 0 }))
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

const start = async () => {
  await connectDB();

  schedule('*/30 * * * *', fetchAndStoreWatchlist);

  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
};

start().catch((error) => {
  console.error('Backend failed to start:', error);
  process.exit(1);
});
