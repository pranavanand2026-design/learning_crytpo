import pytest
from django.utils import timezone
from rest_framework.exceptions import ValidationError
from web_app.serializers import (
    UserRegistrationSerializer, UserProfileSerializer,
    TransactionSerializer, SimulationCreateSerializer,
    SimulationSummarySerializer, SimulationDetailSerializer,
    WatchListItemSerializer, PortfolioHoldingSerializer,
    CoinDetailSerializer,
)
from datetime import timedelta
from web_app.models import User, Coin, Transaction, Simulation, WatchListItem, Holding
from types import SimpleNamespace
from unittest.mock import patch
from rest_framework.test import APIRequestFactory
from decimal import Decimal


def get_valid_simulation_data(**overrides):
    data = {
        "name": "Test Simulation",
        "start_date": timezone.now().date() + timedelta(days=1),
    }
    data.update(overrides)
    return data

# ---------------- User Serializers ----------------

@pytest.mark.django_db
def test_user_registration_serializer_create_success():
    data = {"email": "test@example.com", "password": "pass123", "display_name": "Tester"}
    serializer = UserRegistrationSerializer(data=data)
    assert serializer.is_valid(raise_exception=True)
    user = serializer.save()
    assert user.email == "test@example.com"
    assert user.display_name == "Tester"
    assert user.check_password("pass123")


@pytest.mark.django_db
def test_user_profile_serializer_fields():
    user = User.objects.create_user(email="u@example.com", username="u@example.com", password="pass")
    serializer = UserProfileSerializer(user)
    data = serializer.data
    assert data["id"] == str(user.id)
    assert data["email"] == user.email
    assert data["display_name"] == user.display_name

# ---------------- TransactionSerializer ----------------


@pytest.mark.django_db
def test_transaction_serializer_invalid_quantity():
    coin = Coin.objects.create(id="eth", symbol="ETH", name="Ethereum", current_price=100)
    data = {"type": "BUY", "quantity": 0, "coin_id": coin.id}
    serializer = TransactionSerializer(data=data)
    with pytest.raises(ValidationError):
        serializer.is_valid(raise_exception=True)

@pytest.mark.django_db
def test_transaction_serializer_invalid_type():
    coin = Coin.objects.create(id="xrp", symbol="XRP", name="Ripple", current_price=1)
    data = {"type": "HOLD", "quantity": 10, "coin_id": coin.id}
    serializer = TransactionSerializer(data=data)
    with pytest.raises(ValidationError):
        serializer.is_valid(raise_exception=True)

# ---------------- Simulation Serializers ----------------

@pytest.mark.django_db
def test_simulation_create_serializer_future_start_date():
    user = User.objects.create_user(email="sim2@example.com", username="sim2@example.com", password="pass")
    request = SimpleNamespace(user=user)
    context = {"request": request}

    future_date = timezone.now().date() + timedelta(days=1)
    serializer = SimulationCreateSerializer(
        data=get_valid_simulation_data(name="SimFuture", start_date=future_date),
        context=context
    )
    assert serializer.is_valid(raise_exception=True)
    sim = serializer.save()
    assert sim.user == user
    assert sim.start_date == future_date

@pytest.mark.django_db
def test_simulation_summary_serializer_methods():
    user = User.objects.create_user(email="suser@example.com", username="suser@example.com", password="pass")
    sim = Simulation.objects.create(user=user, name="Sim1", start_date=timezone.now().date() + timedelta(days=1))
    coin = Coin.objects.create(id="btc", symbol="BTC", name="Bitcoin", current_price=1000)
    Transaction.objects.create(simulation=sim, coin=coin, type="BUY", quantity=2, price=1000, user=user)

    serializer = SimulationSummarySerializer(sim)
    assert serializer.get_invested(sim) == 2000
    assert serializer.get_units(sim) == 2
    val = serializer.get_current_value(sim)
    assert isinstance(val, float)

@pytest.mark.django_db
def test_simulation_detail_serializer_positions():
    user = User.objects.create_user(email="suser2@example.com", username="suser2@example.com", password="pass")
    sim = Simulation.objects.create(user=user, name="SimDetail", start_date=timezone.now().date() + timedelta(days=1))
    coin = Coin.objects.create(id="eth", symbol="ETH", name="Ethereum", current_price=200)
    tx = Transaction.objects.create(simulation=sim, coin=coin, type="BUY", quantity=3, price=200, user=user)

    serializer = SimulationDetailSerializer(sim)
    positions = serializer.get_positions(sim)
    assert not(any(p["id"] == tx.id for p in positions))

# ---------------- WatchListItemSerializer ----------------

@pytest.mark.django_db
def test_watchlist_serializer_create():
    user = User.objects.create_user(email="wuser@example.com", username="wuser@example.com", password="pass")
    coin = Coin.objects.create(id="btc", symbol="BTC", name="Bitcoin", current_price=1000)
    request = SimpleNamespace(user=user)
    context = {"request": request}

    serializer = WatchListItemSerializer(data={"coin": coin.id}, context=context)
    serializer.is_valid(raise_exception=True)
    witem = serializer.save(user=user)
    assert witem.coin.id == coin.id

@pytest.mark.django_db
def test_watchlist_serializer_duplicate():
    user = User.objects.create_user(email="wuser2@example.com", username="wuser2@example.com", password="pass")
    coin = Coin.objects.create(id="eth", symbol="ETH", name="Ethereum", current_price=100)
    WatchListItem.objects.create(user=user, coin=coin)
    request = SimpleNamespace(user=user)
    context = {"request": request}

    serializer = WatchListItemSerializer(data={"coin": coin.id}, context=context)
    with pytest.raises(ValidationError):
        serializer.is_valid(raise_exception=True)

# ---------------- PortfolioHoldingSerializer ----------------

@pytest.mark.django_db
def test_portfolio_holding_serializer_coin_data():
    user = User.objects.create_user(email="puser@example.com", username="puser@example.com", password="pass")
    coin = Coin.objects.create(id="btc", symbol="BTC", name="Bitcoin", current_price=500)
    holding = Holding.objects.create(user=user, coin=coin, quantity=2, avg_price=400, avg_price_currency="USD")
    serializer = PortfolioHoldingSerializer(holding)
    data = serializer.data
    assert data["coin_data"]["symbol"] == "BTC"
    assert data["coin_data"]["current_price"] == 500


@pytest.mark.django_db
class TestTransactionSerializer:

    @pytest.fixture
    def user(self):
        return User.objects.create_user(
            username="testuser", email="test@example.com", password="password123"
        )

    @pytest.fixture
    def coin(self):
        return Coin.objects.create(id="bitcoin", symbol="BTC", name="Bitcoin", current_price=50000)

    @pytest.fixture
    def request_factory(self, user):
        factory = APIRequestFactory()
        request = factory.post("/transactions/")
        request.user = user
        return request

   

    
     


@pytest.mark.django_db
class TestSimulationCreateSerializer:

    @pytest.fixture
    def user(self):
        return User.objects.create_user(
            username="simuser", email="sim@example.com", password="password123"
        )

    @pytest.fixture
    def request_factory(self, user):
        factory = APIRequestFactory()
        request = factory.post("/simulations/")
        request.user = user
        return request


    def test_valid_simulation_creation(self, request_factory, user):
        data = {"name": "ValidSim", "start_date": timezone.localdate()}
        serializer = SimulationCreateSerializer(data=data, context={"request": request_factory})
        validated_data = serializer.validate(data)
        sim = Simulation.objects.create(user=user, **validated_data)
        assert sim.name == "ValidSim"
        assert sim.user == user


@pytest.mark.django_db
def test_transaction_serializer_creates_missing_coin(monkeypatch):
    user = User.objects.create_user(email="create@example.com", username="create@example.com", password="pass")
    user.preferred_currency = "aud"
    user.save()

    request = SimpleNamespace(user=user)

    payload = {"type": "BUY", "quantity": 1, "coin_id": "new-coin"}

    monkeypatch.setattr(
        "web_app.utils.coingecko.get_coin_details",
        lambda coin_id, _: {
            "symbol": "ncn",
            "name": "New Coin",
            "market_data": {"current_price": {"usd": 2}},
        },
    )
    monkeypatch.setattr(
        "web_app.utils.coingecko.get_current_prices",
        lambda ids, currency: {payload["coin_id"]: {currency: 123.456789}},
    )

    serializer = TransactionSerializer(data=payload, context={"request": request})
    serializer.is_valid(raise_exception=True)
    tx = serializer.save(user=user)

    assert tx.coin.id == payload["coin_id"]
    assert tx.price == Decimal("123.4567890000")
    assert tx.price_currency == "AUD"


@pytest.mark.django_db
def test_transaction_serializer_formats_supplied_price():
    user = User.objects.create_user(email="round@example.com", username="round@example.com", password="pass")
    coin = Coin.objects.create(id="round", symbol="RND", name="Round Coin", current_price=1)
    request = SimpleNamespace(user=user)

    payload = {
        "type": "SELL",
        "quantity": 2,
        "coin_id": coin.id,
        "price": "12.34",
    }

    serializer = TransactionSerializer(data=payload, context={"request": request})
    serializer.is_valid(raise_exception=True)
    tx = serializer.save(user=user)

    assert tx.price == Decimal("12.3400000000")
    assert tx.price_currency == "USD"


@pytest.mark.django_db
def test_user_registration_serializer_handles_exception(monkeypatch):
    data = {"email": "fail@example.com", "password": "pass123", "display_name": "Fail"}
    serializer = UserRegistrationSerializer(data=data)
    serializer.is_valid(raise_exception=True)

    def boom(*args, **kwargs):
        raise RuntimeError("db error")

    monkeypatch.setattr("web_app.serializers.User.objects.create_user", boom)
    with pytest.raises(ValidationError):
        serializer.save()


def test_coin_detail_serializer_uses_context():
    coin = Coin(id="btc", symbol="btc", name="Bitcoin", current_price=Decimal("1000"))
    serializer = CoinDetailSerializer(coin, context={"range": "30d"})
    data = serializer.data
    assert data["id"] == "btc"
    assert data["price_history"] == []


@pytest.mark.django_db
def test_watchlist_item_serializer_create_requires_user():
    serializer = WatchListItemSerializer()
    with pytest.raises(ValidationError):
        serializer.create({"coin": Coin.objects.create(id="ada", symbol="ADA", name="Cardano", current_price=1)})


@pytest.mark.django_db
def test_simulation_summary_serializer_fallback_price(monkeypatch):
    user = User.objects.create_user(email="simfallback@example.com", username="simfallback@example.com", password="pass")
    sim = Simulation.objects.create(user=user, name="Sim", start_date=timezone.now().date())
    coin = Coin.objects.create(id="bnb", symbol="BNB", name="Binance", current_price=Decimal("320"))
    Transaction.objects.create(simulation=sim, coin=coin, type="BUY", quantity=Decimal("2"), price=Decimal("300"), user=user)

    def fake_prices(ids, currency):
        return {}

    monkeypatch.setattr("web_app.utils.coingecko.get_current_prices", fake_prices)
    serializer = SimulationSummarySerializer(sim)
    value = serializer.get_current_value(sim)
    assert value == round(float(2 * coin.current_price), 2)


@pytest.mark.django_db
def test_transaction_serializer_unknown_coin(monkeypatch):
    user = User.objects.create_user(email="error@example.com", username="error@example.com", password="pass")
    request = SimpleNamespace(user=user)

    def boom_create(*args, **kwargs):
        raise RuntimeError("db down")

    monkeypatch.setattr("web_app.serializers.Coin.objects.get", lambda *a, **k: (_ for _ in ()).throw(Coin.DoesNotExist()))
    monkeypatch.setattr("web_app.serializers.Coin.objects.create", boom_create)

    serializer = TransactionSerializer(
        data={"type": "BUY", "quantity": "1", "coin_id": "ghost"},
        context={"request": request},
    )
    serializer.is_valid(raise_exception=True)
    with pytest.raises(ValidationError):
        serializer.save(user=user)


@pytest.mark.django_db
def test_transaction_serializer_handle_exception(monkeypatch):
    user = User.objects.create_user(email="outer@example.com", username="outer@example.com", password="pass")
    coin = Coin.objects.create(id="outer", symbol="OUT", name="Outer Coin", current_price=1)
    request = SimpleNamespace(user=user)

    def boom(self, validated_data):
        raise RuntimeError("create failed")

    monkeypatch.setattr("rest_framework.serializers.ModelSerializer.create", boom, raising=False)

    serializer = TransactionSerializer(
        data={"type": "BUY", "quantity": "1", "coin_id": coin.id},
        context={"request": request},
    )
    serializer.is_valid(raise_exception=True)
    with pytest.raises(ValidationError):
        serializer.save(user=user)


@pytest.mark.django_db
def test_simulation_create_serializer_handle_exception(monkeypatch):
    user = User.objects.create_user(email="simctx@example.com", username="simctx@example.com", password="pass")
    request = SimpleNamespace(user=user)

    def boom_filter(*args, **kwargs):
        raise RuntimeError("filter failed")

    monkeypatch.setattr(Simulation.objects, "filter", lambda *a, **k: boom_filter())

    serializer = SimulationCreateSerializer(data={"name": "SimCtx"}, context={"request": request})
    serializer.is_valid(raise_exception=False)
    with pytest.raises(ValidationError):
        serializer.validate({"name": "SimCtx"})


@pytest.mark.django_db
def test_simulation_create_serializer_create_handle_exception(monkeypatch):
    user = User.objects.create_user(email="simcreate@example.com", username="simcreate@example.com", password="pass")
    request = SimpleNamespace(user=user)

    monkeypatch.setattr("web_app.serializers.Simulation.objects.create", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("create failed")))

    serializer = SimulationCreateSerializer(context={"request": request})
    with pytest.raises(ValidationError):
        serializer.create({"name": "N", "start_date": timezone.now().date(), "user": user})
