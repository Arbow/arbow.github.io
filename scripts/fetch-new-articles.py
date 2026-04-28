#!/usr/bin/env python3
"""
Fetch new blog articles from RSS/Atom feeds.
Strict RSS/Atom parsing with item-level validation.
"""

import json
import sys
from datetime import datetime
import requests
from urllib.parse import urlparse
import xml.etree.ElementTree as ET

# Parse date formats commonly used in RSS/Atom
def parse_date(date_str):
    """Parse various RSS/Atom date formats."""
    formats = [
        "%a, %d %b %Y %H:%M:%S %Z",      # RFC 2822
        "%a, %d %b %Y %H:%M:%S %z",      # RFC 2822 with timezone
        "%Y-%m-%dT%H:%M:%SZ",            # ISO 8601 UTC
        "%Y-%m-%dT%H:%M:%S%z",           # ISO 8601 with timezone
        "%Y-%m-%dT%H:%M:%S.%fZ",         # ISO 8601 with microseconds UTC
        "%Y-%m-%dT%H:%M:%S.%f%z",        # ISO 8601 with microseconds and timezone
        "%Y-%m-%d",
    ]

    if not date_str:
        return None

    for fmt in formats:
        try:
            return datetime.strptime(date_str, fmt)
        except (ValueError, TypeError):
            continue

    # Try cleaning up timezone info
    if '+' in date_str:
        # Handle timezone offset like +00:00
        date_str = date_str.replace(':', '', 2)
        for fmt in ["%Y-%m-%dT%H:%M:%S%z"]:
            try:
                return datetime.strptime(date_str, fmt)
            except (ValueError, TypeError):
                continue

    return None

def is_homepage_link(link, source_url):
    """Check if a link is a homepage or site-level link."""
    if not link:
        return True

    try:
        link_parsed = urlparse(link)
        source_parsed = urlparse(source_url)

        # Same domain and no path or just root path
        if link_parsed.netloc == source_parsed.netloc:
            link_path = link_parsed.path.rstrip('/') or '/'
            source_path = source_parsed.path.rstrip('/') or '/'
            if link_path == '/' or link_path == source_path:
                return True

        # Direct match to source URL
        if link == source_url:
            return True

    except Exception:
        pass

    return False

def parse_rss_items(root, source):
    """Parse RSS feed items."""
    items = []
    for item in root.findall('.//item'):
        article = {
            'title': None,
            'link': None,
            'pubDate': None,
            'summary': None,
        }

        title_elem = item.find('title')
        if title_elem is not None and title_elem.text:
            article['title'] = title_elem.text.strip()

        link_elem = item.find('link')
        if link_elem is not None and link_elem.text:
            article['link'] = link_elem.text.strip()

        pubDate_elem = item.find('pubDate')
        if pubDate_elem is not None and pubDate_elem.text:
            article['pubDate'] = pubDate_elem.text.strip()

        # Try description first, then content:encoded
        desc_elem = item.find('description')
        if desc_elem is not None and desc_elem.text:
            article['summary'] = desc_elem.text.strip()

        # Check for content:encoded namespace
        for elem in item:
            if 'encoded' in elem.tag and elem.text:
                article['summary'] = elem.text.strip()
                break

        items.append(article)

    return items

def parse_atom_items(root, source):
    """Parse Atom feed entries."""
    items = []
    namespace = {'atom': 'http://www.w3.org/2005/Atom'}

    for entry in root.findall('.//atom:entry', namespace) or root.findall('.//entry'):
        article = {
            'title': None,
            'link': None,
            'pubDate': None,
            'summary': None,
        }

        title_elem = entry.find('atom:title', namespace) or entry.find('title')
        if title_elem is not None and title_elem.text:
            article['title'] = title_elem.text.strip()

        # Atom link element is different
        link_elem = entry.find('atom:link', namespace) or entry.find('link')
        if link_elem is not None:
            href = link_elem.get('href')
            if href:
                article['link'] = href.strip()

        published_elem = entry.find('atom:published', namespace) or entry.find('published')
        if published_elem is not None and published_elem.text:
            article['pubDate'] = published_elem.text.strip()

        updated_elem = entry.find('atom:updated', namespace) or entry.find('updated')
        if not article['pubDate'] and updated_elem is not None and updated_elem.text:
            article['pubDate'] = updated_elem.text.strip()

        # Try summary first, then content
        summary_elem = entry.find('atom:summary', namespace) or entry.find('summary')
        if summary_elem is not None and summary_elem.text:
            article['summary'] = summary_elem.text.strip()

        content_elem = entry.find('atom:content', namespace) or entry.find('content')
        if content_elem is not None and content_elem.text:
            article['summary'] = content_elem.text.strip()

        items.append(article)

    return items

def validate_article(article, source):
    """Validate that an article is legitimate and not site metadata."""
    errors = []

    # Must have title and link
    if not article['title']:
        errors.append("Missing title")
    if not article['link']:
        errors.append("Missing link")

    # Check if link is homepage
    if article['link'] and is_homepage_link(article['link'], source['url']):
        errors.append("Link is homepage/site URL")

    # Check if title looks like site name
    if article['title']:
        title_lower = article['title'].lower()
        site_name = source['name'].lower()
        if title_lower == site_name or site_name in title_lower:
            # Could be legitimate, but suspicious
            if len(article['title']) < 20:  # Very short titles are suspicious
                errors.append(f"Title matches site name or is too short: {article['title']}")

    return errors

def fetch_source(source_config, state_config):
    """Fetch articles from a single source."""
    feed_url = source_config['feedUrl']
    source_key = source_config['name'].lower().replace(' ', '-').replace('.', '')

    # Get last post date from state
    source_state = state_config.get('sources', {}).get(source_key, {})
    last_post_date_str = source_state.get('last_post_date')
    last_post_date = None
    if last_post_date_str:
        last_post_date = parse_date(last_post_date_str)

    new_articles = []
    errors = []

    try:
        response = requests.get(feed_url, timeout=30)
        response.raise_for_status()
        content = response.text

        root = ET.fromstring(content)

        # Detect RSS or Atom
        is_atom = root.tag == '{http://www.w3.org/2005/Atom}feed' or root.tag == 'feed'
        is_rss = root.tag == 'rss' or root.tag == '{http://www.w3.org/1999/02/22-rdf-syntax-ns#}RDF'

        if is_atom:
            items = parse_atom_items(root, source_config)
        elif is_rss:
            items = parse_rss_items(root, source_config)
        else:
            # Unknown format, try both
            items = []
            try:
                items = parse_rss_items(root, source_config)
            except:
                try:
                    items = parse_atom_items(root, source_config)
                except:
                    pass

        if not items:
            errors.append("Could not parse feed - no items found")
            return [], errors

        # Validate and filter items
        for item in items:
            validation_errors = validate_article(item, source_config)

            if validation_errors:
                # Invalid article (homepage link, site metadata, etc.)
                continue

            # Parse publication date
            article_date = parse_date(item['pubDate'])

            if not article_date:
                # Can't determine date, skip
                continue

            # Strict comparison: only include if newer than last_post_date
            if last_post_date and article_date <= last_post_date:
                continue

            # This is a valid new article
            new_articles.append({
                'title': item['title'],
                'link': item['link'],
                'pubDate': item['pubDate'],
                'summary': item['summary'] or '',
                'source_name': source_config['name'],
                'source_url': source_config['url']
            })

    except requests.exceptions.Timeout:
        errors.append("Request timeout")
    except requests.exceptions.RequestException as e:
        errors.append(f"Request failed: {str(e)}")
    except ET.ParseError as e:
        errors.append(f"XML parse error: {str(e)}")
    except Exception as e:
        errors.append(f"Unexpected error: {str(e)}")

    return new_articles, errors

def main():
    # Load config
    with open('/Users/admin/.openclaw/workspace/config/blog-sources.json', 'r') as f:
        config = json.load(f)

    with open('/Users/admin/.openclaw/workspace/state/blog-last-check.json', 'r') as f:
        state = json.load(f)

    all_new_articles = []
    failed_sources = []
    disabled_count = 0
    checked_sources = 0

    # Process each source
    for source in config['blogs']:
        if source.get('type') == 'disabled':
            disabled_count += 1
            continue

        checked_sources += 1
        new_articles, errors = fetch_source(source, state)

        if errors:
            failed_sources.append({
                'name': source['name'],
                'errors': errors
            })

        all_new_articles.extend(new_articles)

    # Output results
    result = {
        'checked_sources': checked_sources,
        'disabled_sources': disabled_count,
        'failed_sources': failed_sources,
        'new_articles_count': len(all_new_articles),
        'new_articles': all_new_articles,
        'new_articles_count_display': len(all_new_articles)  # For sanity check
    }

    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
