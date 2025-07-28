import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../state/AuthContext";

export const CURRENCY_CHANGED_EVENT = "user:currency-changed";
const DEFAULT_CURRENCY = "USD";

const localeByCurrency = {
  USD: "en-US",
  AUD: "en-AU",
  EUR: "de-DE",
  GBP: "en-GB",
  CAD: "en-CA",
  NZD: "en-NZ",
  SGD: "en-SG",
  JPY: "ja-JP",
  CNY: "zh-CN",
  INR: "en-IN",
};

const normaliseCurrency = (value) => {
  if (typeof value !== "string" || !value.trim()) return DEFAULT_CURRENCY;
  return value.trim().toUpperCase();
};

const makeFormatter = (currency) => {
  const code = normaliseCurrency(currency);
  const locale = localeByCurrency[code] || "en-US";
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      maximumFractionDigits: 2,
    });
  } catch {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: DEFAULT_CURRENCY,
      maximumFractionDigits: 2,
    });
  }
};

export const useUserCurrency = () => {
  const { authFetch } = useAuth();
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);

  useEffect(() => {
    let cancelled = false;

    async function loadCurrency() {
      try {
        const response = await authFetch("/api/accounts/profile/");
        const payload = response?.data ?? response;
        const next =
          payload?.preferred_currency ||
          payload?.data?.preferred_currency ||
          payload?.data?.data?.preferred_currency ||
          DEFAULT_CURRENCY;
        if (!cancelled) {
          setCurrency(normaliseCurrency(next));
        }
      } catch (error) {
        if (!cancelled) {
          setCurrency(DEFAULT_CURRENCY);
        }
      }
    }

    loadCurrency();

    return () => {
      cancelled = true;
    };
  }, [authFetch]);

  useEffect(() => {
    const handler = (event) => {
      const next = normaliseCurrency(event?.detail?.currency);
      if (next && next !== currency) {
        setCurrency(next);
      }
    };

    window.addEventListener(CURRENCY_CHANGED_EVENT, handler);
    return () => window.removeEventListener(CURRENCY_CHANGED_EVENT, handler);
  }, [currency]);

  const formatter = useMemo(() => makeFormatter(currency), [currency]);

  return {
    currency,
    formatter,
    format: (value) => {
      if (value === null || value === undefined || value === "") return "—";
      const asNumber = Number(value);
      if (!Number.isFinite(asNumber)) return "—";
      return formatter.format(asNumber);
    },
  };
};

export const formatCurrencyDirect = (value, currency = DEFAULT_CURRENCY) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return makeFormatter(currency).format(number);
};
