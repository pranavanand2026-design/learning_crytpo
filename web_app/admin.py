from django.contrib import admin
from .models import User, Coin, Simulation, CurrentPrice, PriceCache, Holding, Transaction, WatchListItem

@admin.register(User)
class UserAdmin(admin.ModelAdmin):
    list_display = ("email", "display_name", "preferred_currency", "is_active", "date_joined")
    search_fields = ("email", "display_name")

@admin.register(Coin)
class CoinAdmin(admin.ModelAdmin):
    list_display = ("id", "symbol", "name", "current_price", "market_cap", "last_updated")
    search_fields = ("id", "symbol", "name")

@admin.register(Simulation)
class SimulationAdmin(admin.ModelAdmin):
    list_display = ("id", "user", "name", "status", "start_date", "end_date", "created_at")
    list_filter = ("status",)
    search_fields = ("name", "user__email")

@admin.register(CurrentPrice)
class CurrentPriceAdmin(admin.ModelAdmin):
    list_display = ("coin", "price", "currency", "last_updated")
    list_filter = ("currency",)

@admin.register(PriceCache)
class PriceCacheAdmin(admin.ModelAdmin):
    list_display = ("coin", "price", "currency", "price_date", "fetched_at", "source")
    list_filter = ("currency", "source")
    search_fields = ("coin__id", "coin__symbol", "coin__name")

@admin.register(Holding)
class HoldingAdmin(admin.ModelAdmin):
    list_display = ("user", "coin", "simulation", "quantity", "avg_price", "updated_at")
    search_fields = ("user__email", "coin__id", "coin__symbol")

@admin.register(Transaction)
class TransactionAdmin(admin.ModelAdmin):
    list_display = ("user", "type", "coin", "simulation", "quantity", "price", "time", "fee")
    list_filter = ("type",)
    search_fields = ("user__email", "coin__id", "coin__symbol")

@admin.register(WatchListItem)
class WatchListItemAdmin(admin.ModelAdmin):
    list_display = ("user", "coin", "simulation", "created_at")
