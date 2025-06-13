import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Line } from "react-chartjs-2";
import { Link } from "react-router-dom";
import { useAuth } from "../state/AuthContext";
import { useUserCurrency } from "../hooks/useUserCurrency";
import {
  WATCHLIST_CHANGED_EVENT,
  addToWatchlist,
  fetchWatchlist,
  notifyWatchlistChanged,
  removeFromWatchlist,
} from "../services/watchlist";


ChartJS.register(LineElement, CategoryScale, LinearScale, PointElement, Tooltip, Filler);

const formatCurrency = (value, currency) => {
  const currencyCode = currency?.toUpperCase() || "USD";
  const localeMap = {
    USD: "en-US",
    EUR: "de-DE",
    AUD: "en-AU",
  };

  return new Intl.NumberFormat(localeMap[currencyCode] || "en-US", {
    style: "currency",
    currency: currencyCode,
    maximumFractionDigits: 2,
  }).format(value ?? 0);

  
};

const formatAbbrev = (v, currency) => {
  if (v == null) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${formatCurrency(v / 1e12, currency)}T`;
  if (abs >= 1e9) return `${formatCurrency(v / 1e9, currency)}B`;
  if (abs >= 1e6) return `${formatCurrency(v / 1e6, currency)}M`;
  return formatCurrency(v, currency);
};

const PAGE_SIZE = 10;
const TOP_COUNT = 100;
const CAP_TOP_N = 50;

const generateFallbackData = (length = 30, start = 100) => {
  let arr = [start];
  for (let i = 1; i < length; i++) {
    const prev = arr[i - 1];
    const change = (Math.random() - 0.5) * 2;
    arr.push(prev + prev * change * 0.01);
  }
  return arr;
};

export default function Dashboard() {
  const { authFetch, accessToken } = useAuth();
  const { currency: userCurrency } = useUserCurrency();

  // ---------- States ----------
  const [allCoins, setAllCoins] = useState([]);
  const [loadingCoins, setLoadingCoins] = useState(true);
  const [coinsError, setCoinsError] = useState(null);

  const [capRange, setCapRange] = useState("7");
  const [globalCapSeries, setGlobalCapSeries] = useState([]);
  const [globalCapNow, setGlobalCapNow] = useState(0);
  const [loadingCap, setLoadingCap] = useState(true);
  const [capError, setCapError] = useState(null);

  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(allCoins.length / PAGE_SIZE));

  const [watchMap, setWatchMap] = useState(new Map());
  const watchedIds = useMemo(() => Array.from(watchMap.keys()), [watchMap]);
  const isWatched = useCallback((id) => watchMap.has(id), [watchMap]);
  const [flash, setFlash] = useState(null);

  const refreshWatchlist = useCallback(async () => {
    try {
      const list = await fetchWatchlist(authFetch);
      const map = new Map();
      list.forEach((item) => {
        const coinId = item.coin_id || item.coin?.id;
        if (coinId && item.id) {
          map.set(coinId, item.id);
        }
      });
      setWatchMap(map);
      return list;
    } catch (e) {
      console.warn("Failed to refresh watchlist:", e);
      return [];
    }
  }, [authFetch]);

useEffect(() => {
  if (!accessToken) return; // skip watchlist fetch for guests
  refreshWatchlist();
}, [accessToken, refreshWatchlist]);


  useEffect(() => {
    function handleWatchlistEvent(evt) {
      if (evt?.detail?.source === "dashboard") return;
      refreshWatchlist();
    }
    window.addEventListener(WATCHLIST_CHANGED_EVENT, handleWatchlistEvent);
    return () => {
      window.removeEventListener(WATCHLIST_CHANGED_EVENT, handleWatchlistEvent);
    };
  }, [refreshWatchlist]);

  const ensureWatchlistEntryId = useCallback(
    async (coinId) => {
      if (watchMap.has(coinId)) {
        return watchMap.get(coinId);
      }
      const list = await refreshWatchlist();
      const entry = list.find(
        (item) => (item.coin_id || item.coin?.id) === coinId && item.id != null
      );
      return entry?.id ?? null;
    },
    [watchMap, refreshWatchlist]
  );

  const handleToggleWatch = async (id) => {
    const wasWatched = isWatched(id);
    try {
      if (wasWatched) {
        const entryId = await ensureWatchlistEntryId(id);
        if (!entryId) {
          throw new Error("Watchlist entry not found");
        }
        await removeFromWatchlist(authFetch, entryId);
        setWatchMap((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
        notifyWatchlistChanged({ type: "removed", coinId: id, source: "dashboard" });
        setFlash({ msg: "Removed from watchlist", kind: "info" });
        await refreshWatchlist();
        setTimeout(() => setFlash(null), 1800);
      } else {
        const res = await addToWatchlist(authFetch, id);
        const entryId = res?.id || res?.watchlist_id || res?.data?.id || null;
        if (entryId) {
          setWatchMap((prev) => {
            const next = new Map(prev);
            next.set(id, entryId);
            return next;
          });
        }
        notifyWatchlistChanged({ type: "added", coinId: id, entryId, source: "dashboard" });
        setFlash({ msg: "Added to watchlist", kind: "success" });
        await refreshWatchlist();
        setTimeout(() => setFlash(null), 1800);
      }
    } catch (e) {
      setFlash({ msg: e.message || "Failed to update watchlist", kind: "error" });
      setTimeout(() => setFlash(null), 2400);
    }
  };

  // ---------- Fetch user's preferred currency ----------
  // ---------- Proxy fetch for markets (currency-aware) ----------
  const fetchMarketsViaProxy = useCallback(
    async (params = {}) => {
      const vs = (userCurrency || "USD").toLowerCase();
      const query = new URLSearchParams({
        endpoint: "coins/markets",
        vs_currency: vs,
        per_page: TOP_COUNT,
        page: 1,
        sparkline: true,
        price_change_percentage: "1h,24h,7d",
        ...params,
      });

      try {
        // Primary: live API via backend proxy
        const res = await authFetch(`/api/coingecko_proxy/?${query.toString()}`, {}, true);
        return res.data || [];
      } catch (error) {
        console.warn("API failed, trying cached data:", error);
        try {
          // Secondary: Django cache endpoint (if you have it)
          const cacheRes = await authFetch(`/api/markets_cache/?${query.toString()}`);
          if (cacheRes?.data?.length) {
            console.info("Using cached data");
            return cacheRes.data.map((r) => ({
              ...r,
              _cachedSpark: r.sparkline_in_7d?.price || null,
            }));
          }
        } catch (cacheError) {
          console.error("Cache fetch failed:", cacheError);
        }
        // Last resort: empty
        return [];
      }
    },
    [authFetch, userCurrency]
  );

  // ---------- Load coins (refetch when currency changes) ----------
  useEffect(() => {
    let cancel = false;

    const loadTopCoins = async () => {
      if (!userCurrency) return;
      setLoadingCoins(true);
      try {
        setCoinsError(null);
        const raw = await fetchMarketsViaProxy();
        const merged = raw.map((r) => {
          const spark =
            r.sparkline_in_7d?.price?.filter(Number.isFinite) ||
            r._cachedSpark?.filter(Number.isFinite) ||
            generateFallbackData();

          return {
            id: r.id,
            name: r.name,
            symbol: (r.symbol || "").toUpperCase(),
            image: r.image,
            price: r.current_price, // in userCurrency
            marketCap: r.market_cap, // in userCurrency
            circulating_supply: r.circulating_supply ?? null,
            ch1h:
              r.price_change_percentage_1h_in_currency ??
              r.price_change_percentage_1h ??
              null,
            ch24h:
              r.price_change_percentage_24h_in_currency ??
              r.price_change_percentage_24h ??
              null,
            ch7d:
              r.price_change_percentage_7d_in_currency ??
              r.price_change_percentage_7d ??
              null,
            spark,
          };
        });

        if (!cancel) setAllCoins(merged);
      } catch (e) {
        console.warn("Dashboard load error (coins):", e);
        if (!cancel) {
          setAllCoins([]);
          setCoinsError("Failed to load market data");
        }
      } finally {
        if (!cancel) setLoadingCoins(false);
      }
    };

    loadTopCoins();
    const id = setInterval(loadTopCoins, 5 * 60 * 1000);
    return () => {
      cancel = true;
      clearInterval(id);
    };
  }, [userCurrency, fetchMarketsViaProxy]);

  // ---------- Build global market cap (approx) ----------
  const buildApproxCapSeries = (coins, window) => {
    if (!coins.length) return generateFallbackData();

    const minLength = coins.reduce(
      (min, c) => (c.spark?.length ? Math.min(min, c.spark.length) : min),
      Infinity
    );
    if (!Number.isFinite(minLength) || minLength === 0) return generateFallbackData();

    const series = [];
    for (let i = 0; i < minLength; i++) {
      let totalCap = 0;
      for (const c of coins) {
        const priceSeries = c.spark?.filter(Number.isFinite) || generateFallbackData();
        const price = priceSeries[i] ?? 0;
        const supply = c.circulating_supply ?? 0;
        totalCap += price * supply; // price (in userCurrency) * supply
      }
      series.push(totalCap / 1e9); // billions in userCurrency
    }

    return window === "1" ? series.slice(-24) : series;
  };

  useEffect(() => {
    try {
      setLoadingCap(true);
      const top = allCoins.slice(0, CAP_TOP_N);
      const now = top.reduce((acc, c) => acc + (c.marketCap || 0), 0);
      const series = buildApproxCapSeries(top, capRange);
      setGlobalCapNow(now);
      setGlobalCapSeries(series);
    } catch (e) {
      setCapError("Could not build market-cap overview");
      setGlobalCapSeries(generateFallbackData());
      setGlobalCapNow(0);
    } finally {
      setLoadingCap(false);
    }
  }, [allCoins, capRange]);

  const topGainers = useMemo(() => {
    if (!allCoins.length) return [];
    const positives = allCoins.filter((c) => (c.ch24h ?? -Infinity) > 0);
    const source = positives.length ? positives : allCoins;
    return [...source]
      .sort((a, b) => (b.ch24h ?? -Infinity) - (a.ch24h ?? -Infinity))
      .slice(0, 5);
  }, [allCoins]);

  const pageRows = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return allCoins.slice(start, start + PAGE_SIZE);
  }, [allCoins, page]);

  const trendColor = (v) => (v == null ? "" : v >= 0 ? "text-success" : "text-error");

  return (
    <div className="min-h-screen bg-base-200">
      <div className="mx-auto max-w-6xl px-6 py-10">
        {coinsError && (
          <div className="alert alert-error mb-4">
            <span className="text-sm">{coinsError}</span>
            <button
              className="btn btn-sm btn-ghost ml-auto"
              onClick={() => window.location.reload()}
            >
              Retry
            </button>
          </div>
        )}

        {flash && (
          <div
            className={`alert ${
              flash.kind === "success" ? "alert-success" : "alert-info"
            } mb-4 py-2 text-sm`}
            role="status"
          >
            {flash.msg}
          </div>
        )}

        <div className="mb-6 rounded-box bg-base-100 p-4 shadow">
          <h2 className="text-lg font-semibold">CryptoDash overview</h2>
          <p className="mt-1 text-sm text-base-content/70">
            Live snapshot of the market: today’s top gainers, total market-cap trend, and a paginated table of the top 100 coins.
          </p>
        </div>

        <section className="grid gap-6 md:grid-cols-2">
          <div className="card bg-base-100 shadow">
            <div className="card-body">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="card-title">Top Gainers</h3>
                <span className="badge badge-outline">24 h</span>
              </div>
              {loadingCoins ? (
                <div className="flex items-center gap-2 text-sm text-base-content/60">
                  <span className="loading loading-spinner loading-sm" />
                  Loading gainers…
                </div>
              ) : (
                <ul className="space-y-2">
                  {topGainers.map((c) => {
                    const watched = isWatched(c.id);
                    return (
                      <li
                        key={c.id}
                        className="flex items-center justify-between rounded-lg bg-base-200 px-3 py-2 text-sm"
                      >
                        <div className="flex items-center gap-3">
                          <img
                            src={c.image}
                            alt={c.name}
                            className="h-5 w-5 rounded-full"
                            loading="lazy"
                          />
                          <Link
                            to={`/coin/${c.id}`}
                            className="font-medium hover:text-primary hover:underline"
                          >
                            {c.name}{" "}
                            <span className="text-base-content/60">({c.symbol})</span>
                          </Link>
                        </div>
                        <div className="flex items-center gap-2">
                          <span
                            className={`badge ${
                              (c.ch24h ?? 0) >= 0 ? "badge-success" : "badge-error"
                            }`}
                          >
                            {(c.ch24h ?? 0) >= 0 ? "+" : ""}
                            {(c.ch24h ?? 0).toFixed(2)}%
                          </span>
                          {accessToken ? (
                              <button
                                className={`btn btn-ghost btn-xs ${watched ? "text-success" : ""}`}
                                onClick={() => handleToggleWatch(c.id)}
                              >
                                {watched ? "✓ Watched" : "Add"}
                              </button>
                            ) : (
                              <span className="text-sm text-base-content/50">Login to add</span>
                            )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          <div className="card bg-base-100 shadow">
            <div className="card-body">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="card-title">Total Market Cap</h3>
                <div className="join">
                  {["1", "7"].map((d) => (
                    <button
                      key={d}
                      className={`btn btn-xs join-item ${
                        capRange === d ? "btn-primary" : "btn-ghost"
                      }`}
                      onClick={() => setCapRange(d)}
                    >
                      {d === "1" ? "24h" : "7d"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="text-sm text-base-content/70">
                Current top {CAP_TOP_N} sum:{" "}
                <span className="font-medium">{formatAbbrev(globalCapNow, userCurrency)}</span>
              </div>

              <div className="mt-3 h-48">
                {loadingCap ? (
                  <div className="flex h-full items-center gap-2 text-sm text-base-content/60">
                    <span className="loading loading-spinner loading-sm" />
                    Building market-cap overview…
                  </div>
                ) : (
                  <Line
                    data={{
                      labels: globalCapSeries.map((_, i) => i),
                      datasets: [
                        {
                          label: `Total Market Cap (Billion ${userCurrency})`,
                          data: globalCapSeries,
                          borderColor: "#6366f1",
                          backgroundColor: "rgba(99,102,241,0.1)",
                          fill: true,
                          tension: 0.4,
                          borderWidth: 2,
                          pointRadius: 0,
                        },
                      ],
                    }}
                    options={{
                      responsive: true,
                      plugins: { legend: { display: false } },
                      scales: {
                        x: { display: false },
                        y: {
                          ticks: {
                            callback: (v) =>
                              v >= 1e3 ? `${(v / 1e3).toFixed(1)}T` : `${v.toFixed(0)}B`,
                          },
                        },
                      },
                    }}
                  />
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="mt-6 rounded-box bg-base-100 p-6 shadow">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-xl font-semibold">Cryptocurrencies</h3>
            <div className="join">
              <button
                className="btn btn-sm join-item"
                disabled={page === 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Prev
              </button>
              <button className="btn btn-sm join-item pointer-events-none">
                {page}/{totalPages}
              </button>
              <button
                className="btn btn-sm join-item"
                disabled={page === totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Price</th>
                  <th>1 h</th>
                  <th>24 h</th>
                  <th>7 d</th>
                  <th>Market Cap</th>
                  <th>Trend</th>
                  <th className="text-right">Watchlist</th>
                </tr>
              </thead>
              <tbody>
                {loadingCoins ? (
                  <tr>
                    <td colSpan={8} className="text-sm text-base-content/60">
                      <div className="flex items-center gap-2">
                        <span className="loading loading-spinner loading-sm" />
                        Loading coins…
                      </div>
                    </td>
                  </tr>
                ) : pageRows.length ? (
                  pageRows.map((c) => {
                    const watched = isWatched(c.id);
                    return (
                      <tr key={c.id}>
                        <td>
                          <Link
                            to={`/coin/${c.id}`}
                            className="flex items-center gap-3 hover:opacity-80"
                          >
                            <img
                              src={c.image}
                              alt={c.name}
                              className="h-8 w-8 rounded-full"
                              loading="lazy"
                            />
                            <div>
                              <div className="font-semibold">{c.name}</div>
                              <div className="text-xs uppercase text-base-content/70">
                                {c.symbol}
                              </div>
                            </div>
                          </Link>
                        </td>
                        <td className="font-mono text-sm">
                          {formatCurrency(c.price, userCurrency)}
                        </td>
                        <td className={`text-sm ${trendColor(c.ch1h)}`}>
                          {c.ch1h == null
                            ? "—"
                            : `${c.ch1h >= 0 ? "+" : ""}${c.ch1h.toFixed(2)}%`}
                        </td>
                        <td className={`text-sm ${trendColor(c.ch24h)}`}>
                          {c.ch24h == null
                            ? "—"
                            : `${c.ch24h >= 0 ? "+" : ""}${c.ch24h.toFixed(2)}%`}
                        </td>
                        <td className={`text-sm ${trendColor(c.ch7d)}`}>
                          {c.ch7d == null
                            ? "—"
                            : `${c.ch7d >= 0 ? "+" : ""}${c.ch7d.toFixed(2)}%`}
                        </td>
                        <td className="text-sm text-base-content/70">
                          {formatAbbrev(c.marketCap, userCurrency)}
                        </td>
                        <td className="w-32">
                          <Line
                            data={{
                              labels: c.spark.map((_, i) => i),
                              datasets: [
                                {
                                  data: c.spark,
                                  borderColor: c.ch7d >= 0 ? "#22c55e" : "#ef4444",
                                  borderWidth: 1.5,
                                  fill: false,
                                  tension: 0.4,
                                  pointRadius: 0,
                                },
                              ],
                            }}
                            options={{
                              responsive: true,
                              plugins: { legend: { display: false } },
                              scales: { x: { display: false }, y: { display: false } },
                              elements: { line: { borderJoinStyle: "round" } },
                            }}
                          />
                        </td>
                        <td className="text-right">
                          {accessToken ? (
                            <button
                              className={`btn btn-xs ${watched ? "btn-outline btn-success" : "btn-ghost"}`}
                              onClick={() => handleToggleWatch(c.id)}
                            >
                              {watched ? "✓ Watched" : "Add"}
                            </button>
                          ) : (
                            <span className="text-sm text-base-content/50">Login to add</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={8} className="text-center text-sm text-base-content/60">
                      No data available.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
