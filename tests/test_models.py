import pytest
from django.utils import timezone
from decimal import Decimal

from web_app.models import (
    PasswordResetToken,
    User,
    Coin,
    Simulation,
    CurrentPrice,
    PriceCache,
    Holding,
    Transaction,
    WatchListItem,
)


@pytest.mark.django_db
def test_password_reset_token_mark_used():
    user = User.objects.create_user(email="token@example.com", username="token@example.com", password="pass")
    token = PasswordResetToken.objects.create(user=user, token="reset-token-123")
    assert token.used_at is None

    before = timezone.now()
    token.mark_used()
    token.refresh_from_db()

    assert token.used_at is not None
    assert token.used_at >= before


@pytest.mark.django_db
def test_model_str_representations():
    user = User.objects.create_user(email="user@example.com", username="user@example.com", password="pass", display_name="User")
    coin = Coin.objects.create(id="btc", symbol="BTC", name="Bitcoin", current_price=20000, price_change_24h=5, market_cap=1000000)
    sim = Simulation.objects.create(user=user, name="Sim", start_date=timezone.now().date())
    current_price = CurrentPrice.objects.create(coin=coin, price=Decimal("12345.67890123"), currency="USD")
    price_cache = PriceCache.objects.create(coin=coin, price=Decimal("123.45678901"), currency="USD")
    token = PasswordResetToken.objects.create(user=user, token="abc")
    holding = Holding.objects.create(user=user, coin=coin, simulation=sim, quantity=Decimal("1.5"), avg_price=Decimal("10000"))
    tx = Transaction.objects.create(user=user, coin=coin, simulation=sim, type="BUY", quantity=Decimal("0.5"), price=Decimal("20000"))
    watch = WatchListItem.objects.create(user=user, coin=coin, simulation=sim)

    assert str(user) == user.email
    assert str(coin) == "Bitcoin (BTC)"
    assert "Sim (" in str(sim)
    assert str(current_price).startswith("BTC @")
    assert "BTC @" in str(price_cache)
    assert "Holding" in str(holding)
    assert "BUY" in str(tx)
    assert "watchlist" in str(watch)
    assert "Password reset token" in str(token)
