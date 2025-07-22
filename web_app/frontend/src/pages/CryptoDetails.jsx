import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";
import { useEffect, useMemo, useState } from "react";
import { Line } from "react-chartjs-2";
import { Link, useParams } from "react-router-dom";
import { fetchCoinDetails, fetchMarketChart } from "../services/coingecko";
import { useAuth } from "../state/AuthContext";

ChartJS.register(LineElement, CategoryScale, LinearScale, PointElement, Tooltip, Filler);

const formatCurrency = (value, currency) => {
  const currencyCode = currency?.toUpperCase() || "USD";
  // Map currency codes to locales
  const localeMap = {
    'USD': 'en-US',
    'EUR': 'de-DE',
    'AUD': 'en-AU'
  };
  
  return new Intl.NumberFormat(localeMap[currencyCode] || 'en-US', {
    style: "currency",
    currency: currencyCode,
    maximumFractionDigits: 2
  }).format(value);
};

const numberCompact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});

export default function CryptoDetails() {
  const { id } = useParams();
  const { authFetch, loading: authLoading } = useAuth();
  const [userCurrency, setUserCurrency] = useState("USD");
  const [coin, setCoin] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  // Fetch user's preferred currency
  useEffect(() => {
    async function fetchUserPreferences() {
      try {
        const response = await authFetch("/accounts/profile/");
        if (response?.data?.preferred_currency) {
          setUserCurrency(response.data.preferred_currency);
        }
      } catch (error) {
        console.warn("Failed to fetch user preferences:", error);
      }
    }
    fetchUserPreferences();
  }, [authFetch]);

  useEffect(() => {
    if (!id || authLoading) {
      return;
    }

    let cancel = false;
    async function fetchCoinData() {
      setLoading(true);
      setErr(null);
      try {
        // Get user's preferred currency
        const response = await authFetch("/api/accounts/profile/");
        const preferredCurrency = response?.data?.preferred_currency?.toLowerCase() || 'usd';
        setUserCurrency(preferredCurrency);
        
        console.log('Fetching coin details with currency:', preferredCurrency);
        const coinDetails = await fetchCoinDetails(id, preferredCurrency);
        if (!coinDetails) throw new Error("Coin not found");
        console.log('Received coin details:', coinDetails);
        
        const chartData = await fetchMarketChart({
          id,
          vsCurrency: preferredCurrency,
          days: 7
        });
        console.log('Received chart data:', chartData);

        const formattedDetails = {
          ...coinDetails,
          market_data: {
            ...coinDetails.market_data,
            price_chart: chartData
          }
        };

        if (!cancel) {
          setCoin(formattedDetails);
        }
      } catch (error) {
        if (!cancel) {
          console.error("Failed to fetch coin data:", error);
          setErr(error.message || "Failed to load coin data");
        }
      } finally {
        if (!cancel) {
          setLoading(false);
        }
      }
    }

    fetchCoinData();
    return () => {
      cancel = true;
    };
  }, [id, authFetch, authLoading]);

  // Prepare chart data from price_chart - MUST be called before any conditional returns
  const marketData = coin?.market_data || {};
  const chartData = useMemo(() => {
    const priceChart = marketData.price_chart || [];
    console.log('Chart data check:', {
      hasPriceChart: !!marketData.price_chart,
      isArray: Array.isArray(priceChart),
      length: priceChart.length,
      firstItem: priceChart[0]
    });
    
    if (!Array.isArray(priceChart) || priceChart.length === 0) {
      console.log('No chart data available');
      return null;
    }

    // priceChart is an array of [timestamp, price]
    const labels = priceChart.map(([timestamp]) => {
      const date = new Date(timestamp);
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    });

    const prices = priceChart.map(([, price]) => price);

    console.log('Chart prepared:', { labels: labels.length, prices: prices.length });

    return {
      labels,
      datasets: [
        {
          label: `Price (${userCurrency.toUpperCase()})`,
          data: prices,
          borderColor: "rgb(99, 102, 241)",
          backgroundColor: "rgba(99, 102, 241, 0.1)",
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 2,
        },
      ],
    };
  }, [marketData.price_chart, userCurrency]);

  const chartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        mode: "index",
        intersect: false,
        callbacks: {
          label: (context) => {
            const value = context.parsed.y;
            return `${formatCurrency(value, userCurrency)}`;
          },
        },
      },
    },
    scales: {
      x: {
        grid: {
          display: false,
        },
        ticks: {
          maxTicksLimit: 7,
        },
      },
      y: {
        grid: {
          color: "rgba(0, 0, 0, 0.05)",
        },
        ticks: {
          callback: (value) => formatCurrency(value, userCurrency),
        },
      },
    },
    interaction: {
      mode: "nearest",
      axis: "x",
      intersect: false,
    },
  }), [userCurrency]);

  if (loading) {
    return (
      <div className="min-h-screen bg-base-200 flex items-center justify-center">
        <span className="loading loading-spinner loading-lg"></span>
      </div>
    );
  }

  if (err) {
    return (
      <div className="min-h-screen bg-base-200 flex items-center justify-center">
        <div className="alert alert-error">{err}</div>
      </div>
    );
  }

  if (!coin) {
    return (
      <div className="min-h-screen bg-base-200 flex items-center justify-center">
        <div className="alert alert-warning">Coin not found</div>
      </div>
    );
  }
  
  const formatLargeNumber = (num) => {
    if (!num) return '0';
    if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
    if (num >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
    return num.toString();
  };

  return (
    <div className="min-h-screen bg-base-200">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="mb-6 flex items-center gap-2">
          <Link to="/dashboard" className="btn btn-sm btn-ghost">← Back</Link>
          <div className="text-sm breadcrumbs">
            <ul>
              <li><Link to="/dashboard">Dashboard</Link></li>
              <li>{coin.name}</li>
            </ul>
          </div>
        </div>

        <div className="card bg-base-100 shadow mb-6">
          <div className="card-body">
            <div className="flex items-center gap-4">
              <img src={coin.image?.large} alt={coin.name} className="w-16 h-16 rounded-full" />
              <div>
                <h1 className="text-3xl font-bold flex items-center gap-2">
                  {coin.name}
                  <span className="text-base font-normal text-base-content/70">
                    {coin.symbol?.toUpperCase()}
                  </span>
                </h1>
                <div className="mt-1 flex items-center gap-2">
                  <div className="badge badge-neutral">Rank #{coin.market_cap_rank || '—'}</div>
                  {coin.categories?.[0] && (
                    <div className="badge badge-ghost">{coin.categories[0]}</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="card bg-base-100 shadow mb-6">
          <div className="card-body">
            <h2 className="card-title">7-Day Price Chart</h2>
            <div className="h-64 mt-4">
              {chartData ? (
                <Line data={chartData} options={chartOptions} />
              ) : (
                <div className="flex items-center justify-center h-full text-base-content/60">
                  <p>Loading chart data...</p>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <div className="card bg-base-100 shadow">
            <div className="card-body">
              <h2 className="card-title">Price Overview</h2>
              <div className="text-3xl font-mono mt-2">
                {formatCurrency(marketData.current_price?.[userCurrency.toLowerCase()] || 0, userCurrency)}
              </div>
              
              <div className="stats stats-vertical shadow mt-4">
                <div className="stat">
                  <div className="stat-title">24h Change</div>
                  <div className={`stat-value text-lg ${
                    (marketData.price_change_percentage_24h || 0) >= 0 
                      ? 'text-success' 
                      : 'text-error'
                  }`}>
                    {(marketData.price_change_percentage_24h || 0).toFixed(2)}%
                  </div>
                </div>

                <div className="stat">
                  <div className="stat-title">24h High/Low</div>
                  <div className="stat-value text-lg font-mono">
                    <div>{formatCurrency(marketData.high_24h?.[userCurrency.toLowerCase()] || 0, userCurrency)}</div>
                    <div className="text-base-content/70">
                      {formatCurrency(marketData.low_24h?.[userCurrency.toLowerCase()] || 0, userCurrency)}
                    </div>
                  </div>
                </div>

                <div className="stat">
                  <div className="stat-title">Market Cap</div>
                  <div className="stat-value text-lg">
                    {formatCurrency(marketData.market_cap?.[userCurrency.toLowerCase()] || 0, userCurrency)}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="card bg-base-100 shadow">
            <div className="card-body">
              <h2 className="card-title">Market Stats</h2>
              
              <div className="stats stats-vertical shadow mt-4">
                <div className="stat">
                  <div className="stat-title">24h Trading Volume</div>
                  <div className="stat-value text-lg">
                    {formatCurrency(marketData.total_volume?.[userCurrency.toLowerCase()] || 0, userCurrency)}
                  </div>
                </div>

                <div className="stat">
                  <div className="stat-title">Circulating Supply</div>
                  <div className="stat-value text-lg">
                    {numberCompact.format(marketData.circulating_supply || 0)}
                  </div>
                  {marketData.max_supply && (
                    <div className="stat-desc">
                      Max: {numberCompact.format(marketData.max_supply)}
                    </div>
                  )}
                </div>

                <div className="stat">
                  <div className="stat-title">All-Time High</div>
                  <div className="stat-value text-lg font-mono">
                    {formatCurrency(marketData.ath?.[userCurrency.toLowerCase()] || 0, userCurrency)}
                  </div>
                  <div className="stat-desc">
                    {new Date(marketData.ath_date?.usd).toLocaleDateString()}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {coin.description?.en && (
            <div className="card bg-base-100 shadow md:col-span-2">
              <div className="card-body">
                <h2 className="card-title">About {coin.name}</h2>
                <div 
                  className="prose max-w-none"
                  dangerouslySetInnerHTML={{ __html: coin.description.en }}
                />
              </div>
            </div>
          )}

          <div className="card bg-base-100 shadow md:col-span-2">
            <div className="card-body">
              <h2 className="card-title">Links & Resources</h2>
              <div className="flex flex-wrap gap-2 mt-2">
                {coin.links?.homepage?.[0] && (
                  <a 
                    href={coin.links.homepage[0]} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="btn btn-sm btn-outline"
                  >
                    Website
                  </a>
                )}
                {coin.links?.blockchain_site?.filter(Boolean).map((url, i) => (
                  <a 
                    key={i}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-sm btn-outline"
                  >
                    Explorer {i + 1}
                  </a>
                ))}
                {coin.links?.official_forum_url?.filter(Boolean).map((url, i) => (
                  <a
                    key={i}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-sm btn-outline"
                  >
                    Forum {i + 1}
                  </a>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
