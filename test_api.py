import requests
import json

def test_dex():
    # Test 1: Tokens API for SOL
    url1 = "https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112"
    r1 = requests.get(url1)
    pairs1 = r1.json().get("pairs", [])
    print(f"Tokens API (SOL) found {len(pairs1)} pairs")

    # Test 2: Search API for 'solana'
    url2 = "https://api.dexscreener.com/latest/dex/search?q=solana"
    r2 = requests.get(url2)
    pairs2 = r2.json().get("pairs", [])
    print(f"Search API (solana) found {len(pairs2)} pairs")

    # Test 3: Search API for 'raydium'
    url3 = "https://api.dexscreener.com/latest/dex/search?q=raydium"
    r3 = requests.get(url3)
    pairs3 = r3.json().get("pairs", [])
    print(f"Search API (raydium) found {len(pairs3)} pairs")

if __name__ == "__main__":
    test_dex()
