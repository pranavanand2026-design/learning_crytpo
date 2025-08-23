import requests
import json

# --- API endpoint ---
url = "https://api.coingecko.com/api/v3/simple/price"

# --- Params: change coins or currencies as needed ---
params = {
    "ids": "bitcoin,ethereum,dogecoin",  # coins to fetch
    "vs_currencies": "usd,inr"          # fiat currencies
}

# --- Fetch from CoinGecko ---
response = requests.get(url, params=params)

if response.status_code == 200:
    data = response.json()

    # Save JSON pretty-printed to file
    with open("api_output_testing.txt", "w") as f:
        json.dump(data, f, indent=4)

    print("✅ API response saved to api_output_testing.txt")
else:
    print(f"❌ Error {response.status_code}: {response.text}")