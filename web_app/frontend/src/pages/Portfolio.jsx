import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  LineElement,
  CategoryScale,
  LinearScale,
  PointElement,
  Tooltip,
  Filler,
} from "chart.js";
import { fetchMarketsByIds, searchCoins, fetchMarketChart } from "../services/coingecko";
import { useAuth } from "../state/AuthContext";
import { useUserCurrency } from "../hooks/useUserCurrency";
import { fetchPortfolio, buyHolding, sellHolding as sellHoldingApi } from "../services/portfolio";

ChartJS.register(LineElement, CategoryScale, LinearScale, PointElement, Tooltip, Filler);

const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const quantityFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 8,
});

const integerFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const TIMEFRAMES = {
  "7": {
    buttonLabel: "Weekly",
    label: "7-Day",
    description: "last 7 days",
    days: 7,
  },
  "30": {
    buttonLabel: "Monthly",
    label: "30-Day",
    description: "last 30 days",
    days: 30,
  },
};

const formatCurrencyWithFormatter = (value, formatter) => {
  if (value === null || value === undefined || value === "") return "—";
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  const fmt = formatter ?? USD_FORMATTER;
  try {
    return fmt.format(num);
  } catch {
    return USD_FORMATTER.format(num);
  }
};

const formatSignedCurrency = (value, formatter) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  const prefix = num > 0 ? "+" : "";
  const formatted = formatCurrencyWithFormatter(num, formatter);
  return prefix ? `${prefix}${formatted}` : formatted;
};

const formatSignedPercent = (value) => {
  if (!Number.isFinite(value)) return null;
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}%`;
};

const getTrendTone = (value) => {
  if (!Number.isFinite(value) || value === 0) return "text-base-content/70";
  return value > 0 ? "text-success" : "text-error";
};

const getBadgeTone = (value) => {
  if (!Number.isFinite(value) || value === 0) return "badge-ghost";
  return value > 0 ? "badge-success" : "badge-error";
};

const toFiniteNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const FALLBACK_SPARKLINE_POINTS = 48;
const ONE_HOUR_MS = 60 * 60 * 1000;
const SPARKLINE_OPTIONS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  plugins: {
    legend: { display: false },
    tooltip: { enabled: false },
  },
  scales: {
    x: { display: false },
    y: { display: false },
  },
  elements: {
    line: { borderJoinStyle: "round" },
    point: { radius: 0 },
  },
};

const buildSparklineSeries = (series, fallbackValue) => {
  const cleaned = Array.isArray(series)
    ? series
        .map((point) => toFiniteNumber(point))
        .filter((point) => point != null)
    : [];

  if (cleaned.length >= 2) {
    return cleaned;
  }

  if (cleaned.length === 1) {
    return Array.from(
      { length: Math.max(FALLBACK_SPARKLINE_POINTS, cleaned.length) },
      () => cleaned[0]
    );
  }

  const base = toFiniteNumber(fallbackValue);
  if (base == null) return [];

  return Array.from({ length: FALLBACK_SPARKLINE_POINTS }, () => base);
};

// Normalize API holdings to UI shape
const normalizeHoldingsFromApi = (holdings) => {
  if (!Array.isArray(holdings)) return [];
  return holdings.map((h) => {
    const coin = h.coin_data || h.coin || {};
    return {
      // coin identification
      id: h.coin_id || coin.id || h.id,
      // amounts & pricing
      quantity: toFiniteNumber(h.quantity) ?? 0,
      avgBuyPrice: toFiniteNumber(h.avg_price) ?? 0,
      avgPriceBaseCurrency: (h.avg_price_currency || "USD").toUpperCase(),
      // meta
      name: coin.name || h.name,
      symbol: (coin.symbol || h.symbol || "").toUpperCase(),
      image: coin.image || h.image || null,
      // passthrough
      createdAt: h.created_at,
      updatedAt: h.updated_at,
      transactions: Array.isArray(h.transactions) ? h.transactions : [],
    };
  });
};

const mergeHoldingsWithMarket = (holdings, marketData = [], usdRate = 1, displayCurrency = "USD") => {
  if (!Array.isArray(holdings) || !holdings.length) return [];

  return holdings.map((holding) => {
    const market = marketData.find((m) => m.id === holding.id) || {};
    const quantity = toFiniteNumber(holding.quantity) ?? 0;
    const avgBuyPriceUsd = toFiniteNumber(holding.avgBuyPrice) ?? 0;
    const rawCurrentPrice = toFiniteNumber(market.current_price);
    const fallbackPrice =
      rawCurrentPrice != null && rawCurrentPrice > 0
        ? rawCurrentPrice
        : avgBuyPriceUsd > 0
        ? avgBuyPriceUsd
        : null;
    const resolvedPrice =
      rawCurrentPrice != null
        ? rawCurrentPrice
        : avgBuyPriceUsd != null
        ? avgBuyPriceUsd
        : 0;

    const convertUsd = (value) => {
      const num = toFiniteNumber(value);
      if (num == null) return null;
      if (!Number.isFinite(usdRate) || usdRate <= 0) return num;
      return num * usdRate;
    };
    const avgBuyPriceDisplay = convertUsd(avgBuyPriceUsd) ?? avgBuyPriceUsd;

    return {
      ...holding,
      quantity,
      avgBuyPrice: avgBuyPriceDisplay,
      avgBuyPriceUsd,
      avgPriceCurrency: displayCurrency.toUpperCase(),
      avgPriceBaseCurrency: (holding.avgPriceBaseCurrency || "USD").toUpperCase(),
      name: market?.name || holding.name || holding.id,
      symbol: (market?.symbol || holding.symbol || holding.id || "").toUpperCase(),
      image: market?.image ?? holding.image ?? null,
      currentPrice: resolvedPrice ?? 0,
      ch24h: toFiniteNumber(market?.ch24h),
      ch7d: toFiniteNumber(market?.ch7d),
      sparkline: buildSparklineSeries(
        market?.sparkline_in_7d?.price,
        fallbackPrice
      ),
      transactions: Array.isArray(holding.transactions)
        ? holding.transactions.map((tx) => ({
            ...tx,
            price: convertUsd(tx.price) ?? tx.price,
            totalCost: convertUsd(tx.totalCost) ?? tx.totalCost,
            totalProceeds: convertUsd(tx.totalProceeds) ?? tx.totalProceeds,
            costBasis: convertUsd(tx.costBasis) ?? tx.costBasis,
          }))
        : holding.transactions,
      costBasisDisplay: convertUsd(quantity * avgBuyPriceUsd) ?? quantity * avgBuyPriceUsd,
    };
  });
};

const bucketTimestamp = (timestamp) => {
  const rawTs = toFiniteNumber(timestamp);
  if (rawTs == null) return null;
  const bucketSizeMs = 24 * ONE_HOUR_MS;
  return Math.floor(rawTs / bucketSizeMs) * bucketSizeMs;
};

const isSameDay = (leftTs, rightTs) => {
  const left = new Date(leftTs);
  const right = new Date(rightTs);
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
};

const formatChartLabel = (timestamp) => {
  if (isSameDay(timestamp, Date.now())) {
    return "Today";
  }
  const date = new Date(timestamp);
  return date.toLocaleDateString("en-AU", {
    month: "short",
    day: "numeric",
  });
};

const buildPortfolioFallbackSeries = (holdings, periodDays) => {
  if (!Array.isArray(holdings) || !holdings.length) return [];
  const maxPoints = holdings.reduce((length, holding) => {
    const seriesLength = Array.isArray(holding.sparkline) ? holding.sparkline.length : 0;
    return Math.max(length, seriesLength);
  }, 0);

  if (!Number.isFinite(maxPoints) || maxPoints <= 0) return [];

  const minimumPoints = Math.max(60, periodDays * 2);
  const targetPoints = Math.max(maxPoints, minimumPoints);

  const totalHours = periodDays * 24;
  const steps = Math.max(1, targetPoints - 1);
  const stepMs = steps > 0 ? (totalHours / steps) * ONE_HOUR_MS : ONE_HOUR_MS;
  const startTimestamp = Date.now() - stepMs * (targetPoints - 1);

  return Array.from({ length: targetPoints }, (_, index) => {
    const value = holdings.reduce((acc, holding) => {
      const series = Array.isArray(holding.sparkline) ? holding.sparkline : [];
      if (!series.length) return acc;
      const scaledIndex =
        series.length > 1
          ? Math.min(
              Math.round((index / Math.max(targetPoints - 1, 1)) * (series.length - 1)),
              series.length - 1
            )
          : 0;
      const price = toFiniteNumber(series[scaledIndex]);
      if (price == null) return acc;
      return acc + (holding.quantity ?? 0) * price;
    }, 0);

    const timestamp = startTimestamp + index * stepMs;

    return {
      timestamp,
      value,
      date: formatChartLabel(timestamp),
    };
  }).filter((point) => Number.isFinite(point.value));
};

const SummaryCard = ({ title, value, valueClassName, trend, loading }) => (
  <div className="card bg-base-100 shadow-sm">
    <div className="card-body">
      {loading ? (
        <div className="space-y-3">
          <div className="skeleton h-4 w-24" />
          <div className="skeleton h-8 w-32" />
          <div className="skeleton h-4 w-20" />
        </div>
      ) : (
        <>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-base-content/70">
            {title}
          </h3>
          <p
            className={`text-3xl font-bold ${
              valueClassName ? valueClassName : "text-base-content"
            }`}
          >
            {value}
          </p>
          {trend ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className={`font-semibold ${trend.color}`}>
                {trend.value}
              </span>
              {trend.percent ? (
                <span className={`badge badge-sm ${trend.badge}`}>
                  {trend.percent}
                </span>
              ) : null}
              {trend.label ? (
                <span className="text-xs text-base-content/60">
                  {trend.label}
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  </div>
);

export default function Portfolio() {
  const { authFetch } = useAuth();
  const { currency: userCurrency, formatter: currencyFormatter } = useUserCurrency();
  const normalizedCurrency = useMemo(
    () => (userCurrency || "USD").toLowerCase(),
    [userCurrency]
  );
  const [usdConversion, setUsdConversion] = useState(1);
  const formatCurrency = useCallback(
    (value) => formatCurrencyWithFormatter(value, currencyFormatter),
    [currencyFormatter]
  );
  const formatSigned = useCallback(
    (value) => formatSignedCurrency(value, currencyFormatter),
    [currencyFormatter]
  );
  const [holdings, setHoldings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newCryptoId, setNewCryptoId] = useState("");
  const [newCryptoName, setNewCryptoName] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showSearchResults, setShowSearchResults] = useState(false);
  const [newQuantity, setNewQuantity] = useState("");
  const [newBuyPrice, setNewBuyPrice] = useState("");
  const [newTotalCost, setNewTotalCost] = useState("");
  const [selectedCoinPrice, setSelectedCoinPrice] = useState(null);
  const [addingCrypto, setAddingCrypto] = useState(false);
  const [flash, setFlash] = useState(null);
  const [realisedProfitBase, setRealisedProfitBase] = useState(0);
  const [chartTimeframe, setChartTimeframe] = useState("7"); // '7' for weekly, '30' for monthly
  const flashTimeoutRef = useRef(null);
  const searchContainerRef = useRef(null);
  const showFlash = useCallback((msg, kind = "info", duration = 2400) => {
    setFlash({ msg, kind });
    if (flashTimeoutRef.current) {
      clearTimeout(flashTimeoutRef.current);
    }
    if (duration) {
      flashTimeoutRef.current = setTimeout(() => setFlash(null), duration);
    }
  }, []);
  const [chartData, setChartData] = useState([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState(null);
  const activeTimeframe = TIMEFRAMES[chartTimeframe] ?? TIMEFRAMES["7"];
  const chartDays = activeTimeframe.days;
  
  // Sell modal state
  const [showSellModal, setShowSellModal] = useState(false);
  const [sellCryptoId, setSellCryptoId] = useState("");
  const [sellCryptoName, setSellCryptoName] = useState("");
  const [sellQuantity, setSellQuantity] = useState("");
  const [sellMaxQuantity, setSellMaxQuantity] = useState(0);
  const [sellQuotePrice, setSellQuotePrice] = useState(0);
  const [sellCostBasisUnit, setSellCostBasisUnit] = useState(0);
  const [sellingCrypto, setSellingCrypto] = useState(false);

  const realisedProfit = useMemo(() => {
    const base = Number(realisedProfitBase);
    const rate = Number(usdConversion);
    if (!Number.isFinite(base)) return 0;
    if (!Number.isFinite(rate) || rate <= 0) return base;
    return base * rate;
  }, [realisedProfitBase, usdConversion]);

  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current) {
        clearTimeout(flashTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const data = await fetchPortfolio(authFetch);
        setRealisedProfitBase(Number(data?.realised_total) || 0);
      } catch (e) {
        // ignore if fails
      }
    })();
  }, [authFetch]);

  useEffect(() => {
    if (!showSearchResults) return;
    const handleClickOutside = (event) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(event.target)) {
        setShowSearchResults(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showSearchResults]);

  useEffect(() => {
    let cancel = false;
    async function loadPortfolio() {
      // Only show loading spinner on initial load, not on refreshes
      const isInitialLoad = holdings.length === 0;
      if (isInitialLoad) setLoading(true);
      setError(null);
      
      try {
        const payload = await fetchPortfolio(authFetch);
        const apiHoldings = payload.holdings || [];
        const savedHoldings = normalizeHoldingsFromApi(apiHoldings);

        if (!savedHoldings.length) {
          if (!cancel) {
            setHoldings([]);
            if (isInitialLoad) setLoading(false);
          }
          return;
        }

        const ids = savedHoldings.map((h) => h.id).filter(Boolean);
        // Backend will cache this for 5 minutes, so frequent calls are OK
        const marketData = await fetchMarketsByIds({
          ids,
          vsCurrency: normalizedCurrency,
          priceChangePct: "24h,7d",
          sparkline: true,
        });

        const enrichedHoldings = mergeHoldingsWithMarket(
          savedHoldings,
          marketData,
          usdConversion,
          userCurrency
        );

        if (!cancel) setHoldings(enrichedHoldings);
      } catch (err) {
        console.error("Portfolio load error:", err);
        if (!cancel) setError(err.message || "Failed to load portfolio");
      } finally {
        if (!cancel && isInitialLoad) setLoading(false);
      }
    }
    loadPortfolio();
    // Refresh every 2 minutes (backend cache is 5 min, so we get cached data most of the time)
    const interval = setInterval(loadPortfolio, 2 * 60 * 1000);
    return () => {
      cancel = true;
      clearInterval(interval);
    };
  }, [authFetch, normalizedCurrency, usdConversion, userCurrency]);

  useEffect(() => {
    let cancel = false;
    async function loadConversion() {
      if (normalizedCurrency === "usd") {
        if (!cancel) setUsdConversion(1);
        return;
      }
      try {
        const data = await fetchMarketsByIds({
          ids: ["usd-coin"],
          vsCurrency: normalizedCurrency,
          sparkline: false,
        });
        const rate = Array.isArray(data) ? toFiniteNumber(data[0]?.current_price) : null;
        if (!cancel) {
          setUsdConversion(Number.isFinite(rate) && rate > 0 ? rate : 1);
        }
      } catch (error) {
        if (!cancel) setUsdConversion(1);
      }
    }
    loadConversion();
    return () => {
      cancel = true;
    };
  }, [normalizedCurrency]);

  // Search for coins as user types
  useEffect(() => {
    let cancel = false;

    async function performSearch() {
      if (!searchQuery.trim() || searchQuery.trim().length < 2) {
        setSearchResults([]);
        setShowSearchResults(false);
        return;
      }

      setSearchLoading(true);
      try {
        const results = await searchCoins(searchQuery);
        if (!cancel) {
          setSearchResults(results);
          setShowSearchResults(results.length > 0);
        }
      } catch (err) {
        console.error("Search error:", err);
        if (!cancel) {
          setSearchResults([]);
          setShowSearchResults(false);
        }
      } finally {
        if (!cancel) setSearchLoading(false);
      }
    }

    const timeoutId = setTimeout(performSearch, 300); // Debounce search
    return () => {
      cancel = true;
      clearTimeout(timeoutId);
    };
  }, [searchQuery]);

  // Handle selecting a coin from search results
  const handleSelectCoin = async (coin) => {
    setNewCryptoId(coin.id);
    setNewCryptoName(coin.name);
    setSearchQuery(coin.name);
    setShowSearchResults(false);
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    
    // Fetch current market price from backend (uses caching)
    try {
      const marketData = await fetchMarketsByIds({
        ids: [coin.id],
        vsCurrency: normalizedCurrency,
        priceChangePct: "24h,7d",
        sparkline: false,
      });
      
      if (marketData.length > 0 && marketData[0].current_price) {
        const currentPrice = marketData[0].current_price;
        setSelectedCoinPrice(currentPrice);
        setNewBuyPrice(currentPrice.toString());
        
        // If quantity is already entered, update total cost
        if (newQuantity) {
          const qty = parseFloat(newQuantity);
          if (!isNaN(qty) && qty > 0) {
            setNewTotalCost((qty * currentPrice).toFixed(2));
          }
        }
      }
    } catch (err) {
      console.error("Failed to fetch current price:", err);
      // Continue without auto-filling price
    }
  };

  // Clear modal state when closing
  const handleCloseModal = () => {
    setShowAddModal(false);
    setNewCryptoId("");
    setNewCryptoName("");
    setSearchQuery("");
    setSearchResults([]);
    setShowSearchResults(false);
    setNewQuantity("");
    setNewBuyPrice("");
    setNewTotalCost("");
    setSelectedCoinPrice(null);
  };

  // Handle quantity change - update total cost
  const handleQuantityChange = (value) => {
    setNewQuantity(value);
    const qty = parseFloat(value);
    const price = parseFloat(newBuyPrice);
    
    if (!isNaN(qty) && qty > 0 && !isNaN(price) && price > 0) {
      setNewTotalCost((qty * price).toFixed(2));
    } else {
      setNewTotalCost("");
    }
  };

  // Handle price change - update total cost
  const handlePriceChange = (value) => {
    setNewBuyPrice(value);
    const qty = parseFloat(newQuantity);
    const price = parseFloat(value);
    
    if (!isNaN(qty) && qty > 0 && !isNaN(price) && price > 0) {
      setNewTotalCost((qty * price).toFixed(2));
    } else {
      setNewTotalCost("");
    }
  };

  // Handle total cost change - update quantity
  const handleTotalCostChange = (value) => {
    setNewTotalCost(value);
    const total = parseFloat(value);
    const price = parseFloat(newBuyPrice);
    
    if (!isNaN(total) && total > 0 && !isNaN(price) && price > 0) {
      setNewQuantity((total / price).toFixed(8));
    } else {
      setNewQuantity("");
    }
  };

  const handleAddCrypto = async () => {
    if (!newCryptoId.trim() || !newQuantity || !newBuyPrice) {
      showFlash("Please fill all fields", "error");
      return;
    }
    const quantity = parseFloat(newQuantity);
    const buyPrice = parseFloat(newBuyPrice);
    if (isNaN(quantity) || quantity <= 0 || isNaN(buyPrice) || buyPrice <= 0) {
      showFlash("Invalid quantity or price", "error");
      return;
    }
    setAddingCrypto(true);
    try {
      const cryptoId = newCryptoId.trim().toLowerCase();
      // Preload selected coin market data to validate input and show success text
      const preMarketData = await fetchMarketsByIds({
        ids: [cryptoId],
        vsCurrency: normalizedCurrency,
        priceChangePct: "24h,7d",
        sparkline: true,
      });
      const selectedCoin = preMarketData.find((coin) => coin.id === cryptoId);

      if (!selectedCoin) {
        showFlash("Crypto not found. Check the ID.", "error");
        return;
      }
      await buyHolding(authFetch, { coin_id: cryptoId, quantity, price: buyPrice, currency: userCurrency });
      const updatedPayload = await fetchPortfolio(authFetch);
      const updatedHoldings = normalizeHoldingsFromApi(updatedPayload.holdings || []);
      const ids = Array.from(new Set(updatedHoldings.map((h) => h.id).filter(Boolean)));
      const marketData = ids.length
        ? await fetchMarketsByIds({ ids, vsCurrency: normalizedCurrency, priceChangePct: "24h,7d", sparkline: true })
        : [];
      const enrichedHoldings = mergeHoldingsWithMarket(
        updatedHoldings,
        marketData,
        usdConversion,
        userCurrency
      );
      setHoldings(enrichedHoldings);
      setRealisedProfitBase(Number(updatedPayload?.realised_total) || 0);
      setShowAddModal(false);
      setNewCryptoId("");
      setNewCryptoName("");
      setSearchQuery("");
      setSearchResults([]);
      setShowSearchResults(false);
      setNewQuantity("");
      setNewBuyPrice("");
      setNewTotalCost("");
      setSelectedCoinPrice(null);
      showFlash(
        `${selectedCoin.name || selectedCoin.id} added to portfolio`,
        "success"
      );
    } catch (err) {
      showFlash(err.message || "Failed to add crypto", "error");
    } finally {
      setAddingCrypto(false);
    }
  };

  const handleOpenSell = (holding) => {
    setSellCryptoId(holding.id);
    setSellCryptoName(holding.name || holding.id);
    setSellMaxQuantity(holding.quantity);
    setSellQuotePrice(holding.currentPrice ?? 0);
    setSellCostBasisUnit(holding.avgBuyPrice ?? 0);
    setSellQuantity("");
    setShowSellModal(true);
  };

  const handleSellCrypto = async () => {
    if (!sellQuantity || parseFloat(sellQuantity) <= 0) {
      showFlash("Please enter a valid quantity", "error");
      return;
    }

    const quantity = parseFloat(sellQuantity);
    if (quantity > sellMaxQuantity) {
      showFlash("Insufficient quantity", "error");
      return;
    }

    setSellingCrypto(true);
    try {
      await sellHoldingApi(authFetch, { coin_id: sellCryptoId, quantity, price: sellQuotePrice, currency: userCurrency });
      const payload = await fetchPortfolio(authFetch);
      const savedHoldings = normalizeHoldingsFromApi(payload.holdings || []);
      if (savedHoldings.length === 0) {
        setHoldings([]);
        setRealisedProfitBase(Number(payload?.realised_total) || 0);
        setShowSellModal(false);
        showFlash("Sold all holdings!", "success");
        return;
      }

      const ids = savedHoldings.map((h) => h.id).filter(Boolean);
      const allMarketData = await fetchMarketsByIds({
        ids,
        vsCurrency: normalizedCurrency,
        priceChangePct: "24h,7d",
        sparkline: true,
      });

      const enrichedHoldings = mergeHoldingsWithMarket(
        savedHoldings,
        allMarketData,
        usdConversion,
        userCurrency
      );

      setHoldings(enrichedHoldings);
      setRealisedProfitBase(Number(payload?.realised_total) || 0);
      setShowSellModal(false);
      setSellCryptoId("");
      setSellCryptoName("");
      setSellQuantity("");
      setSellMaxQuantity(0);
      setSellQuotePrice(0);
      setSellCostBasisUnit(0);
      showFlash(`Sold ${quantity} units!`, "success");
    } catch (err) {
      showFlash(err.message || "Failed to sell", "error");
    } finally {
      setSellingCrypto(false);
    }
  };

  const hasHoldings = holdings.length > 0;
  const portfolioValue = useMemo(() => {
    return holdings.reduce(
      (total, holding) => total + holding.quantity * holding.currentPrice,
      0
    );
  }, [holdings]);
  const totalInvested = useMemo(() => {
    return holdings.reduce(
      (total, holding) => total + holding.quantity * holding.avgBuyPrice,
      0
    );
  }, [holdings]);
  const totalProfitLoss = portfolioValue - totalInvested;
  const profitLossPercent =
    totalInvested > 0 ? (totalProfitLoss / totalInvested) * 100 : 0;
  const holdingsCount = holdings.length;
  const averagePositionValue =
    holdingsCount > 0 ? portfolioValue / holdingsCount : 0;
  const lifetimeProfit = realisedProfit + totalProfitLoss;
  const portfolio24hChange = useMemo(() => {
    return holdings.reduce((total, holding) => {
      const change24h = holding.ch24h || 0;
      const value = holding.quantity * holding.currentPrice;
      return total + (value * change24h) / 100;
    }, 0);
  }, [holdings]);
  const portfolio24hChangePercent =
    portfolioValue > 0 ? (portfolio24hChange / portfolioValue) * 100 : 0;

  // Create a stable key for holdings to prevent unnecessary chart refetches
  const holdingsKey = useMemo(() => {
    if (!holdings.length) return "";
    return holdings
      .map((h) => `${h.id}:${h.quantity}`)
      .sort()
      .join(",");
  }, [holdings]);

  // Fetch portfolio performance chart data based on timeframe
  useEffect(() => {
    let cancel = false;

    async function fetchChartData() {
      if (!hasHoldings || holdings.length === 0) {
        const now = Date.now();
        setChartLoading(false);
        setChartError(null);
        setChartData([
          {
            timestamp: now,
            value: 0,
            invested: 0,
            date: formatChartLabel(now),
          },
        ]);
        return;
      }

      setChartError(null);
      setChartLoading(true);
      try {
        const totalCostBasis = holdings.reduce(
          (acc, holding) =>
            acc +
            (toFiniteNumber(holding.quantity) ?? 0) *
              (toFiniteNumber(holding.avgBuyPrice) ?? 0),
          0
        );

        let hadChartErrors = false;
        const chartPromises = holdings.map((holding) =>
          fetchMarketChart({
            id: holding.id,
            vsCurrency: normalizedCurrency,
            days: chartDays.toString(),
            interval: "daily",
          }).catch((err) => {
            console.error(`Failed to fetch market chart for ${holding.id}:`, err);
            hadChartErrors = true;
            return [];
          })
        );
        let allChartData = await Promise.all(chartPromises);

        // Fall back to sparkline data if market chart is unavailable
        allChartData = allChartData.map((data, idx) => {
          if (Array.isArray(data) && data.length > 0) return data;
          const holding = holdings[idx];
          if (!holding?.sparkline || holding.sparkline.length === 0) return [];
          const nowTs = Date.now();
          const spanSteps = Math.max(holding.sparkline.length - 1, 1);
          const stepMs =
            (chartDays * 24 * 60 * 60 * 1000) / spanSteps;
          return holding.sparkline.map((price, i) => [
            nowTs - (holding.sparkline.length - 1 - i) * stepMs,
            price,
          ]);
        });

        const nowTs = Date.now();
        const nowBucket = bucketTimestamp(nowTs);
        const windowStart = nowTs - (chartDays - 1) * 24 * 60 * 60 * 1000;

        // Build portfolio unrealised profit map: sum(quantity * (price_t - avgBuyPrice))
        const portfolioProfitMap = new Map();
        const allTimestamps = new Set();

        holdings.forEach((holding, index) => {
          if (!holding) return;
          const qty = toFiniteNumber(holding.quantity) ?? 0;
          const avg = toFiniteNumber(holding.avgBuyPrice) ?? 0;
          if (!Number.isFinite(qty) || qty <= 0) return;

          const coinData = Array.isArray(allChartData?.[index])
            ? allChartData[index]
            : [];

          const priceByTimestamp = new Map();
          coinData.forEach((point) => {
            if (!Array.isArray(point) || point.length < 2) return;
            const timestamp = bucketTimestamp(point[0]);
            if (timestamp == null || timestamp < windowStart) return;
            const price = toFiniteNumber(point[1]);
            if (!Number.isFinite(price)) return;
            priceByTimestamp.set(timestamp, price);
          });

          if (!priceByTimestamp.size) return;

          const sortedPriceEntries = Array.from(priceByTimestamp.entries()).sort(
            (a, b) => a[0] - b[0]
          );

          sortedPriceEntries.forEach(([timestamp, price]) => {
            allTimestamps.add(timestamp);
            const profitContribution = qty * (price - avg);
            portfolioProfitMap.set(
              timestamp,
              (portfolioProfitMap.get(timestamp) ?? 0) + profitContribution
            );
          });

          const currentPrice = toFiniteNumber(holding.currentPrice);
          if (Number.isFinite(currentPrice)) {
            allTimestamps.add(nowBucket);
            const currentProfit = qty * (currentPrice - avg);
            portfolioProfitMap.set(
              nowBucket,
              (portfolioProfitMap.get(nowBucket) ?? 0) + currentProfit
            );
          }
        });

        if (!portfolioProfitMap.has(nowBucket)) {
          const currentProfit = holdings.reduce((total, holding) => {
            const qty = toFiniteNumber(holding.quantity) ?? 0;
            const avg = toFiniteNumber(holding.avgBuyPrice) ?? 0;
            const currentPrice = toFiniteNumber(holding.currentPrice);
            if (!Number.isFinite(qty) || qty <= 0) return total;
            const price = Number.isFinite(currentPrice) ? currentPrice : avg;
            return total + qty * (price - avg);
          }, 0);
          if (Number.isFinite(currentProfit)) {
            allTimestamps.add(nowBucket);
            portfolioProfitMap.set(nowBucket, currentProfit);
          }
        }

        const sortedTimestamps = Array.from(allTimestamps)
          .filter((timestamp) => timestamp >= windowStart)
          .sort((a, b) => a - b);

        let chartArray = sortedTimestamps
          .map((timestamp) => ({
            timestamp,
            value: portfolioProfitMap.get(timestamp) ?? 0,
            invested: 0,
            date: formatChartLabel(timestamp),
          }))
          .filter((point) => Number.isFinite(point.value));

        if (!chartArray.length) {
          const base = buildPortfolioFallbackSeries(holdings, chartDays);
          const totalCostBasis = holdings.reduce(
            (acc, h) =>
              acc +
                (toFiniteNumber(h.quantity) ?? 0) *
                (toFiniteNumber(h.avgBuyPrice) ?? 0),
            0
          );
          chartArray = base.map((point) => ({
            ...point,
            value: point.value - totalCostBasis,
            invested: totalCostBasis,
          }));
        }

        if (chartArray.length) {
          const baseline = chartArray[chartArray.length - 1].value ?? 0;
          chartArray = chartArray.map((point) => ({
            ...point,
            value: baseline - point.value,
          }));
        }

        setChartError(
          chartArray.length
            ? null
            : hadChartErrors
            ? "Unable to load chart data right now"
            : "No unrealised profit data available yet"
        );

        if (!cancel) {
          setChartData(chartArray);
        }
      } catch (error) {
        console.error("Error fetching chart data:", error);
        if (!cancel) {
          setChartError(error.message || "Failed to load profit chart");
          setChartData([]);
        }
      } finally {
        if (!cancel) {
          setChartLoading(false);
        }
      }
    }

    fetchChartData();
    return () => {
      cancel = true;
    };
  }, [holdingsKey, hasHoldings, chartTimeframe, holdings, chartDays, normalizedCurrency]);

  const chartPerformanceChange = useMemo(() => {
    if (!chartData.length) return 0;
    const firstPoint = chartData[0];
    return Number.isFinite(firstPoint?.value) ? firstPoint.value : 0;
  }, [chartData]);

  const estimatedSellProceeds = useMemo(() => {
    const qty = parseFloat(sellQuantity);
    if (!Number.isFinite(qty) || qty <= 0) return null;
    const price = Number.isFinite(sellQuotePrice) ? sellQuotePrice : null;
    if (price == null || price <= 0) return null;
    return qty * price;
  }, [sellQuantity, sellQuotePrice]);
  const estimatedSellProfit = useMemo(() => {
    const qty = parseFloat(sellQuantity);
    if (!Number.isFinite(qty) || qty <= 0) return null;
    const proceeds = estimatedSellProceeds;
    if (proceeds == null) return null;
    const costBasisUnit = Number.isFinite(sellCostBasisUnit)
      ? sellCostBasisUnit
      : null;
    if (costBasisUnit == null || costBasisUnit < 0) return null;
    return proceeds - qty * costBasisUnit;
  }, [sellQuantity, estimatedSellProceeds, sellCostBasisUnit]);

  const chartDataset = useMemo(() => {
    const positiveStroke = "#10b981";
    const negativeStroke = "#ef4444";
    const areaAbove = "rgba(16, 185, 129, 0.18)";
    const areaBelow = "rgba(239, 68, 68, 0.18)";

    return {
      labels: chartData.map((point) => point.date),
      datasets: [
        {
          label: "Unrealised Profit",
          data: chartData.map((point) => point.value),
          borderColor: (ctx) =>
            (ctx.parsed?.y ?? 0) >= 0 ? positiveStroke : negativeStroke,
          pointBackgroundColor: (ctx) =>
            (ctx.parsed?.y ?? 0) >= 0 ? positiveStroke : negativeStroke,
          pointBorderColor: (ctx) =>
            (ctx.parsed?.y ?? 0) >= 0 ? positiveStroke : negativeStroke,
          pointHoverBackgroundColor: (ctx) =>
            (ctx.parsed?.y ?? 0) >= 0 ? positiveStroke : negativeStroke,
          pointHoverBorderColor: (ctx) =>
            (ctx.parsed?.y ?? 0) >= 0 ? positiveStroke : negativeStroke,
          fill: {
            target: "origin",
            above: areaAbove,
            below: areaBelow,
          },
          tension: 0.35,
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 4,
          segment: {
            borderColor: (ctx) =>
              (ctx.p1.parsed?.y ?? 0) >= 0 ? positiveStroke : negativeStroke,
          },
        },
      ],
    };
  }, [chartData]);

  const chartOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false,
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context) =>
              `Unrealised Profit: ${formatSigned(context.parsed.y)}`,
          },
          backgroundColor: "rgba(0, 0, 0, 0.8)",
          padding: 10,
          cornerRadius: 8,
        },
      },
      scales: {
        x: {
          display: true,
          grid: { display: false },
          ticks: {
            maxRotation: 0,
            autoSkipPadding: 20,
            color: "#cbd5f5",
          },
        },
        y: {
          display: true,
          grid: {
            color: (ctx) =>
              ctx.tick.value === 0
                ? "rgba(148, 163, 184, 0.35)"
                : "rgba(148, 163, 184, 0.15)",
            drawBorder: false,
          },
          ticks: {
            color: "#cbd5f5",
            callback: (value) => formatCurrency(value),
          },
        },
      },
    }),
    []
  );

  return (
    <div className="min-h-screen bg-base-200">
      <div className="mx-auto max-w-6xl px-6 py-10">
        {flash && (
          <div className="toast toast-top toast-center z-50">
            <div
              className={`alert ${flash.kind === "success" ? "alert-success" : flash.kind === "error" ? "alert-error" : "alert-info"}`}
            >
              <span>{flash.msg}</span>
            </div>
          </div>
        )}
        <header className="mb-8 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-primary">
              Portfolio
            </p>
            <h1 className="text-3xl font-bold text-base-content md:text-4xl">
              Your Portfolio
            </h1>
            <p className="text-base text-base-content/70">
              Track your crypto holdings with live prices and profit/loss.
            </p>
          </div>
          <button
            className="btn btn-primary btn-sm md:btn-md"
            onClick={() => setShowAddModal(true)}
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            Add Crypto
          </button>
        </header>
        <section className="mb-6 grid gap-4 md:grid-cols-2">
          <div className="card bg-base-100 shadow-sm">
            <div className="card-body">
              {loading ? (
                <div className="space-y-3">
                  <div className="skeleton h-4 w-32" />
                  <div className="skeleton h-10 w-40" />
                  <div className="skeleton h-4 w-24" />
                </div>
              ) : (
                <>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-base-content/70">
                        Portfolio Value
                      </p>
                      <p className="mt-1 text-3xl font-bold text-base-content">
                        {formatCurrency(portfolioValue)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className={`text-sm font-semibold ${getTrendTone(portfolio24hChange)}`}>
                        {formatSigned(portfolio24hChange)}
                      </p>
                      <p className="text-xs text-base-content/60">
                        24h change · {formatSignedPercent(portfolio24hChangePercent) ?? "—"}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-lg border border-base-200 px-3 py-3">
                      <p className="text-[11px] uppercase tracking-wide text-base-content/60">
                        Holdings
                      </p>
                      <p className="mt-1 text-lg font-semibold text-base-content">
                        {integerFormatter.format(holdingsCount)}
                      </p>
                      <p className="text-xs text-base-content/50">Assets tracked</p>
                    </div>
                    <div className="rounded-lg border border-base-200 px-3 py-3">
                      <p className="text-[11px] uppercase tracking-wide text-base-content/60">
                        Invested
                      </p>
                      <p className="mt-1 text-lg font-semibold text-base-content">
                        {formatCurrency(totalInvested)}
                      </p>
                      <p className="text-xs text-base-content/50">Total cost basis</p>
                    </div>
                    <div className="rounded-lg border border-base-200 px-3 py-3">
                      <p className="text-[11px] uppercase tracking-wide text-base-content/60">
                        Avg position
                      </p>
                      <p className="mt-1 text-lg font-semibold text-base-content">
                        {formatCurrency(averagePositionValue)}
                      </p>
                      <p className="text-xs text-base-content/50">Per holding value</p>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-base-content/60">
                    <span className="uppercase tracking-wide">Status</span>
                    <span className={`badge badge-sm ${getBadgeTone(portfolio24hChange)}`}>
                      {portfolio24hChange >= 0 ? "Up" : "Down"} today
                    </span>
                    <span> · </span>
                    <span>Updated moments ago</span>
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="card bg-base-100 shadow-sm">
            <div className="card-body">
              {loading ? (
                <div className="space-y-3">
                  <div className="skeleton h-4 w-24" />
                  <div className="skeleton h-8 w-32" />
                  <div className="skeleton h-4 w-20" />
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-base-content/70">
                        Profit Overview
                      </p>
                      <p className={`mt-1 text-2xl font-bold ${getTrendTone(lifetimeProfit)}`}>
                        {formatSigned(lifetimeProfit)}
                      </p>
                      <p className="text-xs text-base-content/60">Lifetime total</p>
                    </div>
                    <span className={`badge badge-lg ${getBadgeTone(lifetimeProfit)}`}>
                      {lifetimeProfit >= 0 ? "Net Gain" : "Net Loss"}
                    </span>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border border-base-200 px-3 py-3">
                      <p className="text-[11px] uppercase tracking-wide text-base-content/60">
                        Realised
                      </p>
                      <p className={`mt-1 text-lg font-semibold ${getTrendTone(realisedProfit)}`}>
                        {formatSigned(realisedProfit)}
                      </p>
                      <p className="text-xs text-base-content/50">
                        Locked in from sales
                      </p>
                    </div>
                    <div className="rounded-lg bg-base-200/60 px-3 py-3">
                      <div className="flex items-center justify-between">
                        <p className="text-[11px] uppercase tracking-wide text-base-content/60">
                          Unrealised
                        </p>
                        <span className={`badge badge-sm ${getBadgeTone(totalProfitLoss)}`}>
                          {formatSignedPercent(profitLossPercent) ?? "—"}
                        </span>
                      </div>
                      <p className={`mt-1 text-lg font-semibold ${getTrendTone(totalProfitLoss)}`}>
                        {formatSigned(totalProfitLoss)}
                      </p>
                      <p className="text-xs text-base-content/50">
                        Current open P/L
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 rounded-lg bg-base-200/80 px-3 py-2 text-[11px] text-base-content/60">
                    <div className="flex items-center justify-between">
                      <span>Cost basis</span>
                      <span className="font-medium text-base-content">
                        {formatCurrency(totalInvested)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between">
                      <span>Portfolio value</span>
                      <span className="font-medium text-base-content">
                        {formatCurrency(portfolioValue)}
                      </span>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </section>

        {/* Portfolio Performance Chart */}
        {!loading && (
          <section className="card bg-base-100 shadow mb-6">
            <div className="card-body">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-4">
                <div>
                  <h2 className="text-lg font-bold text-base-content">
                    Portfolio Performance
                  </h2>
                  <p className="text-sm text-base-content/70">
                    {hasHoldings
                      ? "Track your unrealised profit after each purchase"
                      : "Add holdings to see profit changes over time"}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {/* Timeframe Toggle Buttons */}
                  <div className="join">
                    {Object.entries(TIMEFRAMES).map(([key, meta]) => (
                      <button
                        key={key}
                        type="button"
                        className={`btn btn-sm join-item ${
                          chartTimeframe === key ? "btn-primary" : "btn-ghost"
                        }`}
                        onClick={() => setChartTimeframe(key)}
                      >
                        {meta.buttonLabel}
                      </button>
                    ))}
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-base-content/60">
                      {activeTimeframe.label} Unrealised Profit Change
                    </p>
                    <p className={`text-xl font-bold ${getTrendTone(chartPerformanceChange)}`}>
                      {formatSigned(chartPerformanceChange)}
                    </p>
                  </div>
                  <span
                    className={`badge ${getBadgeTone(chartPerformanceChange)}`}
                  >
                    {chartPerformanceChange >= 0 ? "↑" : "↓"}
                  </span>
                </div>
              </div>

              {/* Chart Area */}
              <div className="h-64 w-full">
                {chartLoading ? (
                  <div className="flex items-center justify-center h-full">
                    <span className="loading loading-spinner loading-lg text-primary" />
                  </div>
                ) : chartData.length > 0 ? (
                  <Line data={chartDataset} options={chartOptions} />
                ) : (
                  <div className="flex items-center justify-center h-full text-base-content/50">
                    <p className="text-sm">
                      {chartError || "No unrealised profit data available"}
                    </p>
                  </div>
                )}
              </div>

              <div className="text-xs text-base-content/50 text-center mt-2">
                Daily unrealised profit change across the {activeTimeframe.description}
              </div>
            </div>
          </section>
        )}

        {error && (
          <div className="alert alert-error mb-6">
            <svg
              className="h-6 w-6 shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <div className="flex-1">
              <h3 className="font-bold">Failed to load portfolio</h3>
              <div className="text-sm">{error}</div>
              <div className="text-xs mt-1 opacity-75">
                This might be due to API rate limiting or network issues. Check
                the console for details.
              </div>
            </div>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => window.location.reload()}
            >
              Retry
            </button>
          </div>
        )}
        <section className="card bg-base-100 shadow">
          <div className="card-body gap-6">
            <div className="flex flex-col gap-2">
              <h2 className="card-title text-base-content">Holdings</h2>
              <p className="text-sm text-base-content/70">
                Your positions with cost basis and unrealised P/L.
              </p>
            </div>
            <div className="hidden lg:block">
              <div className="overflow-x-auto rounded-lg">
                <table className="table">
                  <thead>
                    <tr>
                      <th className="w-1/4">Asset</th>
                      <th className="w-1/4 text-right">Position</th>
                      <th className="hidden md:table-cell w-1/5 text-right">Change</th>
                      <th className="w-1/4 text-right">Trend</th>
                      <th className="text-right sticky right-0 bg-base-100">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      Array.from({ length: 3 }).map((_, index) => (
                        <tr key={index}>
                          <td>
                            <div className="flex items-center gap-3">
                              <div className="skeleton h-10 w-10 rounded-full" />
                              <div className="space-y-2">
                                <div className="skeleton h-4 w-32" />
                                <div className="skeleton h-3 w-24" />
                              </div>
                            </div>
                          </td>
                          <td>
                            <div className="ml-auto flex flex-col items-end gap-3">
                              <div className="skeleton h-4 w-24 rounded" />
                              <div className="skeleton h-3 w-24 rounded" />
                              <div className="skeleton h-3 w-20 rounded" />
                            </div>
                          </td>
                          <td className="hidden md:table-cell">
                            <div className="ml-auto flex flex-col items-end gap-2">
                              <div className="skeleton h-4 w-16 rounded" />
                              <div className="skeleton h-4 w-16 rounded" />
                            </div>
                          </td>
                          <td>
                            <div className="ml-auto flex flex-col items-end gap-2">
                              <div className="skeleton h-4 w-24 rounded" />
                              <div className="skeleton h-12 w-32 rounded" />
                            </div>
                          </td>
                          <td className="sticky right-0 bg-base-100">
                            <div className="ml-auto h-8 w-20 rounded skeleton" />
                          </td>
                        </tr>
                      ))
                    ) : hasHoldings ? (
                      holdings.map((holding) => {
                        const totalValue =
                          holding.quantity * holding.currentPrice;
                        const totalCost = holding.quantity * holding.avgBuyPrice;
                        const profitLoss = totalValue - totalCost;
                        const plPercent =
                          totalCost > 0 ? (profitLoss / totalCost) * 100 : 0;
                        const sparklineHasData =
                          Array.isArray(holding.sparkline) && holding.sparkline.length > 1;
                        const sparklineStart = sparklineHasData
                          ? toFiniteNumber(holding.sparkline[0])
                          : null;
                        const sparklineEnd = sparklineHasData
                          ? toFiniteNumber(
                              holding.sparkline[holding.sparkline.length - 1]
                            )
                          : null;
                        const sparklineTrend =
                          sparklineHasData &&
                          sparklineStart != null &&
                          sparklineEnd != null
                            ? sparklineEnd >= sparklineStart
                            : false;
                        const sparklineColor =
                          Number.isFinite(holding.ch7d) && holding.ch7d !== 0
                            ? holding.ch7d > 0
                              ? "#22c55e"
                              : "#ef4444"
                            : sparklineTrend
                            ? "#22c55e"
                            : "#ef4444";
                        return (
                          <tr key={holding.id}>
                            <td className="align-top">
                              <div className="flex items-center gap-4">
                                {holding.image ? (
                                  <img
                                    src={holding.image}
                                    alt={holding.name}
                                    className="h-12 w-12 rounded-full border border-base-200"
                                  />
                                ) : (
                                  <div className="avatar placeholder">
                                    <div className="w-12 rounded-full bg-primary/10 text-primary">
                                      <span className="text-xs font-semibold">
                                        {holding.symbol}
                                      </span>
                                    </div>
                                  </div>
                                )}
                                <div className="space-y-1">
                                  <div className="text-sm font-semibold text-base-content">
                                    {holding.name}
                                  </div>
                                  <div className="flex items-center gap-2 text-xs uppercase text-base-content/60">
                                    {holding.symbol}
                                    <span className="badge badge-ghost badge-xs capitalize">
                                      {holding.category || "Crypto"}
                                    </span>
                                  </div>
                                  <div className="text-xs text-base-content/60">
                                    Added{" "}
                                    {new Date(holding.createdAt).toLocaleDateString("en-AU", {
                                      month: "short",
                                      day: "numeric",
                                      year: "numeric",
                                    })}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="align-top">
                              <div className="flex flex-col items-end gap-2">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-sm">
                                    {quantityFormatter.format(holding.quantity)}
                                  </span>
                                  <span className="badge badge-outline badge-sm">
                                    units
                                  </span>
                                </div>
                                <div className="flex flex-col text-xs text-base-content/60">
                                  <span>Avg buy: {formatCurrency(holding.avgBuyPrice)}</span>
                                  <span>Current: {formatCurrency(holding.currentPrice)}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="text-xs uppercase text-base-content/60">
                                    Value
                                  </span>
                                  <span className="text-sm font-semibold text-base-content">
                                    {formatCurrency(totalValue)}
                                  </span>
                                </div>
                              </div>
                            </td>
                            <td className="hidden md:table-cell align-top">
                              <div className="flex flex-col items-end gap-2">
                                <span className={`badge badge-outline badge-sm ${getBadgeTone(holding.ch24h)}`}>
                                  24h{" "}
                                  {holding.ch24h == null
                                    ? "—"
                                    : `${holding.ch24h >= 0 ? "+" : ""}${holding.ch24h.toFixed(2)}%`}
                                </span>
                                <span className={`badge badge-outline badge-sm ${getBadgeTone(holding.ch7d)}`}>
                                  7d{" "}
                                  {holding.ch7d == null
                                    ? "—"
                                    : `${holding.ch7d >= 0 ? "+" : ""}${holding.ch7d.toFixed(2)}%`}
                                </span>
                                <span className={`badge badge-ghost badge-sm ${getBadgeTone(plPercent)}`}>
                                  {formatSignedPercent(plPercent) ?? "—"} total
                                </span>
                              </div>
                            </td>
                            <td className="align-top">
                              <div className="flex flex-col items-end gap-3">
                                <div className="flex items-center gap-2">
                                  <span className="text-xs uppercase text-base-content/60">
                                    Profit
                                  </span>
                                  <span
                                    className={`text-sm font-semibold ${getTrendTone(profitLoss)}`}
                                  >
                                    {formatSigned(profitLoss)}
                                  </span>
                                </div>
                                <div className="flex items-center gap-2 text-xs text-base-content/60">
                                  <span>Since buy</span>
                                  <span className={`font-medium ${getTrendTone(plPercent)}`}>
                                    {formatSignedPercent(plPercent) ?? "—"}
                                  </span>
                                </div>
                                <div className="h-16 w-40 rounded-md bg-base-200/60 px-2 py-1">
                                  {sparklineHasData ? (
                                    <Line
                                      data={{
                                        labels: holding.sparkline.map((_, i) => i),
                                        datasets: [
                                          {
                                            data: holding.sparkline,
                                            borderColor: sparklineColor,
                                            borderWidth: 1.5,
                                            fill: false,
                                            tension: 0.4,
                                            pointRadius: 0,
                                          },
                                        ],
                                      }}
                                      options={SPARKLINE_OPTIONS}
                                    />
                                  ) : (
                                    <div className="flex h-full items-center justify-center text-xs text-base-content/50">
                                      No trend data
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className="sticky right-0 bg-base-100 text-right">
                              <button
                                className="btn btn-xs btn-warning"
                                onClick={() => handleOpenSell(holding)}
                              >
                                Sell
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan={5}>
                          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                            <svg
                              className="h-12 w-12 text-base-content/30"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={1.5}
                                d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                              />
                            </svg>
                            <p className="text-sm font-semibold text-base-content/80">
                              No holdings yet
                            </p>
                            <p className="text-xs text-base-content/60">
                              Click "Add Crypto" to start tracking your portfolio.
                            </p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile / Tablet layout */}
            <div className="lg:hidden space-y-4">
              {loading ? (
                Array.from({ length: 3 }).map((_, index) => (
                  <div key={index} className="card bg-base-100 shadow-sm">
                    <div className="card-body space-y-4">
                      <div className="flex items-center gap-3">
                        <div className="skeleton h-12 w-12 rounded-full" />
                        <div className="flex-1 space-y-2">
                          <div className="skeleton h-4 w-2/3 rounded" />
                          <div className="skeleton h-3 w-1/3 rounded" />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                          <div className="skeleton h-3 w-20 rounded" />
                          <div className="skeleton h-3 w-24 rounded" />
                        </div>
                        <div className="space-y-2">
                          <div className="skeleton h-3 w-20 rounded" />
                          <div className="skeleton h-3 w-24 rounded" />
                        </div>
                      </div>
                      <div className="skeleton h-12 w-full rounded" />
                      <div className="flex justify-end">
                        <div className="skeleton h-8 w-24 rounded" />
                      </div>
                    </div>
                  </div>
                ))
              ) : hasHoldings ? (
                holdings.map((holding) => {
                  const totalValue = holding.quantity * holding.currentPrice;
                  const totalCost = holding.quantity * holding.avgBuyPrice;
                  const profitLoss = totalValue - totalCost;
                  const plPercent = totalCost > 0 ? (profitLoss / totalCost) * 100 : 0;
                  const sparklineHasData =
                    Array.isArray(holding.sparkline) && holding.sparkline.length > 1;
                  const sparklineStart = sparklineHasData
                    ? toFiniteNumber(holding.sparkline[0])
                    : null;
                  const sparklineEnd = sparklineHasData
                    ? toFiniteNumber(
                        holding.sparkline[holding.sparkline.length - 1]
                      )
                    : null;
                  const sparklineTrend =
                    sparklineHasData &&
                    sparklineStart != null &&
                    sparklineEnd != null
                      ? sparklineEnd >= sparklineStart
                      : false;
                  const sparklineColor =
                    Number.isFinite(holding.ch7d) && holding.ch7d !== 0
                      ? holding.ch7d > 0
                        ? "#22c55e"
                        : "#ef4444"
                      : sparklineTrend
                      ? "#22c55e"
                      : "#ef4444";

                  return (
                    <div key={holding.id} className="card bg-base-100 shadow-sm">
                      <div className="card-body space-y-4">
                        <div className="flex items-center gap-3">
                          {holding.image ? (
                            <img
                              src={holding.image}
                              alt={holding.name}
                              className="h-12 w-12 rounded-full"
                            />
                          ) : (
                            <div className="avatar placeholder">
                              <div className="w-12 rounded-full bg-primary/10 text-primary">
                                <span className="text-sm font-semibold">
                                  {holding.symbol}
                                </span>
                              </div>
                            </div>
                          )}
                          <div>
                            <h3 className="font-semibold text-base">{holding.name}</h3>
                            <p className="text-xs uppercase text-base-content/60">
                              {holding.symbol}
                            </p>
                          </div>
                          <div className="ml-auto text-right">
                            <p className="text-sm font-semibold text-base-content">
                              {formatCurrency(totalValue)}
                            </p>
                            <p className="text-xs text-base-content/60">
                              {quantityFormatter.format(holding.quantity)} units
                            </p>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4 text-sm">
                          <div className="space-y-1">
                            <p className="text-xs text-base-content/60">Avg buy</p>
                            <p className="font-mono text-sm">{formatCurrency(holding.avgBuyPrice)}</p>
                          </div>
                          <div className="space-y-1 text-right">
                            <p className="text-xs text-base-content/60">Current</p>
                            <p className="font-mono text-sm">{formatCurrency(holding.currentPrice)}</p>
                          </div>
                          <div className="space-y-1">
                            <p className="text-xs text-base-content/60">24h change</p>
                            <span className={`badge badge-sm ${getBadgeTone(holding.ch24h)}`}>
                              {holding.ch24h == null
                                ? "—"
                                : `${holding.ch24h >= 0 ? "+" : ""}${holding.ch24h.toFixed(2)}%`}
                            </span>
                          </div>
                          <div className="space-y-1 text-right">
                            <p className="text-xs text-base-content/60">7d change</p>
                            <span className={`badge badge-sm ${getBadgeTone(holding.ch7d)}`}>
                              {holding.ch7d == null
                                ? "—"
                                : `${holding.ch7d >= 0 ? "+" : ""}${holding.ch7d.toFixed(2)}%`}
                            </span>
                          </div>
                        </div>

                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-xs text-base-content/60">Unrealised P/L</p>
                              <p
                                className={`font-mono text-sm font-semibold ${getTrendTone(profitLoss)}`}
                              >
                                {formatSigned(profitLoss)}
                              </p>
                            </div>
                            <span className={`badge badge-sm ${getBadgeTone(profitLoss)}`}>
                              {formatSignedPercent(plPercent) ?? "—"}
                            </span>
                          </div>
                          <div className="h-20">
                            {sparklineHasData ? (
                              <Line
                                data={{
                                  labels: holding.sparkline.map((_, i) => i),
                                  datasets: [
                                    {
                                      data: holding.sparkline,
                                      borderColor: sparklineColor,
                                      borderWidth: 1.5,
                                      fill: false,
                                      tension: 0.4,
                                      pointRadius: 0,
                                    },
                                  ],
                                }}
                                options={{
                                  responsive: true,
                                  maintainAspectRatio: false,
                                  animation: false,
                                  plugins: {
                                    legend: { display: false },
                                    tooltip: { enabled: false },
                                  },
                                  scales: {
                                    x: { display: false },
                                    y: { display: false },
                                  },
                                  elements: {
                                    line: { borderJoinStyle: "round" },
                                    point: { radius: 0 },
                                  },
                                }}
                              />
                            ) : (
                              <div className="flex h-full items-center justify-center text-xs text-base-content/50">
                                No chart data
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="flex justify-end">
                          <button
                            className="btn btn-sm btn-warning"
                            onClick={() => handleOpenSell(holding)}
                          >
                            Sell holdings
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="card bg-base-100 shadow-sm">
                  <div className="card-body items-center text-center">
                    <svg
                      className="h-12 w-12 text-base-content/30"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    <p className="text-sm font-semibold text-base-content/80">
                      No holdings yet
                    </p>
                    <p className="text-xs text-base-content/60">
                      Tap "Add Crypto" to start building your portfolio.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
        {showAddModal && (
          <div className="modal modal-open">
            <div className="modal-box">
              <h3 className="font-bold text-lg mb-4">
                Add Crypto to Portfolio
              </h3>

              {/* Crypto Search with Autocomplete */}
              <div className="form-control mb-4">
                <label className="label">
                  <span className="label-text">Search Cryptocurrency</span>
                </label>
                <div className="relative" ref={searchContainerRef}>
                  <input
                    type="text"
                    placeholder="Type to search (e.g., Bitcoin, Ethereum)"
                    className="input input-bordered w-full"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onFocus={() =>
                      searchResults.length > 0 && setShowSearchResults(true)
                    }
                  />
                  {searchLoading && (
                    <div className="absolute right-3 top-3">
                      <span className="loading loading-spinner loading-sm" />
                    </div>
                  )}

                  {/* Search Results Dropdown */}
                  {showSearchResults && searchResults.length > 0 && (
                    <div className="absolute z-10 w-full mt-1 bg-base-100 border border-base-300 rounded-lg shadow-lg max-h-64 overflow-y-auto">
                      {searchResults.map((coin) => (
                        <button
                          key={coin.id}
                          type="button"
                          className="w-full px-4 py-3 flex items-center gap-3 hover:bg-base-200 transition-colors text-left"
                          onClick={() => handleSelectCoin(coin)}
                        >
                          <img
                            src={coin.image}
                            alt={coin.name}
                            className="h-8 w-8 rounded-full"
                          />
                          <div className="flex-1">
                            <div className="font-semibold text-base-content">
                              {coin.name}
                            </div>
                            <div className="text-xs text-base-content/60 uppercase">
                              {coin.symbol}
                            </div>
                          </div>
                          {coin.market_cap_rank && (
                            <div className="badge badge-sm badge-ghost">
                              #{coin.market_cap_rank}
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {newCryptoId && (
                  <label className="label">
                    <span className="label-text-alt text-success">
                      ✓ Selected: {newCryptoId}
                    </span>
                  </label>
                )}
                {!newCryptoId &&
                  searchQuery &&
                  !searchLoading &&
                  searchResults.length === 0 && (
                    <label className="label">
                      <span className="label-text-alt text-base-content/60">
                        No results found
                      </span>
                    </label>
                  )}
              </div>

              <div className="form-control mb-4">
                <label className="label">
                  <span className="label-text">Quantity</span>
                </label>
                <input
                  type="number"
                  step="any"
                  placeholder="0.5"
                  min="0"
                  className="input input-bordered"
                  value={newQuantity}
                  onChange={(e) => handleQuantityChange(e.target.value)}
                />
              </div>
              
              <div className="form-control mb-4">
                <label className="label">
                  <span className="label-text">Purchase Price ({userCurrency})</span>
                  {selectedCoinPrice && (
                    <span className="label-text-alt text-success">
                      Current: {formatCurrency(selectedCoinPrice)}
                    </span>
                  )}
                </label>
                <input
                  type="number"
                  step="any"
                  placeholder="50000"
                  min="0"
                  className="input input-bordered"
                  value={newBuyPrice}
                  onChange={(e) => handlePriceChange(e.target.value)}
                />
              </div>
              
              <div className="form-control mb-6">
                <label className="label">
                  <span className="label-text">Total Cost ({userCurrency})</span>
                  <span className="label-text-alt text-base-content/60">
                    Or enter total to calculate quantity
                  </span>
                </label>
                <input
                  type="number"
                  step="any"
                  placeholder="25000"
                  min="0"
                  className="input input-bordered"
                  value={newTotalCost}
                  onChange={(e) => handleTotalCostChange(e.target.value)}
                />
                {newQuantity && newBuyPrice && newTotalCost && (
                  <label className="label">
                    <span className="label-text-alt text-base-content/60">
                      {parseFloat(newQuantity).toFixed(8)} × {formatCurrency(newBuyPrice)} = {formatCurrency(newTotalCost)}
                    </span>
                  </label>
                )}
              </div>
              <div className="modal-action">
                <button
                  className="btn btn-ghost"
                  onClick={handleCloseModal}
                  disabled={addingCrypto}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  onClick={handleAddCrypto}
                  disabled={addingCrypto || !newCryptoId}
                >
                  {addingCrypto ? (
                    <>
                      <span className="loading loading-spinner loading-sm" />
                      Adding...
                    </>
                  ) : (
                    "Add to Portfolio"
                  )}
                </button>
              </div>
            </div>
            <div className="modal-backdrop" onClick={handleCloseModal} />
          </div>
        )}

        {/* Sell Crypto Modal */}
        {showSellModal && (
          <div className="modal modal-open">
            <div className="modal-box">
              <h3 className="font-bold text-lg mb-4">
                Sell {sellCryptoName}
              </h3>
              
              <div className="alert alert-info mb-4">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" className="stroke-current shrink-0 w-6 h-6">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
                <span className="text-sm">
                  Available: {quantityFormatter.format(sellMaxQuantity)} units
                </span>
              </div>

              <div className="form-control mb-4">
                <label className="label">
                  <span className="label-text">Quantity to Sell</span>
                  <span className="label-text-alt">
                    <button
                      type="button"
                      className="link link-primary text-xs"
                      onClick={() => setSellQuantity(sellMaxQuantity.toString())}
                    >
                      Sell All
                    </button>
                  </span>
                </label>
                <input
                  type="number"
                  step="any"
                  placeholder="0.5"
                  min="0"
                  className="input input-bordered"
                  value={sellQuantity}
                  onChange={(e) => setSellQuantity(e.target.value)}
                  max={sellMaxQuantity}
                />
                {sellQuotePrice > 0 && (
                  <label className="label">
                    <span className="label-text-alt text-base-content/60">
                      Current price: {formatCurrency(sellQuotePrice)}
                    </span>
                  </label>
                )}
                {sellQuantity && parseFloat(sellQuantity) > sellMaxQuantity && (
                  <label className="label">
                    <span className="label-text-alt text-error">
                      Insufficient quantity
                    </span>
                  </label>
                )}
              </div>
              {(estimatedSellProceeds != null || estimatedSellProfit != null) && (
                <div className="rounded-lg bg-base-200 px-4 py-3 text-sm text-base-content/70 mb-4 space-y-1">
                  {estimatedSellProceeds != null && (
                    <div>
                      Estimated proceeds:{" "}
                      <span className="font-semibold text-base-content">
                        {formatCurrency(estimatedSellProceeds)}
                      </span>
                    </div>
                  )}
                  {estimatedSellProfit != null && (
                    <div>
                      Estimated profit:{" "}
                      <span
                        className={`font-semibold ${getTrendTone(
                          estimatedSellProfit
                        )}`}
                      >
                        {formatSigned(estimatedSellProfit)}
                      </span>
                    </div>
                  )}
                </div>
              )}

              <div className="modal-action">
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    setShowSellModal(false);
                    setSellCryptoId("");
                    setSellCryptoName("");
                    setSellQuantity("");
                    setSellMaxQuantity(0);
                    setSellQuotePrice(0);
                    setSellCostBasisUnit(0);
                  }}
                  disabled={sellingCrypto}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-warning"
                  onClick={handleSellCrypto}
                  disabled={
                    sellingCrypto ||
                    !sellQuantity ||
                    parseFloat(sellQuantity) <= 0 ||
                    parseFloat(sellQuantity) > sellMaxQuantity
                  }
                >
                  {sellingCrypto ? (
                    <>
                      <span className="loading loading-spinner loading-sm" />
                      Selling...
                    </>
                  ) : (
                    "Confirm Sell"
                  )}
                </button>
              </div>
            </div>
            <div
              className="modal-backdrop"
              onClick={() => {
                if (!sellingCrypto) {
                  setShowSellModal(false);
                  setSellCryptoId("");
                  setSellCryptoName("");
                  setSellQuantity("");
                  setSellMaxQuantity(0);
                  setSellQuotePrice(0);
                  setSellCostBasisUnit(0);
                }
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
