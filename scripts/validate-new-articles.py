#!/usr/bin/env python3
"""
Validate and count actual new articles by strict date comparison.
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

# Create a mapping of source URLs to last_post_date
source_dates = {}
for source_key, source_state in state.get('sources', {}).items():
    source_dates[source_state['url']] = parse_date(source_state.get('last_post_date'))

# Load the fetch results
import subprocess
result = subprocess.run(
    ['python3', '/Users/admin/.openclaw/workspace/scripts/fetch-new-articles.py'],
    capture_output=True,
    text=True,
    timeout=120
)

if result.returncode != 0:
    print(f"Error running fetch script: {result.stderr}")
    sys.exit(1)

fetch_data = json.loads(result.stdout)

# Filter to actual new articles
actual_new_articles = []
rejected_articles = []

for article in fetch_data['new_articles']:
    source_url = article['source_url']
    article_date = parse_date(article['pubDate'])

    if not article_date:
        rejected_articles.append({
            'title': article['title'],
            'reason': 'Could not parse date',
            'pubDate': article['pubDate']
        })
        continue

    if source_url not in source_dates:
        # No last_post_date recorded, treat as new
        actual_new_articles.append(article)
        continue

    last_date = source_dates[source_url]

    if not last_date:
        actual_new_articles.append(article)
        continue

    # Strict comparison: must be strictly greater than
    if article_date > last_date:
        actual_new_articles.append(article)
    else:
        rejected_articles.append({
            'title': article['title'],
            'source': article['source_name'],
            'pubDate': article['pubDate'],
            'last_post_date': last_date.isoformat(),
            'reason': f"Article date {article_date.isoformat()} <= last_post_date {last_date.isoformat()}"
        })

# Output summary
print(f"\n=== VALIDATION SUMMARY ===")
print(f"Total articles fetched: {len(fetch_data['new_articles'])}")
print(f"Actual NEW articles (strict comparison): {len(actual_new_articles)}")
print(f"Rejected articles (old or no date): {len(rejected_articles)}")

if actual_new_articles:
    print(f"\n=== NEW ARTICLES ({len(actual_new_articles)}) ===")
    for i, article in enumerate(actual_new_articles, 1):
        print(f"{i}. [{article['pubDate']}] {article['title']}")
        print(f"   Source: {article['source_name']}")
        print(f"   Link: {article['link']}")

if rejected_articles:
    print(f"\n=== REJECTED SAMPLE (first 20) ===")
    for article in rejected_articles[:20]:
        print(f"- {article.get('title', 'N/A')[:60]}")
        print(f"  Reason: {article['reason']}")

# Output for next step
print(f"\nnew_articles_count = {len(actual_new_articles)}")
