const RSSParser = require('rss-parser');
const parser = new RSSParser();
const https = require('https');
const http = require('http');

// Configuration
const config = require('/Users/admin/.openclaw/workspace/config/blog-sources.json');
const state = require('/Users/admin/.openclaw/workspace/state/blog-last-check.json');
const lastPostDate = new Date(state.last_post_date);
console.log(`Fetching articles newer than: ${lastPostDate.toISOString()}`);

// All 10 sources are enabled (no disabled sources)
const enabledSources = config.blogs.filter(blog => blog.type !== 'disabled');
console.log(`\nEnabled sources to check: ${enabledSources.length}`);

async function fetchWithTimeout(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

async function parseRSSFeed(feedUrl, sourceUrl) {
  try {
    const xml = await fetchWithTimeout(feedUrl);
    const feed = await parser.parseString(xml);

    // STRICT: Parse by item/entry, not by extracting arrays
    const items = feed.items || [];
    const articles = [];

    for (const item of items) {
      const pubDate = item.pubDate ? new Date(item.pubDate) : null;
      const link = item.link || item.guid;

      // Skip if no pubDate
      if (!pubDate) continue;

      // STRICT: Skip if link equals source URL (homepage)
      if (link === sourceUrl) continue;

      // STRICT: Skip if link points to feed URL
      if (link === feedUrl) continue;

      // STRICT: Skip if title looks like site name
      const title = item.title || '';
      if (feed.title && title === feed.title) continue;

      // STRICT: Skip if summary looks like site description
      const summary = item['content:encoded'] || item.contentSnippet || item.description || '';
      if (feed.description && summary === feed.description) continue;

      // STRICT: Only compare if pubDate > lastPostDate (not >=)
      if (pubDate > lastPostDate) {
        articles.push({
          title: title,
          link: link,
          pubDate: pubDate,
          summary: summary,
          content: item['content:encoded'] || summary
        });
      }
    }

    return articles;
  } catch (error) {
    throw new Error(`Failed to parse RSS: ${error.message}`);
  }
}

async function fetchRSSHubFeed(feedUrl, sourceUrl) {
  return parseRSSFeed(feedUrl, sourceUrl);
}

async function main() {
  const results = {
    new_articles: [],
    failed_sources: [],
    skipped_homepage: [],
    source_counts: {}
  };

  for (const source of enabledSources) {
    console.log(`\nChecking: ${source.name} (${source.type})`);
    try {
      let articles = [];
      if (source.type === 'rss' || source.type === 'rsshub') {
        if (source.type === 'rss') {
          articles = await parseRSSFeed(source.feedUrl, source.url);
        } else {
          articles = await fetchRSSHubFeed(source.feedUrl, source.url);
        }

        if (articles.length > 0) {
          results.new_articles.push(...articles.map(a => ({
            ...a,
            source: source.name,
            sourceUrl: source.url
          })));
          results.source_counts[source.name] = articles.length;
          console.log(`  ✓ Found ${articles.length} new article(s)`);
        } else {
          console.log(`  No new articles`);
        }
      } else if (source.type === 'html') {
        console.log(`  HTML fetching not implemented, skipping`);
      }
    } catch (error) {
      console.log(`  ✗ Failed: ${error.message}`);
      results.failed_sources.push(source.name);
    }
  }

  // Sort articles by pubDate (newest first)
  results.new_articles.sort((a, b) => b.pubDate - a.pubDate);

  console.log(`\n${'='.repeat(50)}`);
  console.log(`SUMMARY:`);
  console.log(`Enabled sources checked: ${enabledSources.length}`);
  console.log(`Total new articles found: ${results.new_articles.length}`);
  console.log(`Failed sources: ${results.failed_sources.length}`);
  if (results.failed_sources.length > 0) {
    console.log(`  - ${results.failed_sources.join(', ')}`);
  }
  console.log(`Skipped homepage/metadata: ${results.skipped_homepage.length}`);

  // Print new articles for sanity check
  if (results.new_articles.length > 0) {
    console.log(`\nNEW ARTICLES:`);
    results.new_articles.forEach((a, i) => {
      console.log(`  ${i + 1}. [${a.pubDate.toISOString().split('T')[0]}] ${a.title}`);
      console.log(`     Source: ${a.source}`);
      console.log(`     Link: ${a.link}`);
    });
  }

  // Sanity check: verify no homepage links
  console.log(`\nSANITY CHECK:`);
  const suspicious = results.new_articles.filter(a => {
    const url = new URL(a.link);
    const sourceUrl = new URL(a.sourceUrl);
    // Check if link is homepage (no path or just /)
    return url.pathname === '/' || url.pathname === '';
  });

  if (suspicious.length > 0) {
    console.log(`  ✗ ERROR: Found suspicious homepage links:`);
    suspicious.forEach(a => {
      console.log(`    - ${a.title} -> ${a.link}`);
    });
    results.new_articles = [];
    console.log(`  ✗ All articles discarded due to homepage links`);
  } else {
    console.log(`  ✓ No homepage links found`);
  }

  console.log(`Final new_articles_count = ${results.new_articles.length}`);
  console.log(`${'='.repeat(50)}`);

  return results;
}

main().catch(console.error);
