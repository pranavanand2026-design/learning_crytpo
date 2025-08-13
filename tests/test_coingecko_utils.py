import math
from datetime import datetime, timedelta, timezone as dt_timezone
from types import SimpleNamespace

import pytest
import requests

from django.core.cache import cache

from web_app.utils import coingecko


@pytest.fixture(autouse=True)
def clear_cache():
    cache.clear()
    yield
    cache.clear()


class DummyResponse:
    def __init__(self, json_data, status_code=200):
        self._json = json_data
        self.status_code = status_code

    def json(self):
        return self._json

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"status={self.status_code}")


def test_get_current_prices_cache_hit(monkeypatch):
    cache.set("prices_btc_usd", {"btc": {"usd": 1}}, 60)
    result = coingecko.get_current_prices(["btc"], "usd")
    assert result == {"btc": {"usd": 1}}


def test_get_current_prices_fallback_to_markets(monkeypatch):
    def fake_get(*args, **kwargs):
        raise requests.RequestException("primary down")

    monkeypatch.setattr(coingecko.requests, "get", fake_get)
    monkeypatch.setattr(
        coingecko,
        "get_markets",
        lambda params: [{"id": "btc", "current_price": 42000}],
    )
    result = coingecko.get_current_prices(["btc"], "usd")
    assert result == {"btc": {"usd": 42000}}


def test_get_current_prices_returns_none(monkeypatch):
    class DummyCache:
        def get(self, *args, **kwargs):
            return None

        def set(self, *args, **kwargs):
            pass

    monkeypatch.setattr(coingecko, "cache", DummyCache())
    monkeypatch.setattr(coingecko, "COINGECKO_API_KEY", None)

    def fake_get(*args, **kwargs):
        raise requests.RequestException("primary down")

    monkeypatch.setattr(coingecko.requests, "get", fake_get)
    monkeypatch.setattr(coingecko, "get_markets", lambda params: None)
    result = coingecko.get_current_prices(["btc"], "usd")
    assert result is None


def test_get_current_prices_returns_stale(monkeypatch):
    class DummyCache:
        def get(self, key, default=None, **kwargs):
            if kwargs.get("timeout") is None:
                return {"btc": {"usd": 99}}
            return None

        def set(self, *args, **kwargs):
            pass

    monkeypatch.setattr(coingecko, "cache", DummyCache())
    monkeypatch.setattr(coingecko.requests, "get", lambda *a, **k: (_ for _ in ()).throw(requests.RequestException("fail")))
    monkeypatch.setattr(coingecko, "get_markets", lambda params: (_ for _ in ()).throw(RuntimeError("fallback boom")))
    data = coingecko.get_current_prices(["btc"], "usd")
    assert data == {"btc": {"usd": 99}}


def test_get_current_prices_fallback_exception(monkeypatch):
    monkeypatch.setattr(coingecko.requests, "get", lambda *a, **k: (_ for _ in ()).throw(requests.RequestException("fail")))

    def bad_markets(params):
        raise RuntimeError("boom")

    monkeypatch.setattr(coingecko, "get_markets", bad_markets)
    monkeypatch.setattr(coingecko.cache, "get", lambda *args, **kwargs: None, raising=False)
    assert coingecko.get_current_prices(["btc"], "usd") is None


def test_get_coin_details_success(monkeypatch):
    responses = [
        DummyResponse({"bitcoin": {"usd": 50000, "usd_24h_change": 1.5}}),
        DummyResponse({"market_data": {"current_price": {"usd": 50000}}}),
    ]

    def fake_get(url, *args, **kwargs):
        return responses.pop(0)

    monkeypatch.setattr(coingecko.requests, "get", fake_get)
    data = coingecko.get_coin_details("bitcoin", "usd")
    assert data["market_data"]["current_price"]["usd"] == 50000
    assert "price_change_percentage_24h" in data["market_data"]


def test_get_coin_details_injects_market_data(monkeypatch):
    responses = [
        DummyResponse({"bitcoin": {"usd": 123, "usd_24h_change": 3.5}}),
        DummyResponse({"id": "bitcoin"}),
    ]

    monkeypatch.setattr(coingecko.requests, "get", lambda *a, **k: responses.pop(0))
    data = coingecko.get_coin_details("bitcoin", "usd")
    assert data["market_data"]["current_price"]["usd"] == 123
    assert data["market_data"]["price_change_percentage_24h"] == 3.5


def test_get_coin_details_fallback(monkeypatch):
    call_state = {"count": 0}

    def fake_get(url, *args, **kwargs):
        call_state["count"] += 1
        if call_state["count"] == 1:
            raise requests.RequestException("primary down")
        return DummyResponse(
            {"bitcoin": {"usd": 100, "usd_24h_change": 2, "usd_market_cap": 1000, "usd_24h_vol": 50}}
        )

    monkeypatch.setattr(coingecko.requests, "get", fake_get)
    data = coingecko.get_coin_details("bitcoin", "usd")
    assert data["market_data"]["current_price"]["usd"] == 100
    assert data["market_data"]["total_volume"]["usd"] == 50


def test_get_coin_details_fallback_returns_none(monkeypatch):
    call_state = {"count": 0}

    def fake_get(url, *args, **kwargs):
        call_state["count"] += 1
        if call_state["count"] < 2:
            raise requests.RequestException("always down")
        return DummyResponse({})

    monkeypatch.setattr(coingecko.requests, "get", fake_get)
    assert coingecko.get_coin_details("bitcoin", "usd") is None


def test_get_coin_details_failure(monkeypatch):
    def fake_get(*args, **kwargs):
        raise requests.RequestException("boom")

    monkeypatch.setattr(coingecko.requests, "get", fake_get)
    assert coingecko.get_coin_details("bitcoin") is None


def test_get_markets_success_with_fallback(monkeypatch):
    payload = [
        {
            "id": "btc",
            "sparkline_in_7d": {"price": [1, 2, math.nan]},
            "market_cap": 1000,
        }
    ]

    monkeypatch.setattr(
        coingecko.requests,
        "get",
        lambda *args, **kwargs: DummyResponse(payload),
    )
    monkeypatch.setattr(
        coingecko,
        "get_coin_market_chart",
        lambda coin_id, vs_currency, days, interval=None: {"prices": [[0, 1], [1, 2]]},
    )
    data = coingecko.get_markets({"vs_currency": "usd", "sparkline": "true"})
    assert data[0]["sparkline_in_7d"]["price"] == [1, 2]


def test_get_markets_cache_hit(monkeypatch):
    cache_key = "markets_usd_100_False_"
    cache.set(cache_key, [{"id": "cached"}], 60)
    monkeypatch.setattr(
        coingecko.requests,
        "get",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("network called")),
    )
    data = coingecko.get_markets({"vs_currency": "usd"})
    assert data == [{"id": "cached"}]


def test_get_markets_request_failure(monkeypatch):
    monkeypatch.setattr(coingecko.requests, "get", lambda *a, **k: (_ for _ in ()).throw(requests.RequestException("fail")))
    assert coingecko.get_markets({"vs_currency": "usd"}) is None


def test_get_coin_market_chart_success(monkeypatch):
    monkeypatch.setattr(
        coingecko.requests,
        "get",
        lambda *args, **kwargs: DummyResponse({"prices": [[0, 1], [1, 2]]}),
    )
    data = coingecko.get_coin_market_chart("bitcoin", "usd", 1)
    assert data["prices"] == [[0, 1], [1, 2]]


def test_get_coin_market_chart_cached(monkeypatch):
    cache_key = "market_chart_bitcoin_usd_1"
    cache.set(cache_key, {"prices": [[0, 3]]}, 60)
    data = coingecko.get_coin_market_chart("bitcoin", "usd", 1)
    assert data == {"prices": [[0, 3]]}


def test_get_coin_market_chart_failure(monkeypatch):
    monkeypatch.setattr(coingecko.requests, "get", lambda *a, **k: (_ for _ in ()).throw(requests.RequestException("fail")))
    assert coingecko.get_coin_market_chart("bitcoin", "usd", 1) is None


def test_get_price_at_timestamp_with_cache(monkeypatch):
    now = datetime.now(dt_timezone.utc)
    cache_key = f"price_at_btc_usd_{int(now.timestamp()) - 7200}_{int(now.timestamp()) + 7200}"
    cache.set(cache_key, [[int(now.timestamp()) * 1000, 123.4]], 60)
    price = coingecko.get_price_at_timestamp("btc", "usd", now)
    assert price == 123.4


def test_get_price_at_timestamp_handles_exception(monkeypatch):
    def fake_get(*args, **kwargs):
        raise requests.RequestException("fail")

    monkeypatch.setattr(coingecko.requests, "get", fake_get)
    ts = datetime.now(dt_timezone.utc)
    assert coingecko.get_price_at_timestamp("btc", "usd", ts) is None


def test_get_price_at_timestamp_no_prices(monkeypatch):
    def fake_get(*args, **kwargs):
        return DummyResponse({"prices": []})

    monkeypatch.setattr(coingecko.requests, "get", fake_get)
    ts = datetime.now(dt_timezone.utc)
    assert coingecko.get_price_at_timestamp("btc", "usd", ts) is None


def test_get_global_market_caps(monkeypatch):
    sample_markets = [
        {
            "market_cap": 1000,
            "sparkline_in_7d": {"price": [10, 12]},
        },
        {
            "market_cap": 500,
            "sparkline_in_7d": {"price": [5, 7]},
        },
    ]

    monkeypatch.setattr(coingecko, "get_markets", lambda params: sample_markets)
    data = coingecko.get_global_market_caps("usd", 7, top_n=2)
    assert data["timestamps"] == [0, 1]
    assert len(data["market_caps"]) == 2


def test_is_number(monkeypatch):
    assert coingecko._is_number(5)
    assert not coingecko._is_number("abc")
    assert not coingecko._is_number(True)
