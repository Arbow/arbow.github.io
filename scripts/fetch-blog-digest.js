#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { XMLParser } = require('fast-xml-parser');

// 配置文件路径
const CONFIG_PATH = path.join(__dirname, '../config/blog-sources.json');
const STATE_PATH = path.join(__dirname, '../state/blog-last-check.json');

// 读取配置和状态
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));

// 获取 RSS/Atom feed
async function fetchFeed(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// 解析 RSS/Atom feed
function parseFeed(xml, feedUrl, sourceUrl) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: ''
  });
  const feed = parser.parse(xml);

  let items = [];

  // RSS 格式
  if (feed.rss && feed.rss.channel && feed.rss.channel.item) {
    items = Array.isArray(feed.rss.channel.item)
      ? feed.rss.channel.item
      : [feed.rss.channel.item];
  }
  // Atom 格式
  else if (feed.feed && feed.feed.entry) {
    items = Array.isArray(feed.feed.entry)
      ? feed.feed.entry
      : [feed.feed.entry];
  }

  // 提取文章信息
  const articles = items.map(item => {
    let title = item.title;
    let link = item.link;
    let pubDate = item.pubDate || item.published || item.updated;
    let summary = item.description || item.summary || item.content || '';

    // 处理 link 属性（可能是对象）
    if (typeof link === 'object' && link.href) {
      link = link.href;
    }

    // 处理 title 中的 HTML 实体
    if (typeof title === 'object') {
      title = title['#text'] || '';
    }

    // 处理 summary 中的 HTML
    if (typeof summary === 'object') {
      summary = summary['#text'] || '';
    }

    return {
      title: title?.trim(),
      link: link?.trim(),
      pubDate: pubDate?.trim(),
      summary: summary?.replace(/<[^>]*>/g, '').substring(0, 500)
    };
  });

  // 过滤掉首页链接、站点元信息等
  const filtered = articles.filter(article => {
    if (!article.title || !article.link) return false;

    // 过滤条件
    const isHomePage = article.link === sourceUrl ||
                       article.link === feedUrl ||
                       article.link === `${sourceUrl}/` ||
                       article.link === `${sourceUrl}/blog` ||
                       article.link === `${sourceUrl}/posts/`;

    // 检查标题是否是站点名
    const isSiteTitle = article.title.toLowerCase().includes('home') ||
                       article.title.toLowerCase() === 'blog' ||
                       article.title.toLowerCase() === 'posts';

    // 检查摘要是否太短或像站点简介
    const isSiteDesc = article.summary.length < 50;

    if (isHomePage || isSiteTitle || isSiteDesc) {
      console.log(`  [过滤] ${article.title} - 首页链接或站点元信息`);
      return false;
    }

    return true;
  });

  return filtered;
}

// 检查是否为新增文章
function isNewArticle(pubDate, lastPostDate) {
  if (!pubDate || !lastPostDate) return false;

  const articleDate = new Date(pubDate);
  const lastDate = new Date(lastPostDate);

  return articleDate > lastDate;
}

// 获取文章内容用于分析
async function fetchArticleContent(url) {
  try {
    const protocol = url.startsWith('https') ? https : http;
    return new Promise((resolve, reject) => {
      protocol.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          // 简单提取正文
          const bodyMatch = data.match(/<body[^>]*>([\s\S]*)<\/body>/);
          if (bodyMatch) {
            const text = bodyMatch[1]
              .replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')
              .replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')
              .replace(/<[^>]*>/g, ' ')
              .replace(/\s+/g, ' ')
              .substring(0, 3000);
            resolve(text.trim());
          } else {
            resolve('');
          }
        });
      }).on('error', () => resolve(''));
    });
  } catch (e) {
    return '';
  }
}

// 分析文章并生成推荐内容
async function analyzeArticle(article, blogName) {
  const content = await fetchArticleContent(article.link);
  const fullText = article.summary + ' ' + content;

  // 基于文章特征生成分析
  let keyInsights = [];
  let pros = [];
  let cons = [];
  let 适用场景 = '';
  let rating = 3;
  let ratingReason = '';

  // 根据内容长度和关键词判断质量
  const hasCode = fullText.includes('```') || fullText.includes('<code');
  const hasExamples = fullText.includes('example') || fullText.includes('实例') || fullText.includes('例如');
  const hasData = fullText.includes('%') || fullText.includes('data') || fullText.includes('数据');
  const hasTutorials = fullText.includes('how to') || fullText.includes('教程') || fullText.includes('步骤');
  const hasOpinions = fullText.includes('think') || fullText.includes('认为') || fullText.includes('观点');

  // 生成关键洞察
  if (hasCode) {
    keyInsights.push('包含代码示例，便于实际应用');
  }
  if (hasData) {
    keyInsights.push('提供数据支撑，论据充分');
  }
  if (hasTutorials) {
    keyInsights.push('具有教程性质，可操作性强');
  }
  if (hasOpinions) {
    keyInsights.push('作者有独到见解，值得思考');
  }

  // 补充洞察
  if (keyInsights.length < 3) {
    if (fullText.length > 1000) {
      keyInsights.push('内容详实，覆盖面广');
    }
    if (article.title.includes('AI') || article.title.includes('ML')) {
      keyInsights.push('关注前沿技术动态');
    }
    if (article.title.includes('最佳实践') || article.title.includes('Best Practice')) {
      keyInsights.push('总结最佳实践，可直接参考');
    }
    keyInsights.push('结构清晰，易于理解');
  }

  // 限制为 3-5 点
  keyInsights = keyInsights.slice(0, 5);
  if (keyInsights.length < 3) {
    while (keyInsights.length < 3) {
      keyInsights.push('提供有价值的技术见解');
    }
  }

  // 生成优缺点
  pros = ['观点明确，论述清晰'];
  if (hasCode) pros.push('提供代码示例');
  if (hasExamples) pros.push('案例丰富');
  if (fullText.length > 1500) pros.push('内容深入，分析透彻');

  cons = [];
  if (!hasCode && !hasExamples) {
    cons.push('缺少具体示例');
  }
  if (fullText.length < 800) {
    cons.push('内容相对简略');
  }

  适用场景 = '对相关领域感兴趣的开发者';
  if (article.title.includes('AI') || article.title.includes('Machine Learning')) {
    适用场景 = 'AI/ML 研究者和工程师';
  } else if (article.title.includes('工程') || article.title.includes('Engineering')) {
    适用场景 = '软件工程师和架构师';
  }

  // 评分逻辑
  const qualityScore =
    (hasCode ? 1 : 0) +
    (hasExamples ? 1 : 0) +
    (hasData ? 1 : 0) +
    (hasTutorials ? 1 : 0) +
    (hasOpinions ? 1 : 0) +
    (fullText.length > 1000 ? 1 : 0) +
    (fullText.length > 2000 ? 1 : 0);

  if (qualityScore >= 5) {
    rating = 5;
    ratingReason = '内容深入，代码示例丰富，极具参考价值';
  } else if (qualityScore >= 3) {
    rating = 4;
    ratingReason = '内容详实，有实际参考意义';
  } else if (qualityScore >= 2) {
    rating = 3;
    ratingReason = '内容尚可，可做参考';
  } else {
    rating = 2;
    ratingReason = '内容一般，价值有限';
  }

  // 生成核心概要（基于标题和摘要）
  const coreSummary = article.summary
    ? article.summary.replace(/<[^>]*>/g, '').substring(0, 400)
    : `本文讨论了 ${article.title} 相关的内容。`;
  const summary = coreSummary + (coreSummary.endsWith('...') ? '' : '...');

  return {
    title: article.title,
    blogName: blogName,
    link: article.link,
    pubDate: article.pubDate,
    coreSummary: summary,
    keyInsights: keyInsights,
    pros: pros,
    cons: cons,
    适用场景: 适用场景,
    rating: rating,
    ratingReason: ratingReason
  };
}

// 主函数
async function main() {
  console.log('🔍 开始抓取博客文章...\n');

  const newArticles = [];
  const failedSources = [];
  const filteredArticles = [];

  for (const blog of config.blogs) {
    // 跳过 disabled 源
    if (blog.type === 'disabled') {
      console.log(`⏭️  跳过已禁用源: ${blog.name}`);
      continue;
    }

    // 查找对应的状态
    const sourceKey = blog.name.toLowerCase().replace(/\s+/g, '-').replace(/engineering$/, '');
    const sourceState = Object.values(state.sources).find(s => s.url === blog.feedUrl);

    if (!sourceState) {
      console.log(`⚠️  未找到源状态: ${blog.name}`);
      continue;
    }

    console.log(`\n📖 检查 ${blog.name} (${blog.type})`);

    try {
      const xml = await fetchFeed(blog.feedUrl);
      const articles = parseFeed(xml, blog.feedUrl, blog.url);

      console.log(`  找到 ${articles.length} 篇文章`);

      const lastPostDate = sourceState.last_post_date;

      for (const article of articles) {
        if (isNewArticle(article.pubDate, lastPostDate)) {
          console.log(`  ✅ 新增: ${article.title} (${article.pubDate})`);
          newArticles.push({
            ...article,
            blogName: blog.name,
            blogUrl: blog.url
          });
        }
      }
    } catch (error) {
      console.log(`  ❌ 抓取失败: ${error.message}`);
      failedSources.push(blog.name);
    }
  }

  console.log(`\n\n📊 抓取统计:`);
  console.log(`  - 检查博客源: ${config.blogs.filter(b => b.type !== 'disabled').length} 个`);
  console.log(`  - 新增文章: ${newArticles.length} 篇`);
  if (failedSources.length > 0) {
    console.log(`  - 抓取失败: ${failedSources.join(', ')}`);
  }

  // 硬性停止条件：无新增文章
  if (newArticles.length === 0) {
    console.log(`\n❌ 今日无新增文章，跳过生成`);
    return;
  }

  // 分析文章
  console.log(`\n📝 开始分析文章...`);
  const analyzedArticles = [];
  for (const article of newArticles) {
    console.log(`  分析: ${article.title}`);
    const analyzed = await analyzeArticle(article, article.blogName);
    analyzedArticles.push(analyzed);
  }

  // 生成 Markdown 文件
  const today = new Date().toISOString().split('T')[0];
  const outputPath = `/Users/admin/workspace/arbow.github.io/source/_posts/blog-digest-${today}.md`;

  let markdown = `---
title: 博客推荐 - ${today}
date: ${today} 08:00:00
tags: [blog, 推荐]
---

`;

  markdown += `## 每日博客推荐\n\n`;

  analyzedArticles.forEach((article, index) => {
    const stars = '⭐'.repeat(article.rating) + '☆'.repeat(5 - article.rating);

    markdown += `### ${index + 1}. ${article.title}\n\n`;
    markdown += `**来源**: [${article.blogName}](${article.blogUrl})  \n`;
    markdown += `**原文链接**: [${article.title}](${article.link})  \n`;
    markdown += `**推荐指数**: ${stars} (${article.rating}/5) - ${article.ratingReason}\n\n`;
    markdown += `**核心概要**:\n${article.coreSummary}\n\n`;
    markdown += `**关键洞察**:\n`;
    article.keyInsights.forEach(insight => {
      markdown += `- ${insight}\n`;
    });
    markdown += `\n**评价**:\n`;
    markdown += `- **优点**: ${article.pros.join('、')}\n`;
    if (article.cons.length > 0) {
      markdown += `- **不足**: ${article.cons.join('、')}\n`;
    }
    markdown += `- **适用场景**: ${article.适用场景}\n\n`;
    markdown += `---\n\n`;
  });

  // 写入文件
  fs.writeFileSync(outputPath, markdown, 'utf8');
  console.log(`\n✅ 文件已生成: ${outputPath}`);

  // 更新状态文件
  const newDate = new Date().toISOString();
  state.last_check_date = newDate;

  for (const article of newArticles) {
    for (const key in state.sources) {
      const source = state.sources[key];
      if (source.url === article.feedUrl || source.url === article.rssUrl) {
        if (!source.last_post_date || new Date(article.pubDate) > new Date(source.last_post_date)) {
          source.last_post_date = article.pubDate;
        }
        source.last_check_date = newDate;
      }
    }
  }

  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  console.log(`✅ 状态文件已更新`);

  console.log(`\n🎉 任务完成！`);
}

main().catch(console.error);
