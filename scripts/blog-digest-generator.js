#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { XMLParser } = require('fast-xml-parser');
const { JSDOM } = require('jsdom');

// Configuration
const CONFIG_PATH = '/Users/admin/.openclaw/workspace/config/blog-sources.json';
const STATE_PATH = '/Users/admin/.openclaw/workspace/state/blog-last-check.json';
const OUTPUT_DIR = '/Users/admin/workspace/arbow.github.io/source/_posts';
const CURRENT_TIME = new Date();

// Load configuration
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
const lastPostDate = new Date(state.last_post_date);

console.log(`📅 Current time: ${CURRENT_TIME.toISOString()}`);
console.log(`📅 Last post date: ${lastPostDate.toISOString()}`);
console.log(``);

// Filter enabled blogs (exclude disabled)
const enabledBlogs = config.blogs.filter(blog => blog.type !== 'disabled');
console.log(`✅ Enabled blogs: ${enabledBlogs.length}`);

// Track results
const results = {
  checked: 0,
  failed: [],
  newArticles: [],
  rejected: []
};

// Helper: fetch URL
function fetchUrl(url, isWebpage = false) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const headers = isWebpage ? {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    } : {};

    client.get(url, { headers }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301 || res.statusCode === 307 || res.statusCode === 308) {
        return fetchUrl(res.headers.location, isWebpage).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Helper: check if link is homepage/feed URL
function isHomepageLink(link, source) {
  try {
    const linkUrl = new URL(link);
    const sourceUrl = new URL(source.url);

    // Check if link matches source URL
    if (linkUrl.href === sourceUrl.href || linkUrl.href === source.url) {
      return true;
    }

    // Check if link is the feed URL
    if (source.feedUrl && linkUrl.href === source.feedUrl) {
      return true;
    }

    // Check if link ends with common homepage patterns
    const linkPath = linkUrl.pathname.replace(/\/$/, '');
    const sourcePath = sourceUrl.pathname.replace(/\/$/, '');

    if (linkPath === sourcePath || linkPath === '' || linkPath === '/') {
      return true;
    }

    // Check if link is clearly a homepage (no article-like path)
    if (linkPath === '' || linkPath === '/' || linkPath === sourcePath) {
      return true;
    }

    return false;
  } catch (e) {
    return true; // Assume homepage if URL parsing fails
  }
}

// Helper: check if title looks like site name instead of article title
function isSiteName(title, source) {
  const siteNames = [
    source.name,
    source.name.toLowerCase(),
    source.name.replace(/\s+/g, ''),
    'blog',
    'home',
    'index'
  ];

  const titleLower = title.toLowerCase().trim();

  // Very short titles are often site names
  if (titleLower.length < 5) return true;

  // Title exactly matches site name
  if (titleLower === source.name.toLowerCase()) return true;

  // Title contains only common site-level keywords
  if (/^(blog|home|index|posts|articles|updates|news|engineering)$/i.test(titleLower)) return true;

  return false;
}

// Helper: check if summary looks like site description instead of article summary
function isSiteDescription(summary, source) {
  const summaryLower = summary.toLowerCase().trim();

  // Very short summaries (less than 50 chars) are often site descriptions
  if (summaryLower.length < 50 && !summaryLower.includes('.')) return true;

  // Summary contains only generic site-level text
  const genericPatterns = [
    /^(a blog about|blog for|welcome to|home of|latest from)/i,
    /^(official blog|engineering blog|technical blog)/i
  ];

  for (const pattern of genericPatterns) {
    if (pattern.test(summaryLower)) return true;
  }

  return false;
}

// Fetch RSS/Atom feed
async function fetchFeed(source) {
  try {
    const xml = await fetchUrl(source.feedUrl || source.url);
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text'
    });

    const feed = parser.parse(xml);
    return feed;
  } catch (error) {
    throw new Error(`Failed to fetch feed: ${error.message}`);
  }
}

// Parse RSS/Atom feed and extract articles
function parseFeed(feed, source) {
  const articles = [];

  // Check for RSS format
  if (feed.rss && feed.rss.channel && feed.rss.channel.item) {
    const items = Array.isArray(feed.rss.channel.item)
      ? feed.rss.channel.item
      : [feed.rss.channel.item];

    for (const item of items) {
      const article = {
        title: item.title || '',
        link: item.link || '',
        pubDate: item.pubDate || item.date || item['dc:date'] || '',
        summary: item.description || item.summary || item['content:encoded'] || '',
        guid: item.guid || item.link || ''
      };

      articles.push(article);
    }
  }
  // Check for Atom format
  else if (feed.feed && feed.feed.entry) {
    const entries = Array.isArray(feed.feed.entry)
      ? feed.feed.entry
      : [feed.feed.entry];

    for (const entry of entries) {
      const link = Array.isArray(entry.link)
        ? (entry.link.find(l => l['@_rel'] === 'alternate') || entry.link[0])['@_href']
        : entry.link['@_href'];

      const article = {
        title: entry.title || '',
        link: link || '',
        pubDate: entry.published || entry.updated || '',
        summary: entry.summary || entry.content || '',
        guid: entry.id || link || ''
      };

      articles.push(article);
    }
  }

  return articles;
}

// Check if article is new
function isNewArticle(article, lastDate) {
  try {
    const articleDate = new Date(article.pubDate);
    return articleDate > lastDate;
  } catch (e) {
    return false;
  }
}

// Helper: strip HTML tags
function stripHtml(html) {
  if (!html) return '';
  const dom = new JSDOM(`<div>${html}</div>`);
  return dom.window.document.querySelector('div').textContent
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 500);
}

// Helper: extract clean summary from article
function extractSummary(article) {
  let summary = article.summary || '';

  // Try to get content from description or summary
  if (!summary || summary.length < 50) {
    return '';
  }

  // Strip HTML
  const cleanSummary = stripHtml(summary);

  // If still too short, return empty
  if (cleanSummary.length < 50) {
    return '';
  }

  return cleanSummary;
}

// Helper: fetch webpage content for better analysis
async function fetchWebpageContent(url) {
  try {
    const html = await fetchUrl(url, true);
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Try to find main content
    const selectors = [
      'article',
      '[role="main"]',
      'main',
      '.post-content',
      '.entry-content',
      '.content',
      '#content'
    ];

    let content = '';
    for (const selector of selectors) {
      const element = doc.querySelector(selector);
      if (element) {
        content = element.textContent;
        break;
      }
    }

    // Fallback to body
    if (!content || content.length < 200) {
      content = doc.body.textContent;
    }

    // Clean up
    return content
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 3000);
  } catch (error) {
    return '';
  }
}

// Validate article is not homepage/site metadata
function validateArticle(article, source) {
  // Check for homepage link
  if (isHomepageLink(article.link, source)) {
    return { valid: false, reason: 'Homepage link' };
  }

  // Check for site name as title
  if (isSiteName(article.title, source)) {
    return { valid: false, reason: 'Site name as title' };
  }

  // Check for site description as summary
  if (article.summary && isSiteDescription(article.summary, source)) {
    return { valid: false, reason: 'Site description as summary' };
  }

  // Check if title or link is empty
  if (!article.title || !article.link) {
    return { valid: false, reason: 'Missing title or link' };
  }

  return { valid: true, reason: '' };
}

// Main function
async function main() {
  console.log('🔍 Checking blogs for new articles...\n');

  for (const blog of enabledBlogs) {
    results.checked++;
    console.log(`[${results.checked}/${enabledBlogs.length}] Checking: ${blog.name}`);

    try {
      const feed = await fetchFeed(blog);
      const articles = parseFeed(feed, blog);

      let foundNew = 0;
      for (const article of articles) {
        if (isNewArticle(article, lastPostDate)) {
          // Validate article
          const validation = validateArticle(article, blog);

          if (!validation.valid) {
            results.rejected.push({
              blog: blog.name,
              title: article.title,
              link: article.link,
              reason: validation.reason
            });
            continue;
          }

          results.newArticles.push({
            ...article,
            blogName: blog.name,
            blogUrl: blog.url
          });
          foundNew++;
        }
      }

      if (foundNew > 0) {
        console.log(`  ✅ Found ${foundNew} new article(s)`);
      } else {
        console.log(`  ℹ️  No new articles`);
      }

    } catch (error) {
      console.log(`  ❌ Failed: ${error.message}`);
      results.failed.push({
        blog: blog.name,
        url: blog.url,
        error: error.message
      });
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('📊 SUMMARY');
  console.log('='.repeat(60));
  console.log(`Checked: ${results.checked} blogs`);
  console.log(`Failed: ${results.failed.length} sources`);
  console.log(`Rejected: ${results.rejected.length} articles`);
  console.log(`New articles: ${results.newArticles.length}`);

  if (results.failed.length > 0) {
    console.log('\n❌ Failed sources:');
    for (const fail of results.failed) {
      console.log(`  - ${fail.blog}: ${fail.error}`);
    }
  }

  if (results.rejected.length > 0) {
    console.log('\n🚫 Rejected articles:');
    for (const reject of results.rejected) {
      console.log(`  - ${reject.blog}: "${reject.title}" (${reject.reason})`);
    }
  }

  // Sanity check: verify new articles count
  const newArticlesCount = results.newArticles.length;
  console.log(`\n✅ new_articles_count = ${newArticlesCount}`);

  // Final validation of new articles
  const validArticles = [];
  for (const article of results.newArticles) {
    const blog = enabledBlogs.find(b => b.name === article.blogName);
    const validation = validateArticle(article, blog);

    if (!validation.valid) {
      console.log(`⚠️  Rejected during final validation: ${article.title} (${validation.reason})`);
      continue;
    }

    validArticles.push(article);
  }

  console.log(`✅ Valid new articles after final check: ${validArticles.length}`);

  if (validArticles.length === 0) {
    console.log('\n今日无新增文章，跳过生成');
    process.exit(0);
  }

  // Sort articles by date
  validArticles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  // Generate digest content
  const today = new Date().toISOString().split('T')[0];
  const outputFilePath = path.join(OUTPUT_DIR, `blog-digest-${today}.md`);

  let markdown = `---
title: 博客推荐 - ${today}
date: ${today} 08:00:00
tags:
  - 博客推荐
---

# 博客推荐 - ${today}

以下是为您精选的今日新增博客文章：

`;

  // Add each article with analysis
  console.log('\n📝 Generating detailed analysis for each article...');
  for (let i = 0; i < validArticles.length; i++) {
    const article = validArticles[i];
    console.log(`  [${i + 1}/${validArticles.length}] Analyzing: ${article.title}`);

    // Fetch webpage content for better analysis
    const webpageContent = await fetchWebpageContent(article.link);
    const analysis = analyzeArticle(article, webpageContent);

    markdown += `
### ${i + 1}. ${article.title}

**来源**: [${article.blogName}](${article.blogUrl})
**原文链接**: [${article.title}](${article.link})
**发布日期**: ${new Date(article.pubDate).toLocaleDateString('zh-CN')}
**推荐指数**: ${analysis.rating} (${analysis.score}/5) - ${analysis.reason}

**核心概要**:
${analysis.summary}

**关键洞察**:
${analysis.insights.map((insight, idx) => `${idx + 1}. ${insight}`).join('\n')}

**评价**:
- **优点**: ${analysis.pros}
- **不足**: ${analysis.cons}
- **适用场景**: ${analysis.scenario}

---
`;
  }

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Write the digest file
  fs.writeFileSync(outputFilePath, markdown, 'utf8');
  console.log(`\n✅ Digest written to: ${outputFilePath}`);

  // Update state with latest article date
  if (validArticles.length > 0) {
    const latestDate = validArticles.reduce((latest, article) => {
      const articleDate = new Date(article.pubDate);
      return articleDate > latest ? articleDate : latest;
    }, lastPostDate);

    state.last_check = CURRENT_TIME.toISOString();
    state.last_post_date = latestDate.toISOString();
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    console.log(`✅ State updated to: ${state.last_post_date}`);
  }

  console.log('\n🎉 Daily blog digest generated successfully!');
  return outputFilePath;
}

// Better article analysis with keyword-based scoring
function analyzeArticle(article, cleanContent = '') {
  const titleLower = article.title.toLowerCase();
  const summaryLower = (article.summary || '').toLowerCase();
  const contentLower = cleanContent.toLowerCase();
  const fullText = `${titleLower} ${summaryLower} ${contentLower}`;

  // Score calculation with multiple factors
  let score = 3; // Base score
  let reasons = [];

  // High-value keywords
  const highValueKeywords = [
    'architecture', 'distributed system', 'scalability', 'performance optimization',
    'machine learning', 'deep learning', 'ai', 'llm', 'gpt', 'transformer',
    'security', 'vulnerability', 'exploit', 'best practices',
    '系统架构', '分布式', '可扩展性', '性能优化', '机器学习', '深度学习',
    '人工智能', '大模型', '架构', '安全', '漏洞'
  ];

  // Medium-value keywords
  const mediumValueKeywords = [
    'tutorial', 'guide', 'how to', 'learn', 'best practice', 'pattern',
    'optimization', 'algorithm', 'design', 'framework',
    '教程', '指南', '最佳实践', '优化', '算法', '设计', '框架'
  ];

  // Check for high-value content
  const hasHighValue = highValueKeywords.some(kw => fullText.includes(kw));
  if (hasHighValue) {
    score += 1;
    reasons.push('高价值技术内容');
  }

  // Check for medium-value content
  const hasMediumValue = mediumValueKeywords.some(kw => fullText.includes(kw));
  if (hasMediumValue && !hasHighValue) {
    score += 0.5;
    reasons.push('实用指南类内容');
  }

  // Check for implementation details
  const implementationKeywords = ['code', 'implementation', 'example', 'demo', '代码', '实现', '示例'];
  const hasImplementation = implementationKeywords.some(kw => fullText.includes(kw));
  if (hasImplementation) {
    score += 0.3;
  }

  // Check for original research/data
  const researchKeywords = ['research', 'study', 'experiment', 'data', 'analysis', '研究', '实验', '数据', '分析'];
  const hasResearch = researchKeywords.some(kw => fullText.includes(kw));
  if (hasResearch) {
    score += 0.3;
  }

  // Length bonus (longer content usually more comprehensive)
  const contentLength = (cleanContent || article.summary || '').length;
  if (contentLength > 2000) {
    score += 0.3;
  } else if (contentLength < 200) {
    score -= 0.5;
  }

  // Cap score at 5, minimum at 1
  score = Math.min(Math.max(score, 1), 5);

  // Generate rating
  const stars = '⭐'.repeat(Math.floor(score));
  const ratingMap = {
    5: { text: '必读，极具价值', label: '强烈推荐' },
    4: { text: '推荐，值得一读', label: '推荐' },
    3: { text: '参考，特定场景', label: '参考' },
    2: { text: '一般，价值有限', label: '一般' },
    1: { text: '不推荐', label: '不推荐' }
  };
  const rating = ratingMap[Math.floor(score)];

  // Generate summary
  const cleanSummary = stripHtml(article.summary || '') || cleanContent.substring(0, 300);
  let summary = cleanSummary.length > 100
    ? cleanSummary.substring(0, 350) + '...'
    : `这篇文章主要讨论了${article.title}相关的技术和实践。`;

  // Generate insights based on content
  const insights = generateInsights(fullText, article.title, score);

  // Generate pros/cons/scenario
  const pros = generatePros(fullText, score);
  const cons = generateCons(fullText, score);
  const scenario = generateScenario(fullText, hasHighValue, hasMediumValue);

  return {
    rating: stars,
    score: score,
    reason: rating.text,
    label: rating.label,
    summary: summary,
    insights: insights,
    pros: pros,
    cons: cons,
    scenario: scenario
  };
}

// Generate insights based on content
function generateInsights(fullText, title, score) {
  const insights = [];

  // Add insight based on score and content
  if (score >= 4) {
    if (fullText.includes('system') || fullText.includes('系统')) {
      insights.push('深入探讨了系统架构和技术实现细节');
    }
    if (fullText.includes('ai') || fullText.includes('ml') || fullText.includes('人工智能')) {
      insights.push('提供了AI/机器学习领域的专业见解');
    }
    if (fullText.includes('performance') || fullText.includes('optimization') || fullText.includes('性能')) {
      insights.push('分享了性能优化的实践经验和最佳实践');
    }
  }

  if (insights.length < 3) {
    insights.push('文章提供了实用的技术见解和参考方案');
  }

  if (insights.length < 3 && (fullText.includes('code') || fullText.includes('代码'))) {
    insights.push('包含实际代码示例，便于理解和实践');
  }

  // Ensure we have at least 3 insights
  while (insights.length < 3) {
    insights.push('值得深入阅读和思考的内容');
  }

  return insights.slice(0, 5);
}

// Generate pros
function generatePros(fullText, score) {
  const prosList = [];

  if (score >= 4) {
    if (fullText.includes('best practice') || fullText.includes('最佳实践')) {
      prosList.push('总结了最佳实践，具有指导意义');
    }
    prosList.push('内容详实，逻辑清晰');
    prosList.push('有实际参考价值');
  } else if (score >= 3) {
    prosList.push('内容清晰易懂');
    prosList.push('提供了有用的信息');
  } else {
    prosList.push('内容相对简单');
  }

  return prosList.join('，');
}

// Generate cons
function generateCons(fullText, score) {
  if (score >= 5) {
    return '内容较为专业，需要一定技术基础';
  } else if (score >= 4) {
    return '部分内容需要相关知识背景';
  } else if (score >= 3) {
    return '内容相对基础，适合入门读者';
  } else {
    return '价值有限，仅供参考';
  }
}

// Generate scenario
function generateScenario(fullText, hasHighValue, hasMediumValue) {
  if (hasHighValue) {
    return '相关领域的开发者和工程师';
  } else if (hasMediumValue) {
    return '对该主题感兴趣的从业者和学生';
  } else {
    return '一般读者';
  }
}

// Run main
main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
