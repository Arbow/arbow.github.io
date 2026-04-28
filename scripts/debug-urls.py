#!/usr/bin/env python3
"""Debug URL matching between config and state."""

import json

with open('/Users/admin/.openclaw/workspace/config/blog-sources.json', 'r') as f:
    config = json.load(f)

with open('/Users/admin/.openclaw/workspace/state/blog-last-check.json', 'r') as f:
    state = json.load(f)

print("=== CONFIG SOURCES (URLs) ===")
for blog in config['blogs']:
    print(f"{blog['name']}: {blog['url']}")

print(f"\n=== STATE SOURCES (URLs) ===")
for source_key, source_state in state.get('sources', {}).items():
    url = source_state.get('url')
    print(f"{source_key}: {url}")

print(f"\n=== LEGACY STATE ENTRIES (URLs) ===")
for key, value in state.items():
    if key not in ['sources', 'last_check_date'] and isinstance(value, dict):
        url = value.get('url')
        print(f"{key}: {url}")
