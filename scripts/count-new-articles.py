#!/usr/bin/env python3
"""
Count new articles by comparing with last_post_date from state.
"""

import json
import sys
from datetime import datetime, timezone

def parse_date(date_str):
    """Parse various RSS/Atom date formats."""
    formats = [
        "%a, %d %b %Y %H:%M:%S %Z",      # RFC 2822
        "%a, %d %b %Y %H:%M:%S %z",      # RFC 2822 with timezone
        "%Y-%m-%dT%H:%M:%SZ",            # ISO 8601 UTC
        "%Y-%m-%dT%H:%M:%S%z",           # ISO 8601 with timezone
        "%Y-%m-%dT%H:%M:%S.%fZ",         # ISO 8601 with microseconds UTC
        "%Y-%m-%dT%H:%M:%S.%f%z",        # ISO 8601 with microseconds and timezone
        "%a, %d %b %Y %H:%M:%S GMT",     # Explicit GMT
        "%a, %d %b %Y %H:%M:%S +0000",  # With +0000 timezone
    ]

    if not date_str:
        return None

    for fmt in formats:
        try:
            dt = datetime.strptime(date_str, fmt)
            # If no timezone info, assume UTC
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except (ValueError, TypeError):
            continue

    return None

# Load state
with open('/Users/admin/.openclaw/workspace/state/blog-last-check.json', 'r') as f:
    state = json.load(f)

# Print source dates
print("=== LAST POST DATES FROM STATE ===")
for source_key, source_state in state.get('sources', {}).items():
    url = source_state.get('url', 'N/A')
    last_date = source_state.get('last_post_date', 'N/A')
    print(f"{source_key}: {last_date}")

print(f"\nLast check date: {state.get('last_check_date', 'N/A')}")

# Also check legacy entries
print(f"\n=== LEGACY ENTRIES ===")
for key, value in state.items():
    if key not in ['sources', 'last_check_date'] and isinstance(value, dict):
        print(f"{key}: {value.get('last_post_date', 'N/A')}")
