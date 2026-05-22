#!/usr/bin/env node

import fs from 'fs';
import https from 'https';
import http from 'http';
import { XMLParser } from 'fast-xml-parser';

const CONFIG_PATH = '/Users/admin/.openclaw/workspace/config/blog-sources.json';
const STATE_PATH = '/Users/admin/.openclaw/workspace/state/blog-last-check.json';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function parseRSSItems(feedData, sourceUrl, sourceName) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    textNodeName: 'text',
    parseTagValue: true,
    trimValues: true
  });

  let items = [];
  const result = parser.parse(feedData);

  // Handle RSS format (rss.channel.item)
  if (result.rss && result.rss.channel && result.rss.channel.item) {
    items = Array.isArray(result.rss.channel.item)
      ? result.rss.channel.item
      : [result.rss.channel.item];
  }
  // Handle Atom format (feed.entry)
  else if (result.feed && result.feed.entry) {
    items = Array.isArray(result.feed.entry)
      ? result.feed.entry
      : [result.feed.entry];
  }

  // Parse and filter items
  return items
    .map(item => {
      const title = item.title || '';
      let link = '';

      if (typeof item.link === 'string') {
        link = item.link;
      } else if (item.link && item.link.href) {
        link = item.link.href;
      } else if (item.link && item.link['@_href']) {
        link = item.link['@_href'];
      }

      let pubDate = item.pubDate || item.published || item.updated || item.date || '';
      let summary = item.description || item.summary || item.content || '';

      if (summary && typeof summary === 'object' && summary.text) {
        summary = summary.text;
      }

      return { title, link, pubDate, summary };
    })
    .filter(item => {
      // Sanity checks: exclude homepage links, site metadata
      if (!item.link) return false;
      if (!item.title || item.title.trim().length === 0) return false;

      // Skip if link is the source URL (homepage)
      if (item.link === sourceUrl || item.link === sourceUrl.replace(/\/$/, '')) return false;

      // Skip obvious homepage patterns
      const normalizedLink = item.link.replace(/\/$/, '');
      const normalizedSource = sourceUrl.replace(/\/$/, '');

      if (normalizedLink === normalizedSource) return false;

      // Skip if link ends with common feed/index pages
      if (normalizedLink.match(/\/(index|feed|rss|atom)(\.(xml|rss|html?))?$/i)) return false;

      return true;
    });
}

function fetchURL(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

async function main() {
  // Load config and state
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  let state = { last_check_time: null, last_post_date: null };

  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (e) {
    // State file doesn't exist yet
  }

  const cutoffDate = state.last_post_date ? new Date(state.last_post_date) : null;
  const enabledSources = config.blogs.filter(b => b.type !== 'disabled');

  console.error(`Enabled sources: ${enabledSources.length}`);

  const allArticles = [];
  const failedSources = [];
  const sourcesWithNew = [];

  for (const source of enabledSources) {
    console.error(`Checking: ${source.name} (${source.type})`);

    try {
      const feedUrl = source.feedUrl || source.url;
      const feedData = await fetchURL(feedUrl);
      const articles = parseRSSItems(feedData, source.url, source.name);

      if (articles.length === 0) {
        console.error(`  No articles found`);
        continue;
      }

      // Filter new articles
      const newArticles = articles
        .filter(article => {
          if (!article.pubDate) return false;
          const pubDate = new Date(article.pubDate);
          return cutoffDate && pubDate > cutoffDate;
        })
        .map(article => ({
          title: article.title,
          link: article.link,
          source: source.name,
          pub_date: article.pubDate,
          summary: article.summary || ''
        }));

      if (newArticles.length > 0) {
        console.error(`  Found ${newArticles.length} new articles`);
        allArticles.push(...newArticles);
        sourcesWithNew.push(source.name);
      } else {
        console.error(`  No new articles`);
      }
    } catch (e) {
      console.error(`  Failed: ${e.message}`);
      failedSources.push(source.name);
    }
  }

  console.error(`\nTotal new articles: ${allArticles.length}`);
  console.error(`Sources checked: ${enabledSources.length}`);
  console.error(`Sources failed: ${failedSources.length}`);
  console.error(`Sources with new: ${sourcesWithNew.length}`);

  // Output results
  console.log(JSON.stringify({
    new_articles_count: allArticles.length,
    sources_checked: enabledSources.length,
    sources_failed: failedSources.length,
    failed_sources_list: failedSources,
    sources_with_new: sourcesWithNew,
    articles: allArticles
  }, null, 2));
}

main().catch(console.error);