import uuid
from django.conf import settings
from django.db import models
from django.contrib.auth.models import AbstractUser, Group, Permission
from django.utils import timezone
from django.utils.translation import gettext_lazy as _
# -------------------------
# User
# -------------------------
class User(AbstractUser):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email = models.EmailField(unique=True)
    display_name = models.CharField(max_length=100)
    preferred_currency = models.CharField(max_length=3, default='USD')
    timezone = models.CharField(max_length=50, default='Australia/Sydney')
    date_format = models.CharField(max_length=20, default='YYYY-MM-DD')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    # Override groups / user_permissions to provide unique reverse related_name
    groups = models.ManyToManyField(
        Group,
        verbose_name=_('groups'),
        blank=True,
        help_text=_('The groups this user belongs to.'),
        related_name='%(app_label)s_%(class)s_groups',        # UNIQUE reverse name
        related_query_name='%(app_label)s_%(class)s_group',
    )
    user_permissions = models.ManyToManyField(
        Permission,
        verbose_name=_('user permissions'),
        blank=True,
        help_text=_('Specific permissions for this user.'),
        related_name='%(app_label)s_%(class)s_user_permissions',  # UNIQUE reverse name
        related_query_name='%(app_label)s_%(class)s_user_permission',
    )

    def __str__(self):
        return self.email


# -------------------------
# Coin
# -------------------------
class Coin(models.Model):
    id = models.CharField(max_length=100, primary_key=True)  # coingecko id
    symbol = models.CharField(max_length=10)
    name = models.CharField(max_length=100)
    current_price = models.DecimalField(max_digits=20, decimal_places=2, default=0)
    price_change_24h = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    market_cap = models.DecimalField(max_digits=20, decimal_places=2, default=0)
    last_updated = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"{self.name} ({self.symbol.upper()})"


# -------------------------
# Simulation
# -------------------------
class Simulation(models.Model):
    STATUS_CHOICES = [
        ("ACTIVE", "Active"),
        ("PAUSED", "Paused"),
        ("ENDED", "Ended"),
        ("ARCHIVED", "Archived"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="simulations")
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    start_date = models.DateField()
    end_date = models.DateField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default="ACTIVE")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"{self.name} ({self.user})"


# -------------------------
# CurrentPrice (one-to-one with Coin)
# -------------------------
class CurrentPrice(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    coin = models.OneToOneField(
        Coin,
        on_delete=models.CASCADE,
        related_name='live_price'
    )
    price = models.DecimalField(max_digits=20, decimal_places=8)
    currency = models.CharField(max_length=10, default='USD')
    last_updated = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ('coin', 'currency')

    def __str__(self):
        return f"{self.coin.symbol} @ {self.price} {self.currency}"


# -------------------------
# PriceCache (historical snapshots)
# -------------------------
class PriceCache(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    coin = models.ForeignKey(
        Coin,
        on_delete=models.CASCADE,
        related_name='price_history'
    )
    price = models.DecimalField(
        max_digits=20,
        decimal_places=8,
        default=0.0
    )
    currency = models.CharField(max_length=10, default='USD')
    price_date = models.DateTimeField(auto_now_add=True)
    fetched_at = models.DateTimeField(auto_now_add=True)
    source = models.CharField(max_length=50, default='coingecko')
    price_data = models.JSONField(null=True, blank=True)

    def __str__(self):
        return f"{self.coin.symbol} @ {self.price} {self.currency} ({self.fetched_at.isoformat()})"

    class Meta:
        indexes = [
            models.Index(fields=['coin', 'price_date']),
            models.Index(fields=['fetched_at'])
        ]
