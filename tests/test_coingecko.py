import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timedelta
from django.utils import timezone
from web_app.utils.coingecko import (
    _is_number, get_current_prices, get_coin_details,
    get_markets, get_coin_market_chart,
    get_price_at_timestamp, get_global_market_caps
)

@pytest.mark.parametrize("value,expected", [
    (123, True),
    ("456", True),
    (None, False),
    (float("inf"), False),
    (True, False),
    ("abc", False),
])
def test_is_number(value, expected):
    assert _is_number(value) == expected

# ---------------- get_current_prices ----------------

@pytest.mark.django_db
@patch("web_app.utils.coingecko.cache")
@patch("web_app.utils.coingecko.requests.get")
def test_get_current_prices_cache_hit(mock_get, mock_cache):
    mock_cache.get.return_value = {"btc": {"usd": 5000}}
    result = get_current_prices("btc")
    assert result == {"btc": {"usd": 5000}}
    mock_get.assert_not_called()

@pytest.mark.django_db
@patch("web_app.utils.coingecko.cache")
@patch("web_app.utils.coingecko.requests.get")
def test_get_current_prices_http_success(mock_get, mock_cache):
    mock_cache.get.return_value = None
    mock_response = MagicMock()
    mock_response.json.return_value = {"btc": {"usd": 5000}}
    mock_response.raise_for_status.return_value = None
    mock_get.return_value = mock_response

    result = get_current_prices("btc")
    assert result["btc"]["usd"] == 5000
    mock_cache.set.assert_called_once()


# ---------------- get_coin_details ----------------

@pytest.mark.django_db
@patch("web_app.utils.coingecko.cache")
@patch("web_app.utils.coingecko.requests.get")
def test_get_coin_details_cache_hit(mock_get, mock_cache):
    mock_cache.get.return_value = {"id": "btc"}
    result = get_coin_details("btc")
    assert result["id"] == "btc"
    mock_get.assert_not_called()

@pytest.mark.django_db
@patch("web_app.utils.coingecko.cache")
@patch("web_app.utils.coingecko.requests.get")
def test_get_coin_details_http_success(mock_get, mock_cache):
    mock_cache.get.return_value = None
    mock_price_resp = MagicMock()
    mock_price_resp.json.return_value = {"btc": {"usd": 5000}}
    mock_price_resp.raise_for_status.return_value = None
    mock_detail_resp = MagicMock()
    mock_detail_resp.json.return_value = {"id": "btc"}
    mock_detail_resp.raise_for_status.return_value = None
    mock_get.side_effect = [mock_price_resp, mock_detail_resp]

    result = get_coin_details("btc")
    assert result["id"] == "btc"
    mock_cache.set.assert_called()

# ---------------- get_markets ----------------

@pytest.mark.django_db
@patch("web_app.utils.coingecko.cache")
@patch("web_app.utils.coingecko.requests.get")
def test_get_markets_cache_hit(mock_get, mock_cache):
    mock_cache.get.return_value = [{"id": "btc"}]
    result = get_markets()
    assert result[0]["id"] == "btc"
    mock_get.assert_not_called()

@pytest.mark.django_db
@patch("web_app.utils.coingecko.cache")
@patch("web_app.utils.coingecko.requests.get")
def test_get_markets_http_success(mock_get, mock_cache):
    mock_cache.get.return_value = None
    mock_response = MagicMock()
    mock_response.json.return_value = [{"id": "btc", "sparkline_in_7d": {"price": [1,2,3]}, "market_cap": 1000}]
    mock_response.raise_for_status.return_value = None
    mock_get.return_value = mock_response

    result = get_markets()
    assert result[0]["id"] == "btc"
    mock_cache.set.assert_called()

# ---------------- get_coin_market_chart ----------------

@pytest.mark.django_db
@patch("web_app.utils.coingecko.cache")
@patch("web_app.utils.coingecko.requests.get")
def test_get_coin_market_chart_cache_hit(mock_get, mock_cache):
    mock_cache.get.return_value = {"prices": [[1, 100]]}
    result = get_coin_market_chart("btc")
    assert result["prices"][0][1] == 100
    mock_get.assert_not_called()

@pytest.mark.django_db
@patch("web_app.utils.coingecko.cache")
@patch("web_app.utils.coingecko.requests.get")
def test_get_coin_market_chart_http_success(mock_get, mock_cache):
    mock_cache.get.return_value = None
    mock_resp = MagicMock()
    mock_resp.json.return_value = {"prices": [[1, 100], [2, 200]]}
    mock_resp.raise_for_status.return_value = None
    mock_get.return_value = mock_resp

    result = get_coin_market_chart("btc")
    assert result["prices"][1][1] == 200
    mock_cache.set.assert_called()

# ---------------- get_price_at_timestamp ----------------

@pytest.mark.django_db
@patch("web_app.utils.coingecko.cache")
@patch("web_app.utils.coingecko.requests.get")
def test_get_price_at_timestamp(mock_get, mock_cache):
    mock_cache.get.return_value = None
    ts = int((timezone.now() - timedelta(hours=1)).timestamp()) * 1000
    mock_resp = MagicMock()
    mock_resp.json.return_value = {"prices": [[ts, 123]]}
    mock_resp.raise_for_status.return_value = None
    mock_get.return_value = mock_resp

    dt = timezone.now() - timedelta(hours=1)
    price = get_price_at_timestamp("btc", "usd", dt)
    assert price == 123

# ---------------- get_global_market_caps ----------------

@pytest.mark.django_db
@patch("web_app.utils.coingecko.get_markets")
@patch("web_app.utils.coingecko.cache")
def test_get_global_market_caps(mock_cache, mock_markets):
    mock_cache.get.return_value = None
    # prepare 2 coins with sparkline
    mock_markets.return_value = [
        {"sparkline_in_7d": {"price": [1,2,3]}, "market_cap": 3, "id": "btc"},
        {"sparkline_in_7d": {"price": [2,3,4]}, "market_cap": 4, "id": "eth"},
    ]
    result = get_global_market_caps(top_n=2)
    assert "timestamps" in result
    assert "market_caps" in result
    assert len(result["market_caps"]) == 3
