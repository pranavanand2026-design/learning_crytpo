import logging
from django.db.models import Sum, F
from rest_framework import serializers
from .models import (
    User, CurrentPrice, PriceCache, Coin, WatchListItem,
    Simulation, Transaction, Holding,
)

# ------------------------------------------------------------------------------
# Logging setup
# ------------------------------------------------------------------------------
logger = logging.getLogger(__name__)

# ------------------------------------------------------------------------------
# Base Serializer with Common Error Handling
# ------------------------------------------------------------------------------
class SafeModelSerializer(serializers.ModelSerializer):
    """
    A base serializer with built-in error handling and logging for safe operations.
    """
    def handle_exception(self, exc, context=""):
        logger.exception(f"Error in serializer {self.__class__.__name__}: {str(exc)} | Context: {context}")
        raise serializers.ValidationError({"detail": "Internal serializer error."})

# ------------------------------------------------------------------------------
# User Serializers
# ------------------------------------------------------------------------------
class UserRegistrationSerializer(SafeModelSerializer):
    class Meta:
        model = User
        fields = ("id", "email", "password", "display_name")
        extra_kwargs = {"password": {"write_only": True}}

    def create(self, validated_data):
        try:
            user = User.objects.create_user(
                email=validated_data["email"],
                username=validated_data["email"],
                password=validated_data["password"],
                display_name=validated_data["display_name"]
            )
            logger.info(f"User created successfully: {user.email}")
            return user
        except Exception as e:
            self.handle_exception(e, "UserRegistrationSerializer.create")


class UserProfileSerializer(SafeModelSerializer):
    class Meta:
        model = User
        fields = [
            "id", "email", "display_name",
            "preferred_currency", "timezone", "date_format",
        ]
        read_only_fields = ["id", "email"]

# ------------------------------------------------------------------------------
# Price Serializers
# ------------------------------------------------------------------------------
class CurrentPriceSerializer(SafeModelSerializer):
    class Meta:
        model = CurrentPrice
        fields = ["id", "coin_id", "price", "currency", "last_updated"]


class PriceCacheSerializer(SafeModelSerializer):
    class Meta:
        model = PriceCache
        fields = [
            "id", "coin_id", "price", "currency",
            "price_date", "fetched_at", "source", "price_data",
        ]

# ------------------------------------------------------------------------------
# Coin Serializers
# ------------------------------------------------------------------------------
class CoinSerializer(SafeModelSerializer):
    class Meta:
        model = Coin
        fields = ["id", "symbol", "name", "current_price", "price_change_24h", "market_cap"]


class CoinDetailSerializer(SafeModelSerializer):
    price_history = serializers.SerializerMethodField()

    class Meta:
        model = Coin
        fields = ["id", "symbol", "name", "current_price", "market_cap", "price_history"]

    def get_price_history(self, obj):
        try:
            # Placeholder: fetch historical data for the coin based on 'range' context
            range_param = self.context.get("range", "7d")
            logger.debug(f"Fetching price history for {obj.symbol} | range={range_param}")
            return []  # Will later connect to PriceCache
        except Exception as e:
            self.handle_exception(e, "CoinDetailSerializer.get_price_history")

# ------------------------------------------------------------------------------
# Watchlist
# ------------------------------------------------------------------------------
class WatchlistSerializer(SafeModelSerializer):
    coin_id = serializers.CharField(write_only=True)
    coin = CoinSerializer(read_only=True)

    class Meta:
        model = WatchListItem
        fields = ["id", "coin_id", "coin", "simulation_id", "created_at"]
        read_only_fields = ["id", "created_at"]

# ------------------------------------------------------------------------------
# Transaction
# ------------------------------------------------------------------------------
class TransactionSerializer(SafeModelSerializer):
    coin = CoinSerializer(read_only=True)
    coin_id = serializers.CharField(write_only=True)

    class Meta:
        model = Transaction
        fields = [
            "id", "type", "coin", "coin_id",
            "quantity", "price", "price_currency",
            "time", "fee", "simulation_id",
            "realised_profit", "realised_profit_currency",
        ]
        read_only_fields = ["id", "time", "realised_profit", "realised_profit_currency"]

    def validate(self, attrs):
        try:
            q = attrs.get("quantity")
            if q is None or float(q) <= 0:
                raise serializers.ValidationError({"quantity": "Quantity must be greater than 0"})
            t = attrs.get("type")
            if t not in ("BUY", "SELL"):
                raise serializers.ValidationError({"type": "Invalid type"})
            return attrs
        except Exception as e:
            self.handle_exception(e, "TransactionSerializer.validate")

    def create(self, validated_data):
        try:
            coin_id = validated_data.pop("coin_id", None)
            if not coin_id:
                raise serializers.ValidationError({"coin_id": "coin_id is required"})
            try:
                coin = Coin.objects.get(id=coin_id)
            except Coin.DoesNotExist:
                # Try to fetch minimal coin info and create
                try:
                    from .utils.coingecko import get_coin_details
                    cd = get_coin_details(coin_id, "usd") or {}
                    symbol = (cd.get("symbol") or "").upper() or coin_id[:5]
                    name = cd.get("name") or coin_id
                    price = 0
                    if cd.get("market_data") and cd["market_data"].get("current_price"):
                        price = cd["market_data"]["current_price"].get("usd", 0) or 0
                    coin = Coin.objects.create(
                        id=coin_id,
                        symbol=symbol,
                        name=name,
                        current_price=price,
                    )
                except Exception:
                    raise serializers.ValidationError({"coin_id": "Unknown coin"})
            validated_data["coin"] = coin
            # If price is missing, attempt to fetch current price in user's currency
            if "price" not in validated_data:
                try:
                    request = self.context.get("request")
                    currency = getattr(getattr(request, "user", None), "preferred_currency", "USD").lower()
                    from .utils.coingecko import get_current_prices
                    mp = get_current_prices([coin_id], currency) or {}
                    p = mp.get(coin_id, {}).get(currency)
                    if p is not None:
                        from decimal import Decimal, ROUND_HALF_UP
                        validated_data["price"] = Decimal(str(p)).quantize(Decimal("0.0000000001"), rounding=ROUND_HALF_UP)
                except Exception:
                    pass
            else:
                # Ensure no more than 10 dp
                try:
                    from decimal import Decimal, ROUND_HALF_UP
                    validated_data["price"] = Decimal(str(validated_data["price"]))\
                        .quantize(Decimal("0.0000000001"), rounding=ROUND_HALF_UP)
                except Exception:
                    pass
            request = self.context.get("request")
            currency = getattr(getattr(request, "user", None), "preferred_currency", "USD") if request else "USD"
            currency_code = currency.upper() if isinstance(currency, str) else "USD"
            validated_data.setdefault("price_currency", currency_code)
            validated_data.setdefault("realised_profit_currency", currency_code)
            return super().create(validated_data)
        except Exception as e:
            self.handle_exception(e, "TransactionSerializer.create")

# ------------------------------------------------------------------------------
# Simulation Serializers
# ------------------------------------------------------------------------------
class SimulationCreateSerializer(SafeModelSerializer):
    class Meta:
        model = Simulation
        fields = ["id", "name", "description", "start_date", "end_date", "status"]

    def validate(self, attrs):
        request = self.context.get("request")
        user = getattr(request, "user", None)
        name = attrs.get("name")
        # Disallow future start_date
        start_date = attrs.get("start_date")
        from django.utils import timezone
        if start_date and start_date > timezone.localdate():
            raise serializers.ValidationError({"start_date": "Start date cannot be in the future."})
        # Unique name per user (case-insensitive)
        if user and name:
            if Simulation.objects.filter(user=user, name__iexact=name).exists():
                raise serializers.ValidationError({"name": "Simulation with this name already exists."})
        return attrs
    def validate(self, attrs):
        try:
            # Enforce unique simulation name per user (case-insensitive)
            request = self.context.get("request")
            user = getattr(request, "user", None)
            name = attrs.get("name")
            if user and name:
                if Simulation.objects.filter(user=user, name__iexact=name).exists():
                    raise serializers.ValidationError({"name": "Simulation with this name already exists."})
            return attrs
        except Exception as e:
            self.handle_exception(e, "SimulationCreateSerializer.validate")

    def create(self, validated_data):
        try:
            # Allow user to be provided by perform_create via serializer.save(user=...)
            # or, if absent, try to take it from request context.
            user = validated_data.pop("user", None)
            if user is None:
                request = self.context.get("request")
                user = getattr(request, "user", None)
            if user is None or not getattr(user, "is_authenticated", False):
                raise serializers.ValidationError({"detail": "Authentication required"})
            return Simulation.objects.create(user=user, **validated_data)
        except Exception as e:
            self.handle_exception(e, "SimulationCreateSerializer.create")


class SimulationSummarySerializer(SafeModelSerializer):
    invested = serializers.SerializerMethodField()
    units = serializers.SerializerMethodField()
    current_value = serializers.SerializerMethodField()

    class Meta:
        model = Simulation
        fields = [
            "id", "name", "status", "start_date", "end_date",
            "created_at", "invested", "units", "current_value"
        ]

    def _current_price(self, coin, vs_currency="USD"):
        """
        Get current price with fallback to cached or static coin price.
        """
        try:
            cp = getattr(coin, "live_price", None)
            if cp and cp.currency.lower() == vs_currency.lower():
                return float(cp.price)
            return float(getattr(coin, "current_price", 0))
        except Exception as e:
            logger.warning(f"Failed to get current price for coin {coin}: {e}")
            return 0.0

    def get_invested(self, obj):
        try:
            buys = obj.transactions.filter(type="BUY").aggregate(
                v=Sum(F("price") * F("quantity"))
            )["v"] or 0
            sells = obj.transactions.filter(type="SELL").aggregate(
                v=Sum(F("price") * F("quantity"))
            )["v"] or 0
            return round(float(buys) - float(sells), 2)
        except Exception as e:
            self.handle_exception(e, "SimulationSummarySerializer.get_invested")

    def get_units(self, obj):
        try:
            # Sum net quantities from transactions (BUY - SELL)
            total = 0.0
            for t in obj.transactions.all():
                q = float(getattr(t, "quantity", 0) or 0)
                total += q if t.type == "BUY" else -q
            return round(max(total, 0.0), 4)
        except Exception as e:
            self.handle_exception(e, "SimulationSummarySerializer.get_units")

    def get_current_value(self, obj):
        try:
            vs = getattr(obj.user, "preferred_currency", "USD")
            # Compute net qty per coin id
            totals = {}
            for t in obj.transactions.select_related("coin"):
                if not t.coin:
                    continue
                cid = getattr(t.coin, "id", None)
                if not cid:
                    continue
                qty = float(getattr(t, "quantity", 0) or 0)
                if t.type == "SELL":
                    qty = -qty
                totals[cid] = totals.get(cid, 0.0) + qty

            # Fetch current prices in one call
            ids = [cid for cid, q in totals.items() if q > 0]
            prices = {}
            if ids:
                try:
                    from .utils.coingecko import get_current_prices
                    data = get_current_prices(ids, vs.lower()) or {}
                    for cid in ids:
                        p = (data.get(cid) or {}).get(vs.lower())
                        if p is not None:
                            prices[cid] = float(p)
                except Exception:
                    prices = {}

            total_value = 0.0
            for cid, qty in totals.items():
                if qty <= 0:
                    continue
                p = prices.get(cid)
                if p is None:
                    # safe fallback to the coin model via any tx
                    tx = obj.transactions.filter(coin__id=cid).select_related("coin").first()
                    coin = getattr(tx, "coin", None)
                    p = self._current_price(coin, vs) if coin else 0.0
                total_value += qty * float(p or 0)
            return round(total_value, 2)
        except Exception as e:
            self.handle_exception(e, "SimulationSummarySerializer.get_current_value")

# ------------------------------------------------------------------------------
# Simulation Detail
# ------------------------------------------------------------------------------
class SimulationDetailSerializer(SimulationSummarySerializer):
    positions = serializers.SerializerMethodField()

    class Meta(SimulationSummarySerializer.Meta):
        fields = SimulationSummarySerializer.Meta.fields + ["description", "positions"]

    def get_positions(self, obj):
        try:
            txs = obj.transactions.select_related("coin").order_by("-time")[:200]
            return TransactionSerializer(txs, many=True).data
        except Exception as e:
            self.handle_exception(e, "SimulationDetailSerializer.get_positions")

class WatchListItemSerializer(SafeModelSerializer):
    coin_data = serializers.SerializerMethodField()
    
    class Meta:
        model = WatchListItem
        fields = ['id', 'coin', 'coin_data', 'created_at']
        read_only_fields = ['id', 'created_at']

    def get_coin_data(self, obj):
        try:
            return {
                'id': obj.coin.id,
                'symbol': obj.coin.symbol,
                'name': obj.coin.name,
                'current_price': float(obj.coin.current_price),
                'price_change_24h': float(obj.coin.price_change_24h),
                'market_cap': float(obj.coin.market_cap),
                'last_updated': obj.coin.last_updated
            }
        except Exception as e:
            self.handle_exception(e, "get_coin_data")

    def validate(self, data):
        try:
            # Ensure user isn't duplicating watchlist entry
            existing = WatchListItem.objects.filter(
                user=self.context['request'].user,
                coin=data['coin']
            ).exists()
            
            if existing:
                raise serializers.ValidationError({
                    "coin": "This coin is already in your watchlist"
                })
            return data
        except Exception as e:
            self.handle_exception(e, "validate")

    def create(self, validated_data):
        try:
            user = validated_data.pop("user", None)
            if user is None:
                request = self.context.get("request")
                user = getattr(request, "user", None)
            if user is None:
                raise serializers.ValidationError({"user": "User context missing"})
            return WatchListItem.objects.create(user=user, **validated_data)
        except Exception as e:
            self.handle_exception(e, "create")


class PortfolioHoldingSerializer(SafeModelSerializer):
    coin_data = serializers.SerializerMethodField()
    holding_id = serializers.CharField(source="id", read_only=True)
    coin_id = serializers.CharField(source="coin.id", read_only=True)

    class Meta:
        model = Holding
        fields = [
            "holding_id",
            "coin_id",
            "coin_data",
            "quantity",
            "avg_price",
            "avg_price_currency",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields

    def get_coin_data(self, obj):
        try:
            coin = obj.coin
            return {
                "id": coin.id,
                "symbol": coin.symbol,
                "name": coin.name,
                "current_price": float(getattr(coin, "current_price", 0) or 0),
                "price_change_24h": float(getattr(coin, "price_change_24h", 0) or 0),
                "market_cap": float(getattr(coin, "market_cap", 0) or 0),
                "last_updated": getattr(coin, "last_updated", None),
            }
        except Exception as e:
            self.handle_exception(e, "PortfolioHoldingSerializer.get_coin_data")
