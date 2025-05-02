import logging
import math
import requests
from datetime import datetime
from django.core.cache import cache
from django.utils import timezone

logger = logging.getLogger(__name__)

COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3"
CACHE_TIMEOUT = 300  # 5 minutes cache


def _is_number(value):
    try:
        return value is not None and not isinstance(value, bool) and math.isfinite(float(value))
    except (TypeError, ValueError):
        return False

def get_current_prices(coin_ids, currency='usd'):
    """
    Fetch current prices from CoinGecko with caching and error handling
    """
    if not coin_ids:
        return {}

    if isinstance(coin_ids, str):
        coin_ids = [coin_ids]

    cache_key = f"prices_{','.join(coin_ids)}_{currency}"
    cached_data = cache.get(cache_key)
    
    if cached_data:
        logger.debug(f"Cache hit for {cache_key}")
        return cached_data

    # Try primary price endpoint
    url = f"{COINGECKO_BASE_URL}/simple/price"
    params = {
        'ids': ','.join(coin_ids),
        'vs_currencies': currency
    }

    try:
        if COINGECKO_API_KEY:
            headers = {'x-cg-pro-api-key': COINGECKO_API_KEY}
        else:
            headers = {}
            
        response = requests.get(url, params=params, headers=headers, timeout=10)
        response.raise_for_status()
        data = response.json()

        # Cache successful responses
        cache.set(cache_key, data, CACHE_TIMEOUT)
        return data

    except requests.RequestException as e:
        logger.warning(f"Primary price fetch failed: {str(e)}")
        
        # Try fallback to /coins/markets endpoint
        try:
            markets_data = get_markets({'vs_currency': currency, 'ids': ','.join(coin_ids)})
            if markets_data:
                price_data = {
                    coin['id']: {
                        currency: coin['current_price']
                    }
                    for coin in markets_data
                }
                cache.set(cache_key, price_data, CACHE_TIMEOUT)
                return price_data
        except Exception as fallback_error:
            logger.error(f"Fallback price fetch failed: {str(fallback_error)}")

        # Return cached data even if expired as last resort
        stale_data = cache.get(cache_key, timeout=None)
        if stale_data:
            logger.info("Returning stale cached data")
            return stale_data
            
        return None

import time
import os

COINGECKO_API_KEY = os.getenv("COINGECKO_API_KEY")  # optional key from env

def get_coin_details(coin_id, vs_currency="usd"):
    """
    Fetch detailed information about a specific coin with fallback to markets data
    """
    if not coin_id:
        return None

    # Try to get from cache first
    cache_key = f"coin_details_{coin_id}_{vs_currency}"
    cached_data = cache.get(cache_key)
    if cached_data:
        return cached_data

    # Try getting data from /coins endpoint first
    headers = {}
    if COINGECKO_API_KEY:
        headers['x-cg-demo-api-key'] = COINGECKO_API_KEY

    try:
        # First attempt: Get detailed data
        url = f"{COINGECKO_BASE_URL}/simple/price"
        # First get the current price in the requested currency
        price_params = {
            'ids': coin_id,
            'vs_currencies': vs_currency.lower(),
            'include_24hr_change': 'true'
        }
        headers = {}
        if COINGECKO_API_KEY:
            headers['x-cg-demo-api-key'] = COINGECKO_API_KEY

        price_response = requests.get(url, params=price_params, headers=headers, timeout=10)
        price_response.raise_for_status()
        price_data = price_response.json()

        # Then get the full coin details
        url = f"{COINGECKO_BASE_URL}/coins/{coin_id}"
        params = {
            'localization': 'false',
            'tickers': 'true',
            'market_data': 'true',
            'community_data': 'true',
            'developer_data': 'true',
            'sparkline': 'true'
        }
        response = requests.get(url, params=params, headers=headers, timeout=10)
        response.raise_for_status()
        data = response.json()
        
        # Inject the current price in requested currency into the response
        if price_data and price_data.get(coin_id):
            current_price = price_data[coin_id]
            if not data.get('market_data'):
                data['market_data'] = {}
            if not data['market_data'].get('current_price'):
                data['market_data']['current_price'] = {}
            data['market_data']['current_price'] = current_price
            
            # Also update 24h changes if available
            if current_price.get(f'{vs_currency.lower()}_24h_change'):
                data['market_data']['price_change_percentage_24h'] = current_price[f'{vs_currency.lower()}_24h_change']
        
        # Cache and return on success
        cache.set(cache_key, data, CACHE_TIMEOUT)
        return data
    except requests.RequestException as e:
        logger.warning(f"Failed to get detailed coin data, trying fallback: {str(e)}")
        
        try:
            # Fallback: Get basic market data
            # Try just getting the price first
            url = f"{COINGECKO_BASE_URL}/simple/price"
            params = {
                'ids': coin_id,
                'vs_currencies': vs_currency.lower(),
                'include_24hr_change': 'true',
                'include_market_cap': 'true',
                'include_24hr_vol': 'true'
            }
            response = requests.get(url, params=params, headers=headers, timeout=10)
            response.raise_for_status()
            price_data = response.json()
            
            if not price_data or not price_data.get(coin_id):
                return None
                
            coin_price_data = price_data[coin_id]
            curr = vs_currency.lower()
                
            # Format basic data to match detailed structure
            basic_data = {
                'id': coin_id,
                'market_data': {
                    'current_price': {
                        curr: coin_price_data[curr]
                    },
                    'market_cap': {
                        curr: coin_price_data.get(f'{curr}_market_cap')
                    },
                    'total_volume': {
                        curr: coin_price_data.get(f'{curr}_24h_vol')
                    },
                    'price_change_percentage_24h': coin_price_data.get(f'{curr}_24h_change')
                }
            }
            
            # Cache this basic data for a shorter time
            cache.set(cache_key, basic_data, 60)  # Cache for 1 minute only
            return basic_data
            
        except requests.RequestException as e:
            logger.error(f"Both detail and fallback requests failed: {str(e)}")
            return None

def get_markets(params=None):
    """
    Fetch market data for top cryptocurrencies with optional extra params.
    If sparkline data is missing, fallback to individual /market_chart requests.
    """
    if params is None:
        params = {}

    vs_currency = params.get("vs_currency", "usd").lower()
    per_page = int(params.get("per_page", 100))
    page = int(params.get("page", 1))
    sparkline_requested = str(params.get("sparkline", "false")).lower() == "true"
    coin_ids = params.get("ids", "")

    cache_key = f"markets_{vs_currency}_{per_page}_{sparkline_requested}_{coin_ids}"
    cached_data = cache.get(cache_key)
    if cached_data:
        return cached_data

    url = f"{COINGECKO_BASE_URL}/coins/markets"
    headers = {"accept": "application/json"}
    if COINGECKO_API_KEY:
        headers["x-cg-demo-api-key"] = COINGECKO_API_KEY  # new CoinGecko header

    query_params = {
        "vs_currency": vs_currency.lower(),  # Ensure lowercase
        "order": "market_cap_desc",
        "per_page": per_page,
        "page": page,
        "sparkline": "true" if sparkline_requested else "false",
        "price_change_percentage": params.get("price_change_percentage", "1h,24h,7d"),
        "localization": "false"  # Ensure we get raw numbers
    }
    
    if params.get("ids"):
        query_params["ids"] = params.get("ids")

    try:
        print("🪙 CoinGecko request URL:", url, query_params)
        response = requests.get(url, params=query_params, headers=headers, timeout=15)
        response.raise_for_status()
        data = response.json()

        if data and len(data) > 0:
            first_coin = data[0]
            sparkline_data = first_coin.get('sparkline_in_7d', {}).get('price', [])
            logger.info(f"Fetched {len(data)} coins. First coin: {first_coin.get('name')}, Sparkline points: {len(sparkline_data)}")

        missing_sparkline = []
        for coin in data:
            prices = coin.get("sparkline_in_7d", {}).get("price", [])
            if prices:
                filtered = [p for p in prices if _is_number(p)]
                if filtered:
                    coin.setdefault("sparkline_in_7d", {})
                    coin["sparkline_in_7d"]["price"] = filtered
                    continue
            missing_sparkline.append(coin)
        if sparkline_requested and missing_sparkline:
            logger.warning(f"Missing/empty sparkline for {len(missing_sparkline)} coins, fetching fallback data...")
            for coin in missing_sparkline[:5]:  # limit to 5 to avoid rate limit
                time.sleep(0.5)  # small delay
                chart_data = get_coin_market_chart(
                    coin["id"], vs_currency=vs_currency, days=7, interval="hourly"
                )
                if chart_data and "prices" in chart_data:
                    sparkline_prices = [p[1] for p in chart_data["prices"] if len(p) > 1 and _is_number(p[1])]
                    coin["sparkline_in_7d"] = {"price": sparkline_prices}
                    logger.info(f"Filled sparkline for {coin['id']} ({len(sparkline_prices)} points)")

        cache.set(cache_key, data, CACHE_TIMEOUT)
        return data

    except requests.RequestException as e:
        logger.error(f"CoinGecko markets API error: {str(e)}")
        return None


def get_coin_market_chart(coin_id, vs_currency="usd", days=7, interval=None):
    """
    Fetch historical market data for a coin.
    Returns: {"prices": [[timestamp, price], ...], ...}
    """
    if not coin_id:
        return None
    
    # Create cache key
    cache_key = f"market_chart_{coin_id}_{vs_currency}_{days}"
    cached_data = cache.get(cache_key)
    if cached_data:
        logger.debug(f"Cache hit for market chart: {cache_key}")
        return cached_data
    
    # Build request URL and params
    url = f"{COINGECKO_BASE_URL}/coins/{coin_id}/market_chart"
    params = {
        'vs_currency': vs_currency.lower(),
        'days': str(days)
    }
    
    if interval:
        params['interval'] = interval
    
    headers = {}
    if COINGECKO_API_KEY:
        headers['x-cg-demo-api-key'] = COINGECKO_API_KEY
    
    try:
        response = requests.get(url, params=params, headers=headers, timeout=10)
        response.raise_for_status()
        data = response.json()
        
        # Cache the result
        cache.set(cache_key, data, CACHE_TIMEOUT)
        logger.info(f"Fetched market chart for {coin_id}: {len(data.get('prices', []))} data points")
        return data
        
    except requests.RequestException as e:
        logger.error(f"Failed to fetch market chart for {coin_id}: {str(e)}")
        return None


def get_price_at_timestamp(coin_id, vs_currency, dt):
    """
    Fetch the closest historical price for a coin around the given datetime.
    Uses market_chart/range with a small +- 2 hour window and picks nearest point.
    Returns a float price or None.
    """
    try:
        if not coin_id or not dt:
            return None
        if timezone.is_naive(dt):
            dt = timezone.make_aware(dt, timezone=timezone.utc)
        ts = int(dt.timestamp())
        frm = ts - 2 * 3600
        to = ts + 2 * 3600
        url = f"{COINGECKO_BASE_URL}/coins/{coin_id}/market_chart/range"
        headers = {"accept": "application/json"}
        if COINGECKO_API_KEY:
            headers["x-cg-demo-api-key"] = COINGECKO_API_KEY
        params = {"vs_currency": vs_currency.lower(), "from": frm, "to": to}
        cache_key = f"price_at_{coin_id}_{vs_currency}_{frm}_{to}"
        cached = cache.get(cache_key)
        if cached is not None:
            prices = cached
        else:
            resp = requests.get(url, params=params, headers=headers, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            prices = data.get("prices", []) if isinstance(data, dict) else []
            cache.set(cache_key, prices, 300)
        if not prices:
            return None
        # pick nearest
        target_ms = ts * 1000
        best = None
        best_abs = None
        for p in prices:
            if isinstance(p, (list, tuple)) and len(p) > 1 and _is_number(p[1]):
                tms = p[0]
                d = abs(tms - target_ms)
                if best is None or d < best_abs:
                    best = float(p[1])
                    best_abs = d
        return best
    except Exception as e:
        logger.error(f"get_price_at_timestamp failed for {coin_id}: {e}")
        return None
def get_global_market_caps(vs_currency="usd", days=7, top_n=100):
    """
    Aggregate total market cap for top N coins over a period
    Returns: {"timestamps": [...], "market_caps": [...]}
    """
    cache_key = f"global_market_caps_{vs_currency}_{days}_{top_n}"
    cached_data = cache.get(cache_key)
    if cached_data:
        return cached_data

    # Fetch top coins
    markets = get_markets({"vs_currency": vs_currency, "per_page": top_n, "page": 1, "sparkline": "true"})
    if not markets:
        return None

    # Initialize timestamps & sums
    timestamps = []
    total_caps = []

    for i, coin in enumerate(markets):
        sparkline = coin.get("sparkline_in_7d", {}).get("price", [])
        if not sparkline:
            continue

        # For the first coin, initialize timestamps
        if i == 0:
            timestamps = list(range(len(sparkline)))
            total_caps = [0] * len(sparkline)

        # Add this coin's market cap estimate
        market_cap = coin.get("market_cap", 0)
        # normalize sparkline by current market cap / current price
        price_series = coin.get("sparkline_in_7d", {}).get("price", [])
        if price_series:
            current_price = price_series[-1]
            factor = market_cap / current_price if current_price else 0
            total_caps = [total_caps[j] + price_series[j] * factor for j in range(len(price_series))]

    data = {"timestamps": timestamps, "market_caps": total_caps}
    cache.set(cache_key, data, CACHE_TIMEOUT)
    return data
