import logging
import secrets
from datetime import timedelta
from decimal import Decimal

import requests
from django.conf import settings
from django.contrib.auth import authenticate, login, logout, update_session_auth_hash
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.contrib.auth.decorators import login_required, user_passes_test
from django.core.paginator import Paginator
from django.db import transaction as dbtx
from django.db.models import Q, Sum, F
from django.shortcuts import get_object_or_404, render
from django.views.decorators.csrf import ensure_csrf_cookie
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime
from rest_framework import status, generics, serializers
from rest_framework.decorators import (
    api_view,
    permission_classes,
    throttle_classes,
    authentication_classes,
)
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenRefreshView

from .models import (
    User,
    Coin,
    WatchListItem,
    CurrentPrice,
    PriceCache,
    Simulation,
    Transaction,
    Holding,
    PasswordResetToken,
)
from .serializers import (
    UserRegistrationSerializer, UserProfileSerializer, CoinSerializer, CoinDetailSerializer,
    WatchlistSerializer, SimulationCreateSerializer, SimulationSummarySerializer,
    SimulationDetailSerializer, TransactionSerializer, PortfolioHoldingSerializer,
)
from .utils.coingecko import get_markets, get_current_prices, get_coin_market_chart, get_global_market_caps, get_coin_details
from .utils.currency import convert_amount, normalise as normalise_currency


logger = logging.getLogger(__name__)

PASSWORD_RESET_TOKEN_EXPIRY = timedelta(hours=1)



@api_view(["GET"])
@permission_classes([AllowAny])
def coingecko_proxy(request):
    """
    Proxy requests to CoinGecko using cached methods to avoid CORS issues.
    Accepts query params:
      - endpoint: 'simple/price' or 'coins/markets'
      - other params for the API
    """
    endpoint = request.GET.get("endpoint")
    if not endpoint:
        return safe_response({"detail": "endpoint parameter required"}, code=1000, status_code=400)

    try:
        # --------------------------
        # Simple Price Endpoint
        # --------------------------
        if endpoint == "simple/price":
            coin_ids = request.GET.get("ids", "").split(",")
            # Use user's preferred currency if authenticated
            if request.user.is_authenticated:
                currency = request.user.preferred_currency.lower()
            else:
                currency = request.GET.get("vs_currencies", "usd").lower()
            if not coin_ids or coin_ids[0] == "":
                return safe_response({"detail": "ids parameter required"}, code=1000, status_code=400)
            
            data = get_current_prices(coin_ids, currency)
            if data is None:
                return safe_response({"detail": "failed to fetch data"}, code=3000, status_code=503)
            
            return safe_response({"data": data})

        # --------------------------
        # Coins Markets Endpoint
        # --------------------------
        elif endpoint == "coins/markets":
            data = get_markets(request.GET)
            if data is None:
                return safe_response({"detail": "failed to fetch market data"}, code=3000, status_code=503)
            return safe_response({"data": data})
        
        # --------------------------
        # Coin Market Chart Endpoint
        # --------------------------
        elif endpoint.startswith("coins/") and "market_chart" in endpoint:
            coin_id = endpoint.split("/")[1]
            vs_currency = request.GET.get("vs_currency", "aud")
            days = request.GET.get("days", "7")
            vs_currency = request.GET.get("vs_currency", "usd")
            data = get_coin_market_chart(coin_id, vs_currency, days)
            return safe_response({"data": data})

        elif endpoint == "global/market_cap":
            data = get_global_market_caps()
            return safe_response({"data": data})

            

        # --------------------------
        # Coin Details Endpoint
        # --------------------------
        elif endpoint.startswith("coins/") and not "market_chart" in endpoint:
            coin_id = endpoint.split("/")[1]
            vs_currency = request.GET.get("vs_currency", "usd")
            data = get_coin_details(coin_id, vs_currency)
            if not data:
                return safe_response({"detail": "failed to fetch coin details"}, code=3000, status_code=503)
            return safe_response({"data": data})

        # --------------------------
        # Fallback: unsupported endpoint
        # --------------------------
        else:
            return safe_response({"detail": f"Unsupported endpoint: {endpoint}"}, code=1001, status_code=400)

    except Exception as e:
        logger.exception(f"CoinGecko proxy error: {str(e)}")
        return safe_response({"detail": "internal server error"}, code=3000, status_code=500)


@api_view(["GET"])
@permission_classes([AllowAny])
def refresh_token(request):
    refresh_token = request.COOKIES.get("refresh_token")
    if not refresh_token:
        return safe_response({"detail": "No refresh token"}, code=1001, status_code=401)
    try:
        refresh = RefreshToken(refresh_token)
        access_token = str(refresh.access_token)
        return safe_response({"access_token": access_token}, status_code=200)  
    except Exception:
        return safe_response({"detail": "Invalid refresh token"}, code=1002, status_code=401)


# -------------------------------------------------------------------------------
# Helpers
# -------------------------------------------------------------------------------
def safe_response(data, code=0, status_code=status.HTTP_200_OK):
    """Consistent JSON response format."""
    return Response({**data, "code": code}, status=status_code)


def handle_exception(e, context=""):
    """Centralized exception handler."""
    logger.exception(f"Unhandled error in {context}: {str(e)}")
    return safe_response({"detail": "internal server error"}, code=3000, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


def verify_recaptcha(token: str, action: str = "LOGIN") -> bool:
    site_key = getattr(settings, "RECAPTCHA_SITE_KEY", "")
    project_id = getattr(settings, "RECAPTCHA_PROJECT_ID", "")
    api_key = getattr(settings, "RECAPTCHA_API_KEY", "")
    min_score = getattr(settings, "RECAPTCHA_MIN_SCORE", 0.3)

    if not token:
        return False

    if not site_key or not project_id or not api_key:
        # allow login in dev if enterprise creds missing
        return settings.DEBUG

    url = f"https://recaptchaenterprise.googleapis.com/v1/projects/{project_id}/assessments?key={api_key}"
    payload = {
        "event": {
            "token": token,
            "siteKey": site_key,
            "expectedAction": action,
        }
    }

    try:
        response = requests.post(url, json=payload, timeout=5)
        response.raise_for_status()
        data = response.json()

        token_props = data.get("tokenProperties", {})
        if not token_props.get("valid", False):
            logger.warning("reCAPTCHA token invalid: %s", token_props)
            return False

        received_action = token_props.get("action")
        if action and received_action and received_action.lower() != action.lower():
            logger.warning("reCAPTCHA action mismatch: expected %s got %s", action, received_action)
            return False

        risk = data.get("riskAnalysis")
        if risk and "score" in risk:
            score = float(risk.get("score", 0))
            if score < min_score:
                logger.warning("reCAPTCHA score too low: %s < %s", score, min_score)
                return False

        return True
    except (requests.RequestException, ValueError) as exc:
        logger.warning("reCAPTCHA verification failed: %s", exc)
        return False


# -------------------------------------------------------------------------------
# Auth & Profile
# -------------------------------------------------------------------------------
class RegisterView(generics.CreateAPIView):
    queryset = User.objects.all()
    permission_classes = (AllowAny,)
    serializer_class = UserRegistrationSerializer

    def create(self, request, *args, **kwargs):
        try:
            serializer = self.get_serializer(data=request.data)
            if serializer.is_valid():
                user = serializer.save()
                logger.info(f"New user registered: {user.email}")
                return safe_response({
                    "id": user.id,
                    "email": user.email,
                    "display_name": user.display_name,
                    "is_active": user.is_active
                }, code=0, status_code=status.HTTP_201_CREATED)
            logger.warning(f"Registration failed: {serializer.errors}")
            return safe_response({"detail": serializer.errors}, code=1000, status_code=status.HTTP_400_BAD_REQUEST)
        except Exception as e:
            return handle_exception(e, "RegisterView")


@api_view(["POST"])
@permission_classes([AllowAny])
@authentication_classes([])
def login_view(request):
    try:
        email = request.data.get("email")
        password = request.data.get("password")
        captcha_token = request.data.get("captcha_token")
        if not email or not password:
            return safe_response({"detail": "email and password required"}, code=1000, status_code=400)
        if not verify_recaptcha(captcha_token, action="LOGIN"):
            return safe_response({"detail": "captcha verification failed"}, code=1000, status_code=400)

        user = authenticate(username=email, password=password)
        if user:
            login(request, user)
            # Create JWT tokens
            refresh = RefreshToken.for_user(user)
            access_token = str(refresh.access_token)

            response = safe_response({
                "user_id": user.id,
                "email": user.email,
                "access_token": access_token,
            })

            # Set HTTP-only refresh token cookie
            response.set_cookie(
                key="refresh_token",
                value=str(refresh),
                httponly=True,
                secure=False,  # Set True in production with HTTPS
                samesite="Lax",
                max_age=7*24*60*60  # 7 days
            )
            return response

        return safe_response({"detail": "invalid credentials"}, code=1001, status_code=401)
    except Exception as e:
        return handle_exception(e, "login_view")


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def logout_view(request):
    try:
        # Get refresh token from cookie (or frontend can send in body)
        refresh_token = request.COOKIES.get('refresh_token')
        if refresh_token:
            token = RefreshToken(refresh_token)
            token.blacklist()  # invalidate token

        # Clear session auth (optional)
        from django.contrib.auth import logout
        logout(request)

        response = Response({"detail": "Logged out"}, status=status.HTTP_204_NO_CONTENT)
        # Remove refresh token cookie
        response.delete_cookie('refresh_token', path='/', samesite='Lax', secure=False)
        return response

    except Exception as e:
        return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)


class ProfileView(generics.RetrieveUpdateAPIView):
    serializer_class = UserProfileSerializer
    permission_classes = [IsAuthenticated]

    def get_object(self):
        return self.request.user

    def retrieve(self, request, *args, **kwargs):
        try:
            serializer = self.get_serializer(request.user)
            return safe_response(serializer.data)
        except Exception as e:
            return handle_exception(e, "ProfileView.retrieve")

    def update(self, request, *args, **kwargs):
        try:
            serializer = self.get_serializer(request.user, data=request.data, partial=True)
            if serializer.is_valid():
                serializer.save()
                logger.info(f"Profile updated for {request.user.email}")
                return safe_response(serializer.data)
            logger.warning(f"Profile update failed: {serializer.errors}")
            return safe_response({"detail": serializer.errors}, code=1000, status_code=status.HTTP_400_BAD_REQUEST)
        except Exception as e:
            return handle_exception(e, "ProfileView.update")


# -------------------------------------------------------------------------------
# Password Reset
# -------------------------------------------------------------------------------
@api_view(["POST"])
@permission_classes([AllowAny])
def password_reset_request(request):
    try:
        email = (request.data.get("email") or "").strip().lower()
        if not email:
            return safe_response({"detail": "email required"}, code=1000, status_code=status.HTTP_400_BAD_REQUEST)

        token = secrets.token_urlsafe(32)
        try:
            user = User.objects.get(email=email)
        except User.DoesNotExist:
            # Do not reveal existence
            logger.info(f"Password reset requested for non-existent account: {email}")
            response_payload = {"detail": "reset email queued if account exists"}
            if settings.DEBUG:
                response_payload["token"] = token
            return safe_response(response_payload)

        PasswordResetToken.objects.filter(user=user, used_at__isnull=True).update(used_at=timezone.now())
        PasswordResetToken.objects.create(user=user, token=token)

        # TODO: integrate email delivery. For now, expose token in DEBUG for dev workflow.
        logger.info(f"Issued password reset token for {email}")
        payload = {"detail": "reset email queued if account exists"}
        if settings.DEBUG:
            payload["token"] = token
        return safe_response(payload)
    except Exception as e:
        return handle_exception(e, "password_reset_request")


@api_view(["POST"])
@permission_classes([AllowAny])
def password_reset_confirm(request):
    try:
        token = request.data.get("token")
        new_password = request.data.get("new_password")
        if not token or not new_password:
            return safe_response({"detail": "token and new_password required"}, code=1000, status_code=status.HTTP_400_BAD_REQUEST)
        try:
            reset_record = PasswordResetToken.objects.get(token=token)
        except PasswordResetToken.DoesNotExist:
            return safe_response({"detail": "invalid token"}, code=1000, status_code=status.HTTP_400_BAD_REQUEST)

        if reset_record.used_at is not None:
            return safe_response({"detail": "invalid token"}, code=1000, status_code=status.HTTP_400_BAD_REQUEST)

        if reset_record.created_at < timezone.now() - PASSWORD_RESET_TOKEN_EXPIRY:
            reset_record.mark_used()
            return safe_response({"detail": "invalid token"}, code=1000, status_code=status.HTTP_400_BAD_REQUEST)

        user = reset_record.user
        user.set_password(new_password)
        user.save(update_fields=["password"])
        reset_record.mark_used()
        logger.info(f"Password reset completed for {user.email}")
        return safe_response({"detail": "password updated"})
    except Exception as e:
        return handle_exception(e, "password_reset_confirm")


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def change_password(request):
    try:
        user = request.user
        current_password = (request.data.get("current_password") or "").strip()
        new_password = (request.data.get("new_password") or "").strip()
        confirm_password = request.data.get("confirm_password")

        if not current_password or not new_password:
            return safe_response(
                {"detail": "current_password and new_password required"},
                code=1000,
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        if confirm_password is not None and new_password != confirm_password:
            return safe_response(
                {"detail": "New passwords do not match"},
                code=1000,
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        if not user.check_password(current_password):
            return safe_response(
                {"detail": "Current password is incorrect"},
                code=1001,
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        try:
            validate_password(new_password, user=user)
        except ValidationError as ve:
            message = ve.messages[0] if ve.messages else "Password does not meet requirements"
            return safe_response(
                {"detail": message},
                code=1000,
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        user.set_password(new_password)
        user.save(update_fields=["password"])
        update_session_auth_hash(request, user)
        return safe_response({"detail": "Password updated successfully"}, code=0)
    except Exception as e:
        return handle_exception(e, "change_password")


# -------------------------------------------------------------------------------
# Profile Management
# -------------------------------------------------------------------------------
@api_view(["GET", "PUT"])
@permission_classes([IsAuthenticated])
def profile_view(request):
    """Handle user profile operations with currency preference support"""
    try:
        if request.method == "GET":
            logger.info(f"Getting profile for user: {request.user.email}")
            serializer = UserProfileSerializer(request.user)
            data = serializer.data
            
            # Validate currency
            if not data.get('preferred_currency'):
                data['preferred_currency'] = 'USD'
            
            logger.info(f"Profile data: {data}")
            return safe_response({"data": data})
        
        elif request.method == "PUT":
            logger.info(f"Updating profile for user: {request.user.email}")
            update_data = request.data.copy()
            
            # Validate currency format
            if 'preferred_currency' in update_data:
                currency = update_data['preferred_currency'].upper()
                if currency not in ['USD', 'EUR', 'AUD']:
                    return safe_response(
                        {"detail": "Invalid currency. Supported: USD, EUR, AUD"}, 
                        code=1000, 
                        status_code=400
                    )
                update_data['preferred_currency'] = currency
            
            serializer = UserProfileSerializer(request.user, data=update_data, partial=True)
            if serializer.is_valid():
                user = serializer.save()
                logger.info(f"Profile updated successfully for user: {user.email}")
                return safe_response({"data": serializer.data})
            
            logger.error(f"Profile update validation failed: {serializer.errors}")
            return safe_response({"detail": serializer.errors}, code=1000, status_code=400)
            
    except Exception as e:
        logger.exception(f"Profile view error for user {request.user.email}: {str(e)}")
        return handle_exception(e, "profile_view")

# -------------------------------------------------------------------------------
# CSRF
# -------------------------------------------------------------------------------
@api_view(["GET"])
@permission_classes([AllowAny])
@ensure_csrf_cookie
def csrf_cookie(request):
    return safe_response({"detail": "ok"})


# -------------------------------------------------------------------------------
# Market & Prices
# -------------------------------------------------------------------------------
class CoinGeckoRateThrottle(UserRateThrottle):
    rate = "10/minute"


@api_view(["GET"])
@permission_classes([AllowAny])
def current_prices(request):
    try:
        coin_ids = request.GET.get("coin_ids", "").split(",")
        currency = request.GET.get("currency", "usd")
        if not coin_ids or coin_ids[0] == "":
            return safe_response({"detail": "coin_ids parameter required"}, code=1000, status_code=status.HTTP_400_BAD_REQUEST)

        # Try to get fresh data from CoinGecko
        data = get_current_prices(coin_ids, currency)
        if data:
            return safe_response({"data": data})

        # Fallback to cached data if CoinGecko fails
        prices = list(CurrentPrice.objects.filter(coin_id__in=coin_ids, currency=currency))
        if prices:
            return safe_response({
                "data": {
                    p.coin_id: {
                        currency: float(p.price)
                    }
                    for p in prices
                }
            })
            
        # If both fresh and cached data are unavailable
        logger.error(f"Failed to fetch prices for {coin_ids}")
        return safe_response({"detail": "failed to fetch data"}, code=3000, status_code=status.HTTP_503_SERVICE_UNAVAILABLE)
    except Exception as e:
        return handle_exception(e, "current_prices")


@api_view(["GET"])
@permission_classes([AllowAny])
def price_history(request):
    try:
        coin_id = request.GET.get("coin_id")
        start = parse_datetime(request.GET.get("start"))
        end = parse_datetime(request.GET.get("end"))
        limit = int(request.GET.get("limit", 100))
        if not all([coin_id, start, end]):
            return safe_response({"detail": "coin_id, start, and end required"}, code=1000, status_code=status.HTTP_400_BAD_REQUEST)

        prices = PriceCache.objects.filter(
            coin__coin_id=coin_id,
            price_date__range=(start, end)
        ).order_by("-price_date")[:limit]

        return safe_response({
            "coin_id": coin_id,
            "prices": [
                {
                    "id": str(p.id),
                    "price": str(p.price),
                    "currency": p.currency,
                    "price_date": p.price_date.isoformat(),
                    "fetched_at": p.fetched_at.isoformat(),
                    "source": p.source,
                }
                for p in prices
            ]
        })
    except Exception as e:
        return handle_exception(e, "price_history")


@api_view(["GET"])
@permission_classes([AllowAny])
def market_data(request):
    try:
        # Get currency preference (from query params or user settings)
        currency = request.GET.get("currency", "").lower()
        if not currency and request.user.is_authenticated:
            currency = request.user.preferred_currency.lower()
        
        limit = int(request.GET.get("limit", 50))
        
        # Build parameters with proper currency
        params = {
            "vs_currency": currency or "usd",
            "per_page": limit,
            "page": 1,
            "sparkline": request.GET.get("sparkline", "false"),
            "price_change_percentage": "1h,24h,7d"
        }
        
        data = get_markets(params)
        if not data:
            logger.error("Failed to fetch market data from CoinGecko")
            return safe_response({"detail": "Failed to fetch market data"}, code=3000, status_code=status.HTTP_503_SERVICE_UNAVAILABLE)
        return safe_response({"data": data})
    except Exception as e:
        return handle_exception(e, "market_data")


# -------------------------------------------------------------------------------
# Health Check
# -------------------------------------------------------------------------------
@api_view(["GET"])
@permission_classes([AllowAny])
def health_check(request):
    try:
        return safe_response({"status": "ok", "time": timezone.now().isoformat()})
    except Exception as e:
        return handle_exception(e, "health_check")


# -------------------------------------------------------------------------------
# Custom Admin Dashboard (HTML page + metrics API)
# -------------------------------------------------------------------------------
def _staff_required(u):
    return u.is_authenticated and (getattr(u, 'is_staff', False) or getattr(u, 'is_superuser', False))


@login_required
@user_passes_test(_staff_required)
def admin_dashboard_page(request):
    try:
        return render(request, 'admin_dashboard.html', {})
    except Exception as e:
        logger.exception(f"admin_dashboard_page error: {e}")
        return safe_response({"detail": "internal server error"}, code=3000, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def admin_metrics(request):
    try:
        if not _staff_required(request.user):
            return safe_response({"detail": "forbidden"}, code=1001, status_code=403)

        from django.db.models import Sum, F, Case, When, DecimalField, Count
        currency = getattr(request.user, 'preferred_currency', 'USD')

        total_users = User.objects.count()
        total_sims = Simulation.objects.count()
        total_txs = Transaction.objects.count()

        invested_expr = Case(
            When(type='BUY', then=F('price')*F('quantity')),
            When(type='SELL', then=-(F('price')*F('quantity')),
            ),
            default=0,
            output_field=DecimalField(max_digits=30, decimal_places=10)
        )
        invested_total = Transaction.objects.aggregate(v=Sum(invested_expr))['v'] or 0

        # net qty by coin
        net_by_coin = (
            Transaction.objects
            .values('coin_id')
            .annotate(q=Sum(Case(
                When(type='BUY', then=F('quantity')),
                When(type='SELL', then=-F('quantity')),
                default=0,
                output_field=DecimalField(max_digits=40, decimal_places=20)
            )))
        )
        # current value using model price as baseline
        current_value_total = 0.0
        for row in net_by_coin:
            q = float(row['q'] or 0)
            if q <= 0: continue
            try:
                coin = Coin.objects.get(id=row['coin_id'])
                current_value_total += q * float(getattr(coin, 'current_price', 0) or 0)
            except Coin.DoesNotExist:
                pass

        # top coins by tx count and net qty
        top_coins = (
            Transaction.objects.values('coin__name', 'coin__symbol')
            .annotate(tx_count=Count('id'))
            .order_by('-tx_count')[:5]
        )
        top_coins_data = []
        for tc in top_coins:
            coin_name = tc.get('coin__name') or tc.get('coin__symbol') or '—'
            qty = next((float(r['q'] or 0) for r in net_by_coin if r['coin_id'] == Coin.objects.filter(name=tc.get('coin__name')).values_list('id', flat=True).first()), 0.0)
            top_coins_data.append({"coin": coin_name, "tx_count": tc['tx_count'], "net_qty": round(qty, 6)})

        # active users by tx count
        active_users = (
            Transaction.objects.values('user__email').annotate(tx_count=Count('id')).order_by('-tx_count')[:5]
        )
        active_users_data = [{"user": a.get('user__email') or '—', "tx_count": a['tx_count']} for a in active_users]

        # recent txs
        recent = (
            Transaction.objects.select_related('user','coin','simulation').order_by('-time')[:10]
        )
        recent_data = [{
            "id": str(t.id),
            "time": t.time.isoformat(timespec='seconds'),
            "user": t.user.email,
            "type": t.type,
            "coin": getattr(t.coin, 'symbol', None) or getattr(t.coin, 'id', ''),
            "quantity": str(t.quantity),
            "price": str(t.price),
            "simulation": getattr(t.simulation, 'name', None),
        } for t in recent]

        return safe_response({
            "currency": currency,
            "total_users": total_users,
            "total_simulations": total_sims,
            "total_transactions": total_txs,
            "invested_total": float(invested_total),
            "current_value_total": round(float(current_value_total), 2),
            "top_coins": top_coins_data,
            "active_users": active_users_data,
            "recent_transactions": recent_data,
        })
    except Exception as e:
        return handle_exception(e, "admin_metrics")


# --------------------------
# Admin CRUD: Users
# --------------------------
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def admin_users(request):
    try:
        if not _staff_required(request.user):
            return safe_response({"detail": "forbidden"}, code=1001, status_code=403)
        if request.method == "GET":
            q = request.GET.get("q", "").strip().lower()
            qs = User.objects.all().order_by("-created_at")[:200]
            if q:
                qs = [u for u in qs if q in (u.email or '').lower() or q in (u.display_name or '').lower()]
            data = [{
                "id": str(u.id),
                "email": u.email,
                "display_name": u.display_name,
                "is_staff": u.is_staff,
                "is_active": u.is_active,
                "preferred_currency": getattr(u, "preferred_currency", None),
                "created_at": u.created_at.isoformat() if hasattr(u, 'created_at') else None,
            } for u in qs]
            return safe_response({"results": data})
        # POST create user
        email = request.data.get("email")
        password = request.data.get("password")
        display_name = request.data.get("display_name", "")
        if not email or not password:
            return safe_response({"detail": "email and password required"}, code=1000, status_code=400)
        u = User.objects.create_user(email=email, username=email, password=password, display_name=display_name)
        return safe_response({"id": str(u.id), "email": u.email}, status_code=201)
    except Exception as e:
        return handle_exception(e, "admin_users")


@api_view(["PATCH", "DELETE"])
@permission_classes([IsAuthenticated])
def admin_user_detail(request, user_id):
    try:
        if not _staff_required(request.user):
            return safe_response({"detail": "forbidden"}, code=1001, status_code=403)
        u = get_object_or_404(User, id=user_id)
        if request.method == "DELETE":
            u.delete()
            return safe_response({"detail": "deleted"}, status_code=204)
        # PATCH
        for field in ["display_name", "is_active", "is_staff", "preferred_currency"]:
            if field in request.data:
                setattr(u, field, request.data.get(field))
        u.save()
        return safe_response({"detail": "updated"})
    except Exception as e:
        return handle_exception(e, "admin_user_detail")


# --------------------------
# Admin CRUD: Simulations
# --------------------------
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def admin_simulations(request):
    try:
        if not _staff_required(request.user):
            return safe_response({"detail": "forbidden"}, code=1001, status_code=403)
        if request.method == "GET":
            user_id = request.GET.get("user_id")
            qs = Simulation.objects.all().order_by("-created_at")[:200]
            if user_id:
                qs = qs.filter(user_id=user_id)
            data = [{
                "id": str(s.id),
                "user": s.user.email,
                "user_id": str(s.user_id),
                "name": s.name,
                "status": s.status,
                "start_date": s.start_date.isoformat(),
                "end_date": s.end_date.isoformat() if s.end_date else None,
            } for s in qs]
            return safe_response({"results": data})
        # POST create
        user_id = request.data.get("user_id")
        name = request.data.get("name")
        start_date = request.data.get("start_date")
        if not (user_id and name and start_date):
            return safe_response({"detail": "user_id, name, start_date required"}, code=1000, status_code=400)
        user = get_object_or_404(User, id=user_id)
        s = Simulation.objects.create(user=user, name=name, start_date=parse_date(start_date), description=request.data.get("description", ""))
        return safe_response({"id": str(s.id)}, status_code=201)
    except Exception as e:
        return handle_exception(e, "admin_simulations")


@api_view(["PATCH", "DELETE"])
@permission_classes([IsAuthenticated])
def admin_simulation_detail(request, sim_id):
    try:
        if not _staff_required(request.user):
            return safe_response({"detail": "forbidden"}, code=1001, status_code=403)
        s = get_object_or_404(Simulation, id=sim_id)
        if request.method == "DELETE":
            s.delete()
            return safe_response({"detail": "deleted"}, status_code=204)
        # PATCH allowed fields
        for field in ["name", "status", "description"]:
            if field in request.data:
                setattr(s, field, request.data.get(field))
        if "end_date" in request.data:
            v = request.data.get("end_date")
            s.end_date = parse_date(v) if v else None
        s.save()
        return safe_response({"detail": "updated"})
    except Exception as e:
        return handle_exception(e, "admin_simulation_detail")


# --------------------------
# Admin CRUD: Transactions (create/list/delete)
# --------------------------
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def admin_transactions(request):
    try:
        if not _staff_required(request.user):
            return safe_response({"detail": "forbidden"}, code=1001, status_code=403)
        if request.method == "GET":
            user_id = request.GET.get("user_id")
            sim_id = request.GET.get("sim_id")
            qs = Transaction.objects.select_related('user','coin','simulation').order_by('-time')[:200]
            if user_id:
                qs = qs.filter(user_id=user_id)
            if sim_id:
                qs = qs.filter(simulation_id=sim_id)
            data = [{
                "id": str(t.id),
                "time": t.time.isoformat(timespec='seconds'),
                "user": t.user.email,
                "user_id": str(t.user_id),
                "type": t.type,
                "coin": getattr(t.coin, 'id', None),
                "quantity": str(t.quantity),
                "price": str(t.price),
                "simulation": getattr(t.simulation, 'name', None),
                "simulation_id": str(getattr(t, 'simulation_id', '') or ''),
            } for t in qs]
            return safe_response({"results": data})
        # POST create (optional simulation)
        payload = request.data.copy()
        user = get_object_or_404(User, id=payload.get('user_id'))
        sim = None
        if payload.get('simulation_id'):
            sim = get_object_or_404(Simulation, id=payload.get('simulation_id'))
        # derive price/time as in simulation_transaction
        tx_time = parse_datetime(str(payload.get('time'))) if payload.get('time') else timezone.now()
        try:
            coin_id = payload.get('coin_id')
            currency = user.preferred_currency.lower()
            from .utils.coingecko import get_price_at_timestamp, get_current_prices
            hist = get_price_at_timestamp(coin_id, currency, tx_time)
            from decimal import Decimal, ROUND_HALF_UP
            if hist is not None:
                payload['price'] = Decimal(str(hist)).quantize(Decimal('0.0000000001'), rounding=ROUND_HALF_UP)
            else:
                mp = get_current_prices([coin_id], currency) or {}
                p = (mp.get(coin_id) or {}).get(currency)
                if p is not None:
                    payload['price'] = Decimal(str(p)).quantize(Decimal('0.0000000001'), rounding=ROUND_HALF_UP)
        except Exception:
            pass
        serializer = TransactionSerializer(data=payload, context={"request": request})
        if serializer.is_valid():
            tx = serializer.save(user=user, simulation=sim)
            try:
                tx.time = tx_time
                tx.save(update_fields=['time'])
            except Exception:
                pass
            return safe_response({"id": str(tx.id)}, status_code=201)
        return safe_response({"detail": serializer.errors}, code=1000, status_code=400)
    except Exception as e:
        return handle_exception(e, "admin_transactions")


@api_view(["DELETE"])
@permission_classes([IsAuthenticated])
def admin_transaction_detail(request, tx_id):
    try:
        if not _staff_required(request.user):
            return safe_response({"detail": "forbidden"}, code=1001, status_code=403)
        tx = get_object_or_404(Transaction, id=tx_id)
        tx.delete()
        return safe_response({"detail": "deleted"}, status_code=204)
    except Exception as e:
        return handle_exception(e, "admin_transaction_detail")


# --------------------------
# Admin CRUD: CurrentPrice
# --------------------------
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def admin_current_prices(request):
    try:
        if not _staff_required(request.user):
            return safe_response({"detail": "forbidden"}, code=1001, status_code=403)
        if request.method == "GET":
            coin_id = request.GET.get("coin_id")
            qs = CurrentPrice.objects.select_related('coin').order_by('-last_updated')[:200]
            if coin_id:
                qs = qs.filter(coin_id=coin_id)
            data = [{
                "id": str(cp.id),
                "coin_id": cp.coin_id,
                "coin": getattr(cp.coin, 'name', cp.coin_id),
                "price": str(cp.price),
                "currency": cp.currency,
                "last_updated": cp.last_updated.isoformat(timespec='seconds'),
            } for cp in qs]
            return safe_response({"results": data})
        # POST upsert by coin
        coin_id = request.data.get("coin_id")
        price = request.data.get("price")
        currency = request.data.get("currency") or getattr(request.user, 'preferred_currency', 'USD')
        if not (coin_id and price is not None):
            return safe_response({"detail": "coin_id and price required"}, code=1000, status_code=400)
        coin = get_object_or_404(Coin, id=coin_id)
        cp, _ = CurrentPrice.objects.get_or_create(coin=coin, defaults={"price": price, "currency": currency})
        cp.price = price
        cp.currency = currency
        cp.save()
        return safe_response({"id": str(cp.id)}, status_code=201)
    except Exception as e:
        return handle_exception(e, "admin_current_prices")


@api_view(["PATCH", "DELETE"])
@permission_classes([IsAuthenticated])
def admin_current_price_detail(request, cp_id):
    try:
        if not _staff_required(request.user):
            return safe_response({"detail": "forbidden"}, code=1001, status_code=403)
        cp = get_object_or_404(CurrentPrice, id=cp_id)
        if request.method == "DELETE":
            cp.delete()
            return safe_response({"detail": "deleted"}, status_code=204)
        for field in ["price", "currency"]:
            if field in request.data:
                setattr(cp, field, request.data.get(field))
        cp.save()
        return safe_response({"detail": "updated"})
    except Exception as e:
        return handle_exception(e, "admin_current_price_detail")


# --------------------------
# Admin CRUD: PriceCache
# --------------------------
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def admin_price_cache(request):
    try:
        if not _staff_required(request.user):
            return safe_response({"detail": "forbidden"}, code=1001, status_code=403)
        if request.method == "GET":
            coin_id = request.GET.get("coin_id")
            qs = PriceCache.objects.select_related('coin').order_by('-fetched_at')[:200]
            if coin_id:
                qs = qs.filter(coin_id=coin_id)
            data = [{
                "id": str(pc.id),
                "coin_id": pc.coin_id,
                "coin": getattr(pc.coin, 'name', pc.coin_id),
                "price": str(pc.price),
                "currency": pc.currency,
                "fetched_at": pc.fetched_at.isoformat(timespec='seconds'),
            } for pc in qs]
            return safe_response({"results": data})
        coin_id = request.data.get("coin_id")
        price = request.data.get("price")
        currency = request.data.get("currency") or getattr(request.user, 'preferred_currency', 'USD')
        if not (coin_id and price is not None):
            return safe_response({"detail": "coin_id and price required"}, code=1000, status_code=400)
        coin = get_object_or_404(Coin, id=coin_id)
        pc = PriceCache.objects.create(coin=coin, price=price, currency=currency)
        return safe_response({"id": str(pc.id)}, status_code=201)
    except Exception as e:
        return handle_exception(e, "admin_price_cache")


@api_view(["PATCH", "DELETE"])
@permission_classes([IsAuthenticated])
def admin_price_cache_detail(request, pc_id):
    try:
        if not _staff_required(request.user):
            return safe_response({"detail": "forbidden"}, code=1001, status_code=403)
        pc = get_object_or_404(PriceCache, id=pc_id)
        if request.method == "DELETE":
            pc.delete()
            return safe_response({"detail": "deleted"}, status_code=204)
        for field in ["price", "currency"]:
            if field in request.data:
                setattr(pc, field, request.data.get(field))
        pc.save()
        return safe_response({"detail": "updated"})
    except Exception as e:
        return handle_exception(e, "admin_price_cache_detail")


# --------------------------
# Admin CRUD: Holdings
# --------------------------
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def admin_holdings(request):
    try:
        if not _staff_required(request.user):
            return safe_response({"detail": "forbidden"}, code=1001, status_code=403)
        if request.method == "GET":
            user_id = request.GET.get("user_id")
            sim_id = request.GET.get("sim_id")
            coin_id = request.GET.get("coin_id")
            qs = Holding.objects.select_related('user','coin','simulation').order_by('-updated_at')[:200]
            if user_id:
                qs = qs.filter(user_id=user_id)
            if sim_id:
                qs = qs.filter(simulation_id=sim_id)
            if coin_id:
                qs = qs.filter(coin_id=coin_id)
            data = [{
                "id": str(h.id),
                "user": h.user.email,
                "user_id": str(h.user_id),
                "coin_id": h.coin_id,
                "simulation": getattr(h.simulation, 'name', None),
                "simulation_id": str(getattr(h, 'simulation_id', '') or ''),
                "quantity": str(h.quantity),
                "avg_price": str(h.avg_price),
                "avg_price_currency": h.avg_price_currency,
            } for h in qs]
            return safe_response({"results": data})
        payload = request.data.copy()
        user = get_object_or_404(User, id=payload.get('user_id'))
        coin = get_object_or_404(Coin, id=payload.get('coin_id'))
        sim = None
        if payload.get('simulation_id'):
            sim = get_object_or_404(Simulation, id=payload.get('simulation_id'))
        h, _ = Holding.objects.get_or_create(user=user, coin=coin, simulation=sim)
        for field in ["quantity", "avg_price", "avg_price_currency"]:
            if field in payload and payload.get(field) is not None:
                setattr(h, field, payload.get(field))
        h.save()
        return safe_response({"id": str(h.id)}, status_code=201)
    except Exception as e:
        return handle_exception(e, "admin_holdings")


@api_view(["PATCH", "DELETE"])
@permission_classes([IsAuthenticated])
def admin_holding_detail(request, holding_id):
    try:
        if not _staff_required(request.user):
            return safe_response({"detail": "forbidden"}, code=1001, status_code=403)
        h = get_object_or_404(Holding, id=holding_id)
        if request.method == "DELETE":
            h.delete()
            return safe_response({"detail": "deleted"}, status_code=204)
        for field in ["quantity", "avg_price", "avg_price_currency"]:
            if field in request.data:
                setattr(h, field, request.data.get(field))
        h.save()
        return safe_response({"detail": "updated"})
    except Exception as e:
        return handle_exception(e, "admin_holding_detail")


# --------------------------
# Admin CRUD: Watchlist
# --------------------------
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def admin_watchlist(request):
    try:
        if not _staff_required(request.user):
            return safe_response({"detail": "forbidden"}, code=1001, status_code=403)
        if request.method == "GET":
            user_id = request.GET.get("user_id")
            qs = WatchListItem.objects.select_related('user','coin','simulation').order_by('-created_at')[:200]
            if user_id:
                qs = qs.filter(user_id=user_id)
            data = [{
                "id": str(w.id),
                "user": w.user.email,
                "user_id": str(w.user_id),
                "coin_id": w.coin_id,
                "simulation": getattr(w.simulation, 'name', None),
                "simulation_id": str(getattr(w, 'simulation_id', '') or ''),
                "created_at": w.created_at.isoformat(timespec='seconds'),
            } for w in qs]
            return safe_response({"results": data})
        user = get_object_or_404(User, id=request.data.get('user_id'))
        coin = get_object_or_404(Coin, id=request.data.get('coin_id'))
        sim = None
        sim_id = request.data.get('simulation_id')
        if sim_id:
            sim = get_object_or_404(Simulation, id=sim_id)
        w, _ = WatchListItem.objects.get_or_create(user=user, coin=coin, simulation=sim)
        return safe_response({"id": str(w.id)}, status_code=201)
    except Exception as e:
        return handle_exception(e, "admin_watchlist")


@api_view(["DELETE"])
@permission_classes([IsAuthenticated])
def admin_watchlist_detail(request, item_id):
    try:
        if not _staff_required(request.user):
            return safe_response({"detail": "forbidden"}, code=1001, status_code=403)
        w = get_object_or_404(WatchListItem, id=item_id)
        w.delete()
        return safe_response({"detail": "deleted"}, status_code=204)
    except Exception as e:
        return handle_exception(e, "admin_watchlist_detail")
# -------------------------------------------------------------------------------
# Coins: List / Detail
# -------------------------------------------------------------------------------
class CoinListView(generics.ListAPIView):
    queryset = Coin.objects.all()
    serializer_class = CoinSerializer
    permission_classes = [AllowAny]


class CoinDetailView(generics.RetrieveAPIView):
    queryset = Coin.objects.all()
    serializer_class = CoinDetailSerializer
    lookup_field = "coin_id"
    permission_classes = [AllowAny]


# -------------------------------------------------------------------------------
# Watchlist
# -------------------------------------------------------------------------------
class WatchlistView(generics.ListCreateAPIView):
    queryset = WatchListItem.objects.all()
    serializer_class = WatchlistSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return WatchListItem.objects.filter(user=self.request.user)

    def create(self, request, *args, **kwargs):
        try:
            coin_id = request.data.get("coin_id")
            if not coin_id:
                return safe_response({"detail": "coin_id required"}, code=1000, status_code=status.HTTP_400_BAD_REQUEST)
            exists = WatchListItem.objects.filter(user=request.user, coin_id=coin_id).exists()
            if exists:
                return safe_response({"detail": "watchlist exists"}, code=1003, status_code=status.HTTP_409_CONFLICT)
            # Ensure referenced coin exists to satisfy FK constraint
            coin, _ = Coin.objects.get_or_create(
                id=coin_id,
                defaults={
                    "symbol": coin_id[:10].upper(),
                    "name": coin_id.replace("-", " ").title(),
                },
            )
            item = WatchListItem.objects.create(user=request.user, coin=coin)
            logger.info(f"Watchlist item created for user {request.user.email}: {coin_id}")
            return safe_response({
                "id": str(item.id),
                "user_id": str(request.user.id),
                "coin_id": coin_id,
                "created_at": item.created_at.isoformat()
            }, code=0, status_code=status.HTTP_201_CREATED)
        except Exception as e:
            return handle_exception(e, "WatchlistView.create")


class WatchlistRemoveView(generics.DestroyAPIView):
    queryset = WatchListItem.objects.all()
    serializer_class = WatchlistSerializer
    permission_classes = [IsAuthenticated]
    lookup_field = "id"
    lookup_url_kwarg = "watchlist_id"

    def destroy(self, request, *args, **kwargs):
        try:
            obj = self.get_object()
            obj.delete()
            return safe_response({"detail": "deleted"}, code=0)
        except Exception as e:
            return handle_exception(e, "WatchlistRemoveView.destroy")


# -------------------------------------------------------------------------------
# Portfolio (per-user, non-simulation)
# -------------------------------------------------------------------------------
@api_view(["GET", "POST", "DELETE"])
@permission_classes([IsAuthenticated])
def portfolio_view(request):
    try:
        user = request.user
        if request.method == "GET" or request.method == "DELETE":
            if request.method == "DELETE":
                Holding.objects.filter(user=user, simulation=None).delete()
                Transaction.objects.filter(user=user, simulation=None).delete()
            return safe_response(_serialize_portfolio(user))

        # POST = BUY
        coin_id = request.data.get("coin_id")
        quantity = Decimal(str(request.data.get("quantity"))) if request.data.get("quantity") is not None else None
        price = Decimal(str(request.data.get("price"))) if request.data.get("price") is not None else None
        if not coin_id or quantity is None or price is None:
            return safe_response({"detail": "coin_id, quantity, price required"}, code=1000, status_code=400)
        if quantity <= 0 or price <= 0:
            return safe_response({"detail": "quantity and price must be positive"}, code=1000, status_code=400)

        coin = Coin.objects.get_or_create(id=coin_id, defaults={"symbol": coin_id[:10].upper(), "name": coin_id.replace("-", " ").title()})[0]
        currency = normalise_currency(request.data.get("currency") or getattr(user, "preferred_currency", "USD"))
        price_in_usd = convert_amount(price, currency, "USD")
        with dbtx.atomic():
            holding, created = Holding.objects.select_for_update().get_or_create(
                user=user, coin=coin, simulation=None,
                defaults={"quantity": quantity, "avg_price": price_in_usd, "avg_price_currency": "USD"},
            )
            if not created:
                total_cost = holding.quantity * holding.avg_price + quantity * price_in_usd
                new_qty = holding.quantity + quantity
                holding.quantity = new_qty
                holding.avg_price = (total_cost / new_qty) if new_qty > 0 else Decimal("0")
                holding.avg_price_currency = "USD"
                holding.save(update_fields=["quantity", "avg_price", "avg_price_currency", "updated_at"])
            Transaction.objects.create(
                user=user, coin=coin, simulation=None, type="BUY",
                quantity=quantity, price=price_in_usd, price_currency="USD", fee=Decimal("0"),
                cost_basis=quantity * price_in_usd, realised_profit=Decimal("0"), realised_profit_currency="USD"
            )
        return safe_response(_serialize_portfolio(user), status_code=201)
    except Exception as e:
        return handle_exception(e, "portfolio_view")


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def portfolio_sell(request):
    try:
        user = request.user
        coin_id = request.data.get("coin_id")
        quantity = Decimal(str(request.data.get("quantity"))) if request.data.get("quantity") is not None else None
        price = Decimal(str(request.data.get("price"))) if request.data.get("price") is not None else None
        if not coin_id or quantity is None or price is None:
            return safe_response({"detail": "coin_id, quantity, price required"}, code=1000, status_code=400)
        if quantity <= 0 or price <= 0:
            return safe_response({"detail": "quantity and price must be positive"}, code=1000, status_code=400)

        with dbtx.atomic():
            try:
                holding = Holding.objects.select_for_update().get(user=user, simulation=None, coin__id=coin_id)
            except Holding.DoesNotExist:
                return safe_response({"detail": "Holding not found"}, code=1002, status_code=404)
            if quantity > holding.quantity:
                return safe_response({"detail": "Insufficient quantity"}, code=1001, status_code=400)

            # Update holding
            price_currency = normalise_currency(request.data.get("currency") or getattr(user, "preferred_currency", "USD"))
            price_in_usd = convert_amount(price, price_currency, "USD")
            if quantity == holding.quantity:
                holding.delete()
            else:
                holding.quantity = holding.quantity - quantity
                holding.save(update_fields=["quantity", "updated_at"])

            Transaction.objects.create(
                user=user, coin=holding.coin, simulation=None, type="SELL",
                quantity=quantity, price=price_in_usd, price_currency="USD", fee=Decimal("0"),
                cost_basis=quantity * holding.avg_price,
                realised_profit=quantity * (price_in_usd - holding.avg_price),
                realised_profit_currency="USD"
            )
        return safe_response(_serialize_portfolio(user))
    except Exception as e:
        return handle_exception(e, "portfolio_sell")


def _serialize_portfolio(user):
    holdings = Holding.objects.filter(user=user, simulation=None).select_related("coin").order_by("-updated_at")
    data = PortfolioHoldingSerializer(holdings, many=True).data
    realised = (
        Transaction.objects.filter(user=user, simulation=None)
        .aggregate(v=Sum("realised_profit"))
        .get("v") or 0
    )
    return {"holdings": data, "realised_total": float(realised)}
# Transactions
# -------------------------------------------------------------------------------
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def create_transaction(request):
    try:
        serializer = TransactionSerializer(data=request.data, context={"request": request})
        if serializer.is_valid():
            tx = serializer.save(user=request.user)
            logger.info(f"Transaction created: {tx.id} by user {request.user.email}")
            return safe_response(TransactionSerializer(tx).data, code=0, status_code=status.HTTP_201_CREATED)
        return safe_response({"detail": serializer.errors}, code=1000, status_code=status.HTTP_400_BAD_REQUEST)
    except Exception as e:
        return handle_exception(e, "create_transaction")


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def list_transactions(request):
    try:
        portfolio_id = request.GET.get("portfolio_id")
        page = int(request.GET.get("page", 1))
        qs = Transaction.objects.filter(user=request.user)
        if portfolio_id:
            qs = qs.filter(simulation__id=portfolio_id)
        paginator = Paginator(qs.order_by("-time"), 20)
        paged = paginator.get_page(page)
        return safe_response({
            "results": TransactionSerializer(paged, many=True).data,
            "page": page,
            "total_pages": paginator.num_pages,
            "total": paginator.count
        })
    except Exception as e:
        return handle_exception(e, "list_transactions")


# -------------------------------------------------------------------------------
# Simulations
# -------------------------------------------------------------------------------
class SimulationListCreateView(generics.ListCreateAPIView):
    queryset = Simulation.objects.all()
    # default list view should return summary fields
    serializer_class = SimulationSummarySerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return Simulation.objects.filter(user=self.request.user).order_by('-created_at')

    def get_serializer_class(self):
        # Use create serializer only for POST; summary for GET
        if getattr(self.request, 'method', '').upper() == 'POST':
            return SimulationCreateSerializer
        return SimulationSummarySerializer

    def create(self, request, *args, **kwargs):
        try:
            serializer = SimulationCreateSerializer(data=request.data, context={"request": request})
            if serializer.is_valid():
                sim = serializer.save(user=request.user)
                summary = SimulationSummarySerializer(sim, context={"request": request})
                return safe_response(summary.data, status_code=status.HTTP_201_CREATED)
            return safe_response({"detail": serializer.errors}, code=1000, status_code=status.HTTP_400_BAD_REQUEST)
        except Exception as e:
            return handle_exception(e, "SimulationListCreateView.create")

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)


class SimulationDetailView(generics.RetrieveUpdateDestroyAPIView):
    queryset = Simulation.objects.all()
    serializer_class = SimulationDetailSerializer
    permission_classes = [IsAuthenticated]
    lookup_field = "id"
    lookup_url_kwarg = "sim_id"

    def get_queryset(self):
        return Simulation.objects.filter(user=self.request.user)


class SimulationPositionsView(generics.ListAPIView):
    queryset = Holding.objects.all()
    serializer_class = TransactionSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        sim_id = self.kwargs.get("sim_id")
        return Holding.objects.filter(simulation__id=sim_id)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def simulation_transaction(request, sim_id):
    try:
        sim = get_object_or_404(Simulation, id=sim_id, user=request.user)
        data = request.data.copy()
        if not data.get("type"):
            data["type"] = "BUY"
        # Determine transaction time (allow 'time' or 'start_time'); default now
        tx_time = None
        for key in ("time", "start_time"):
            if data.get(key):
                tx_time = parse_datetime(str(data.get(key)))
                break
        if tx_time is None:
            tx_time = timezone.now()
        # fill price using historical price at tx_time; fallback to current
        try:
            coin_id = data.get("coin_id")
            currency = request.user.preferred_currency.lower()
            from .utils.coingecko import get_price_at_timestamp, get_current_prices
            hist = get_price_at_timestamp(coin_id, currency, tx_time)
            if hist is not None:
                from decimal import Decimal, ROUND_HALF_UP
                data["price"] = Decimal(str(hist)).quantize(Decimal("0.0000000001"), rounding=ROUND_HALF_UP)
            else:
                price_map = get_current_prices([coin_id], currency) or {}
                p = price_map.get(coin_id, {}).get(currency)
                if p is not None:
                    from decimal import Decimal, ROUND_HALF_UP
                    data["price"] = Decimal(str(p)).quantize(Decimal("0.0000000001"), rounding=ROUND_HALF_UP)
        except Exception:
            pass
        serializer = TransactionSerializer(data=data, context={"request": request})
        if serializer.is_valid():
            tx = serializer.save(user=request.user, simulation=sim)
            # Update timestamp to requested historical time
            try:
                if tx_time:
                    tx.time = tx_time
                    tx.save(update_fields=["time"])
            except Exception:
                pass
            logger.info(f"Transaction in simulation {sim_id} created: {tx.id}")
            return safe_response(TransactionSerializer(tx).data, code=0, status_code=status.HTTP_201_CREATED)
        return safe_response({"detail": serializer.errors}, code=1000, status_code=status.HTTP_400_BAD_REQUEST)
    except Exception as e:
        return handle_exception(e, "simulation_transaction")


@api_view(["DELETE"])
@permission_classes([IsAuthenticated])
def delete_transaction(request, tx_id):
    try:
        tx = get_object_or_404(Transaction, id=tx_id, user=request.user)
        tx.delete()
        return safe_response({"detail": "deleted"}, code=0, status_code=status.HTTP_204_NO_CONTENT)
    except Exception as e:
        return handle_exception(e, "delete_transaction")
