#!/usr/bin/env python3
"""
ClashX Network Monitor
Checks current proxy latency and switches to best available node if needed.
"""

import json
import urllib.request
import urllib.parse
import sys
from typing import Dict, List, Tuple, Optional

# Configuration
CLASH_API_BASE = "http://127.0.0.1:9090"
DELAY_THRESHOLD = 2000  # ms
DELAY_TIMEOUT = 5000   # ms for delay test
REQUEST_TIMEOUT = 10   # seconds for API requests

# Node prefixes to consider for failover
FAILOVER_REGIONS = ["🇯🇵", "🇸🇬", "🇺🇸"]

def api_request(endpoint: str, method: str = "GET", data: Optional[dict] = None) -> Optional[dict]:
    """Make API request to ClashX."""
    url = f"{CLASH_API_BASE}{endpoint}"
    try:
        if method == "GET":
            req = urllib.request.Request(url)
        else:  # PUT
            json_data = json.dumps(data).encode('utf-8')
            req = urllib.request.Request(url, data=json_data, method='PUT', headers={'Content-Type': 'application/json'})

        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as response:
            return json.loads(response.read().decode('utf-8'))
    except Exception as e:
        print(f"API request failed: {e}", file=sys.stderr)
        return None

def get_current_proxy() -> Optional[str]:
    """Get currently active proxy name."""
    result = api_request("/proxies/Proxy")
    return result.get('now') if result else None

def test_proxy_delay(proxy_name: str) -> int:
    """Test latency for a specific proxy. Returns delay in ms, or -1 if failed."""
    encoded_name = urllib.parse.quote(proxy_name)
    url = f"{CLASH_API_BASE}/proxies/{encoded_name}/delay?url=http://www.gstatic.com/generate_204&timeout={DELAY_TIMEOUT}"

    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as response:
            result = json.loads(response.read().decode())
            return result.get('delay', -1)
    except Exception:
        return -1

def get_all_proxies() -> Dict[str, List[str]]:
    """Get all available proxies grouped by region."""
    result = api_request("/proxies")
    if not result:
        return {}

    proxy_group = result.get('Proxy', {})
    all_proxies = proxy_group.get('all', [])

    # Filter by regions
    filtered = {
        'JP': [],
        'SG': [],
        'US': [],
    }

    for proxy in all_proxies:
        if proxy in ['DIRECT', 'REJECT']:
            continue

        for region_code, region_list in [('🇯🇵', filtered['JP']), ('🇸🇬', filtered['SG']), ('🇺🇸', filtered['US'])]:
            if proxy.startswith(region_code):
                region_list.append(proxy)
                break

    return filtered

def switch_proxy(proxy_name: str) -> bool:
    """Switch to a specific proxy."""
    result = api_request("/proxies/Proxy", method="PUT", data={"name": proxy_name})
    return result is not None

def monitor() -> None:
    """Main monitoring logic."""
    # Step 1: Check current proxy and its latency
    current_proxy = get_current_proxy()
    if not current_proxy:
        print("Failed to get current proxy", file=sys.stderr)
        return

    print(f"Current proxy: {current_proxy}", file=sys.stderr)

    # Skip testing if it's DIRECT or REJECT
    if current_proxy in ['DIRECT', 'REJECT']:
        print(f"Current proxy is {current_proxy}, skipping test", file=sys.stderr)
        return

    current_delay = test_proxy_delay(current_proxy)
    print(f"Current delay: {current_delay}ms", file=sys.stderr)

    # Step 2: Check if we need failover
    if current_delay > 0 and current_delay <= DELAY_THRESHOLD:
        print(f"Proxy is healthy ({current_delay}ms <= {DELAY_THRESHOLD}ms), no action needed", file=sys.stderr)
        return

    print(f"Proxy is unhealthy ({current_delay}ms > {DELAY_THRESHOLD}ms or failed), entering failover", file=sys.stderr)

    # Step 3: Get all JP/SG/US nodes
    all_proxies = get_all_proxies()
    candidates = []

    for region, proxies in all_proxies.items():
        for proxy in proxies:
            if proxy == current_proxy:
                continue  # Skip the current failing proxy
            candidates.append((region, proxy))

    if not candidates:
        print("No alternative proxies available", file=sys.stderr)
        return

    print(f"Testing {len(candidates)} candidate proxies...", file=sys.stderr)

    # Step 4: Test all candidates
    tested_proxies: List[Tuple[str, str, int]] = []  # (region, name, delay)

    for region, proxy_name in candidates:
        print(f"  Testing {proxy_name}...", file=sys.stderr)
        delay = test_proxy_delay(proxy_name)
        print(f"    Result: {delay}ms", file=sys.stderr)
        if delay > 0:
            tested_proxies.append((region, proxy_name, delay))

    if not tested_proxies:
        print("All candidate proxies failed latency test", file=sys.stderr)
        return

    # Step 5: Sort by delay and pick the best
    tested_proxies.sort(key=lambda x: x[2])  # Sort by delay (ascending)
    best_region, best_proxy, best_delay = tested_proxies[0]

    print(f"Best proxy found: {best_proxy} ({best_region}) with {best_delay}ms", file=sys.stderr)

    # Step 6: Switch to best proxy
    if switch_proxy(best_proxy):
        # Verify switch
        new_current = get_current_proxy()
        if new_current == best_proxy:
            print(f"NOTIFY:Clash 代理网络故障，已经从 {current_proxy} 切换到 {best_proxy}")
        else:
            print(f"Switch verification failed, current: {new_current}, expected: {best_proxy}", file=sys.stderr)
    else:
        print(f"Failed to switch to {best_proxy}", file=sys.stderr)

if __name__ == "__main__":
    monitor()
