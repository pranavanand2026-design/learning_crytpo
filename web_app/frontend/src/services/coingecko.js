// frontend/src/services/coingecko.js
import axios from "axios";

const env = typeof import.meta !== "undefined" ? import.meta.env : {};
const rawBaseUrl = env?.VITE_API_BASE_URL;
const BACKEND_URL = (rawBaseUrl && rawBaseUrl.length > 0 ? rawBaseUrl : "/api").replace(/\/$/, "");
const DEFAULT_TIMEOUT = 10000;

const api = axios.create({
  baseURL: BACKEND_URL,
  timeout: DEFAULT_TIMEOUT,
  withCredentials: true,
});

const toError = (error, fallbackMessage) => {
  const detail =
    error?.response?.data?.detail ??
    error?.response?.data?.message ??
    error?.message ??
    fallbackMessage;
  return new Error(detail);
};

const readPayload = (response) => {
  const payload = response?.data;
  if (payload == null) return null;

  if (typeof payload === "object" && !Array.isArray(payload)) {
    if (typeof payload.code === "number" && payload.code !== 0) {
      throw new Error(payload.detail || "Request failed");
    }
    if (Object.prototype.hasOwnProperty.call(payload, "data")) {
      return payload.data;
    }
  }
  return payload;
};

const toNumberOrNull = (value) => {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const enrichMarketEntry = (entry) => {
  if (!entry || typeof entry !== "object") return entry;
  const change1h = entry.price_change_percentage_1h_in_currency ?? entry.price_change_percentage_1h;
  const change24h = entry.price_change_percentage_24h_in_currency ?? entry.price_change_percentage_24h;
  const change7d = entry.price_change_percentage_7d_in_currency ?? entry.price_change_percentage_7d;

  return {
    ...entry,
    ch1h: toNumberOrNull(change1h),
    ch24h: toNumberOrNull(change24h),
    ch7d: toNumberOrNull(change7d),
  };
};

// --- Backend Proxy Implementation ---

export const fetchMarkets = async ({ vsCurrency, perPage = 100 } = {}) => {
  try {
    // Get user's preferred currency from profile if not specified
    if (!vsCurrency) {
      try {
        const profileResponse = await api.get("/accounts/profile/");
        const profileData = readPayload(profileResponse);
        vsCurrency = profileData?.data?.preferred_currency?.toLowerCase() || "usd";
      } catch (error) {
        console.warn("Failed to get preferred currency:", error);
        vsCurrency = "usd"; // fallback to USD
      }
    } else {
      vsCurrency = vsCurrency.toLowerCase(); // ensure lowercase
    }

    const response = await api.get("/markets/", {
      params: { currency: vsCurrency, limit: perPage },
    });
    const data = readPayload(response);
    const list = Array.isArray(data) ? data.map(enrichMarketEntry) : [];
    return list;
  } catch (error) {
    console.error("Market data fetch error:", error);
    throw toError(error, "Failed to fetch market data");
  }
};

export const fetchMarketsByIds = async ({
  ids = [],
  vsCurrency = "aud",
  priceChangePct = "1h,24h,7d",
  sparkline = false,
} = {}) => {
  if (!ids.length) return [];

  try {
    // Use backend proxy to avoid CORS issues
    const response = await api.get("/coingecko_proxy/", {
      params: {
        endpoint: "coins/markets",
        vs_currency: vsCurrency,
        ids: ids.join(","),
        sparkline: sparkline ? "true" : "false",
        price_change_percentage: priceChangePct,
      },
    });

    const data = readPayload(response);
    if (!data || !Array.isArray(data)) {
      throw new Error("Invalid response from backend");
    }

    // Map the response to our format
    return data.map((r) => ({
      id: r.id,
      name: r.name,
      symbol: (r.symbol || "").toUpperCase(),
      image: r.image || null,
      current_price: r.current_price ?? null,
      market_cap: r.market_cap ?? null,
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
      sparkline_in_7d: sparkline ? r.sparkline_in_7d ?? { price: [] } : null,
    }));
  } catch (err) {
    console.error("Failed to fetch market data:", err);
    throw new Error("Unable to fetch market data. Please try again later.");
  }
};

export const searchCoins = async (query) => {
  const trimmed = (query || "").trim();
  if (!trimmed) return [];
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(trimmed)}`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (
      data.coins?.map((c) => ({
        id: c.id,
        name: c.name,
        symbol: c.symbol,
        image: c.large,
        market_cap_rank: c.market_cap_rank,
      })) || []
    );
  } catch {
    return [];
  }
};

export const fetchMarketChart = async ({
  id,
  vsCurrency = "aud",
  days = 7,
  interval,
} = {}) => {
  if (!id) return [];
  
  try {
    const response = await api.get("/coingecko_proxy/", {
      params: {
        endpoint: `coins/${id}/market_chart`,
        vs_currency: vsCurrency,
        days: String(days)
      }
    });
    const data = readPayload(response);
    if (!data) return [];
    
    // Extract price data from response
    const body = data;
    return Array.isArray(body?.prices) ? body.prices : [];
  } catch (err) {
    console.error("Chart data fetch error:", err);
    return [];
  }
};

export const fetchCoinDetails = async (id, vsCurrency = 'usd') => {
  if (!id) return null;
  try {
    // Try getting details through proxy first
    const detailsQuery = new URLSearchParams({
      endpoint: `coins/${id}`,
      vs_currency: vsCurrency
    });
    const response = await api.get("/coingecko_proxy/", {
      params: detailsQuery
    });
    const data = readPayload(response);
    if (!data) throw new Error("No data returned from proxy");

    // Try to get fresh price data
    let freshPrice = null;
    try {
      const priceResponse = await api.get("/prices/current/", {
        params: { coin_ids: id, currency: vsCurrency }
      });
      const priceData = readPayload(priceResponse);
      freshPrice = priceData?.[id]?.[vsCurrency];
    } catch (priceErr) {
      console.warn("Failed to fetch current price:", priceErr);
    }

    // Try to get fresh market data if price is missing
    if (!freshPrice && !data.market_data?.current_price?.[vsCurrency]) {
      try {
        const marketResponse = await api.get("/markets/", {
          params: { currency: vsCurrency }
        });
        const marketData = readPayload(marketResponse);
        const marketEntry = Array.isArray(marketData) 
          ? marketData.find(m => m.id === id)
          : null;
        freshPrice = marketEntry?.current_price;
      } catch (marketErr) {
        console.warn("Failed to fetch market data:", marketErr);
      }
    }

    // Return formatted data with best available price
    return {
      id: data.id,
      name: data.name,
      symbol: data.symbol?.toUpperCase(),
      description: data.description,
      image: data.image,
      links: data.links,
      categories: data.categories,
      market_cap_rank: data.market_cap_rank,
      market_data: {
        ...data.market_data,
        current_price: {
          [vsCurrency]: freshPrice ?? data.market_data?.current_price?.[vsCurrency]
        }
      }
    };
  } catch (error) {
    console.error("Coin details fetch error:", error);
    throw toError(error, "Failed to fetch coin details");
  }
};

export const pingHealth = async () => {
  try {
    const res = await api.get("/health/");
    return readPayload(res);
  } catch {
    return null;
  }
};
