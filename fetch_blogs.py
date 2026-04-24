#!/usr/bin/env python3
"""
博客抓取脚本 - 查找新增文章
"""
import json
import requests
from datetime import datetime, timezone
import xml.etree.ElementTree as ET
import sys
from urllib.parse import urljoin, urlparse
import re

# 命名空间定义
RSS_NS = {'': 'http://purl.org/rss/1.0/'}
ATOM_NS = {'atom': 'http://www.w3.org/2005/Atom'}
RSS2_NS = {}

def parse_date(date_str):
    """解析各种格式的日期字符串"""
    formats = [
        '%a, %d %b %Y %H:%M:%S %Z',  # RFC 822
        '%a, %d %b %Y %H:%M:%S %z',  # RFC 822 with timezone
        '%Y-%m-%dT%H:%M:%S%z',       # ISO 8601
        '%Y-%m-%dT%H:%M:%SZ',        # ISO 8601 UTC
        '%Y-%m-%dT%H:%M:%S.%fZ',     # ISO 8601 with microseconds
        '%Y-%m-%d %H:%M:%S %z',      # Custom format
        '%Y-%m-%d',
    ]
    
    for fmt in formats:
        try:
            # 处理时区
            if date_str.endswith('Z'):
                date_str = date_str[:-1] + '+00:00'
            dt = datetime.strptime(date_str, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            continue
    
    # 尝试标准库解析
    try:
        from dateutil import parser
        dt = parser.parse(date_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except:
        pass
    
    return None

def is_homepage_link(link, source_url):
    """判断链接是否是首页"""
    if link == source_url:
        return True
    # 检查是否是根路径
    parsed_link = urlparse(link)
    parsed_source = urlparse(source_url)
    if parsed_link.path in ['', '/', '/index.html', '/index.php']:
        return parsed_link.netloc == parsed_source.netloc
    return False

def is_site_title(title, source_name):
    """判断标题是否是站点名称"""
    title_lower = title.lower().strip()
    source_lower = source_name.lower()
    # 如果标题包含"blog"、"home"、"index"等词,且很短,可能是站点标题
    short_words = ['blog', 'home', 'index', 'main', 'welcome']
    if len(title_lower) < 20 and any(word in title_lower for word in short_words):
        return True
    return False

def is_site_summary(summary):
    """判断摘要是否是站点简介"""
    if not summary or len(summary) < 50:
        return True
    # 简介通常包含"欢迎"、"关于"等词
    intro_words = ['欢迎', '关于', 'welcome', 'about', '这是', 'this is']
    summary_lower = summary.lower()
    return any(word in summary_lower for word in intro_words)

def fetch_rss2_items(xml_content, source_name, source_url, last_post_date):
    """解析RSS 2.0格式的feed"""
    items = []
    try:
        root = ET.fromstring(xml_content)
        # RSS 2.0 使用默认命名空间
        channel = root.find('channel')
        if channel is None:
            return items
        
        for item in channel.findall('item'):
            title_elem = item.find('title')
            link_elem = item.find('link')
            pub_date_elem = item.find('pubDate')
            desc_elem = item.find('description')
            
            if title_elem is None or link_elem is None:
                continue
            
            title = title_elem.text or ''
            link = link_elem.text or ''
            pub_date = parse_date(pub_date_elem.text) if pub_date_elem is not None and pub_date_elem.text else None
            summary = desc_elem.text or '' if desc_elem is not None else ''
            
            # 清理HTML标签
            summary = re.sub(r'<[^>]+>', ' ', summary).strip()[:500]
            
            # 检查是否是首页链接
            if is_homepage_link(link, source_url):
                print(f"  跳过首页链接: {link}")
                continue
            
            # 检查是否是站点标题
            if is_site_title(title, source_name):
                print(f"  跳过站点标题: {title}")
                continue
            
            # 检查是否是站点简介
            if is_site_summary(summary):
                print(f"  跳过站点简介: {title}")
                continue
            
            if pub_date and pub_date > last_post_date:
                items.append({
                    'title': title,
                    'link': link,
                    'pubDate': pub_date.isoformat(),
                    'summary': summary,
                    'source': source_name
                })
                
    except Exception as e:
        print(f"  RSS 2.0 解析错误: {e}")
    
    return items

def fetch_atom_entries(xml_content, source_name, source_url, last_post_date):
    """解析Atom格式的feed"""
    items = []
    try:
        root = ET.fromstring(xml_content)
        # Atom 使用默认命名空间
        for entry in root.findall('{http://www.w3.org/2005/Atom}entry'):
            title_elem = entry.find('{http://www.w3.org/2005/Atom}title')
            link_elem = entry.find("{http://www.w3.org/2005/Atom}link[@rel='alternate']")
            pub_date_elem = entry.find('{http://www.w3.org/2005/Atom}published')
            updated_elem = entry.find('{http://www.w3.org/2005/Atom}updated')
            summary_elem = entry.find('{http://www.w3.org/2005/Atom}summary')
            content_elem = entry.find("{http://www.w3.org/2005/Atom}content")
            
            if title_elem is None:
                continue
            
            title = title_elem.text or ''
            link = link_elem.get('href', '') if link_elem is not None else ''
            
            # 优先使用published,其次使用updated
            pub_date = None
            if pub_date_elem is not None and pub_date_elem.text:
                pub_date = parse_date(pub_date_elem.text)
            elif updated_elem is not None and updated_elem.text:
                pub_date = parse_date(updated_elem.text)
            
            summary = ''
            if summary_elem is not None and summary_elem.text:
                summary = summary_elem.text
            elif content_elem is not None and content_elem.text:
                summary = content_elem.text
            # 清理HTML标签
            summary = re.sub(r'<[^>]+>', ' ', summary).strip()[:500]
            
            # 检查是否是首页链接
            if is_homepage_link(link, source_url):
                print(f"  跳过首页链接: {link}")
                continue
            
            # 检查是否是站点标题
            if is_site_title(title, source_name):
                print(f"  跳过站点标题: {title}")
                continue
            
            # 检查是否是站点简介
            if is_site_summary(summary):
                print(f"  跳过站点简介: {title}")
                continue
            
            if pub_date and pub_date > last_post_date:
                items.append({
                    'title': title,
                    'link': link,
                    'pubDate': pub_date.isoformat(),
                    'summary': summary,
                    'source': source_name
                })
                
    except Exception as e:
        print(f"  Atom 解析错误: {e}")
    
    return items

def fetch_feed(feed_url, source_name, source_url, last_post_date_str):
    """抓取单个feed"""
    print(f"\n检查 {source_name}: {feed_url}")
    
    try:
        response = requests.get(feed_url, timeout=10)
        response.raise_for_status()
        content = response.text
        
        last_post_date = parse_date(last_post_date_str)
        if last_post_date is None:
            print(f"  警告: 无法解析 last_post_date: {last_post_date_str}")
            return []
        
        # 尝试判断格式
        if '<rss' in content or '<rdf:RDF' in content:
            print("  格式: RSS 2.0/RDF")
            return fetch_rss2_items(content, source_name, source_url, last_post_date)
        elif '<feed' in content:
            print("  格式: Atom")
            return fetch_atom_entries(content, source_name, source_url, last_post_date)
        else:
            print("  未知格式,跳过")
            return []
            
    except requests.exceptions.Timeout:
        print(f"  超时")
        return []
    except requests.exceptions.RequestException as e:
        print(f"  请求失败: {e}")
        return []
    except Exception as e:
        print(f"  错误: {e}")
        return []

def main():
    # 读取配置
    with open('/Users/admin/.openclaw/workspace/config/blog-sources.json', 'r', encoding='utf-8') as f:
        config = json.load(f)
    
    with open('/Users/admin/.openclaw/workspace/state/blog-last-check.json', 'r', encoding='utf-8') as f:
        state = json.load(f)
    
    all_new_articles = []
    failed_sources = []
    filtered_count = 0
    
    # 遍历所有博客源
    for blog in config['blogs']:
        blog_name = blog['name']
        blog_url = blog['url']
        feed_url = blog['feedUrl']
        source_type = blog.get('type', 'rss')
        
        # 跳过disabled的源
        if source_type == 'disabled':
            continue
        
        # 获取状态
        source_key = blog_name.lower().replace(' ', '-').replace('_', '-')
        source_state = state['sources'].get(source_key, {})
        last_post_date_str = source_state.get('last_post_date', '1970-01-01T00:00:00Z')
        
        # 抓取feed
        new_articles = fetch_feed(feed_url, blog_name, blog_url, last_post_date_str)
        
        if new_articles is None:
            # 抓取失败
            failed_sources.append(blog_name)
        else:
            all_new_articles.extend(new_articles)
    
    # 按日期排序
    all_new_articles.sort(key=lambda x: x['pubDate'], reverse=True)
    
    # 输出结果
    print(f"\n{'='*60}")
    print(f"检查完成:")
    print(f"  启用博客源数量: {len([b for b in config['blogs'] if b.get('type') != 'disabled'])}")
    print(f"  新增文章数量: {len(all_new_articles)}")
    if failed_sources:
        print(f"  抓取失败来源: {', '.join(failed_sources)}")
    
    if all_new_articles:
        print(f"\n新增文章列表:")
        for i, article in enumerate(all_new_articles, 1):
            pub_date = parse_date(article['pubDate'])
            print(f"  {i}. {article['title']}")
            print(f"     来源: {article['source']}")
            print(f"     日期: {pub_date.strftime('%Y-%m-%d %H:%M') if pub_date else 'N/A'}")
            print(f"     链接: {article['link']}")
    else:
        print("\n无新增文章")
    
    # 保存结果
    result = {
        'new_articles': all_new_articles,
        'failed_sources': failed_sources,
        'new_articles_count': len(all_new_articles)
    }
    
    with open('/Users/admin/.openclaw/workspace/blog-fetch-result.json', 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    
    print(f"\n结果已保存到: /Users/admin/.openclaw/workspace/blog-fetch-result.json")

if __name__ == '__main__':
    main()
