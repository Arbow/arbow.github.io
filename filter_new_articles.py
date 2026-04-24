#!/usr/bin/env python3
"""
过滤真正的新增文章 - 严格日期比较
"""
import json
from datetime import datetime, timezone

def parse_date(date_str):
    """解析各种格式的日期字符串"""
    formats = [
        '%a, %d %b %Y %H:%M:%S %Z',
        '%a, %d %b %Y %H:%M:%S %z',
        '%Y-%m-%dT%H:%M:%S%z',
        '%Y-%m-%dT%H:%M:%SZ',
        '%Y-%m-%dT%H:%M:%S.%fZ',
        '%Y-%m-%d %H:%M:%S %z',
        '%Y-%m-%d',
    ]
    
    for fmt in formats:
        try:
            if date_str.endswith('Z'):
                date_str = date_str[:-1] + '+00:00'
            dt = datetime.strptime(date_str, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            continue
    
    try:
        from dateutil import parser
        dt = parser.parse(date_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except:
        pass
    
    return None

def main():
    # 读取抓取结果
    with open('/Users/admin/.openclaw/workspace/blog-fetch-result.json', 'r', encoding='utf-8') as f:
        fetch_result = json.load(f)
    
    # 读取状态
    with open('/Users/admin/.openclaw/workspace/state/blog-last-check.json', 'r', encoding='utf-8') as f:
        state = json.load(f)
    
    # 读取配置
    with open('/Users/admin/.openclaw/workspace/config/blog-sources.json', 'r', encoding='utf-8') as f:
        config = json.load(f)
    
    # 创建博客名称到状态的映射
    blog_status = {}
    for blog in config['blogs']:
        blog_name = blog['name']
        source_key = blog_name.lower().replace(' ', '-').replace('_', '-')
        blog_status[blog_name] = {
            'last_post_date_str': state['sources'].get(source_key, {}).get('last_post_date', '1970-01-01T00:00:00Z'),
            'source_key': source_key
        }
    
    # 过滤真正的新增文章
    truly_new = []
    filtered_out = []
    
    for article in fetch_result['new_articles']:
        source_name = article['source']
        pub_date_str = article['pubDate']
        
        pub_date = parse_date(pub_date_str)
        last_post_date_str = blog_status.get(source_name, {}).get('last_post_date_str', '1970-01-01T00:00:00Z')
        last_post_date = parse_date(last_post_date_str)
        
        if pub_date is None:
            print(f"警告: 无法解析文章日期 - {article['title']}")
            continue
        
        if last_post_date is None:
            print(f"警告: 无法解析 last_post_date - {source_name}: {last_post_date_str}")
            continue
        
        # 严格大于比较
        is_new = pub_date > last_post_date
        
        if is_new:
            truly_new.append(article)
        else:
            filtered_out.append({
                'title': article['title'],
                'source': source_name,
                'pubDate': pub_date_str,
                'last_post_date': last_post_date_str,
                'pub_date': pub_date.isoformat() if pub_date else None,
                'last_date': last_post_date.isoformat() if last_post_date else None
            })
    
    # 按日期排序
    truly_new.sort(key=lambda x: x['pubDate'], reverse=True)
    
    # 输出统计
    print("="*60)
    print("过滤统计:")
    print(f"  抓取到的文章总数: {len(fetch_result['new_articles'])}")
    print(f"  真正新增的文章: {len(truly_new)}")
    print(f"  被过滤掉的历史文章: {len(filtered_out)}")
    
    # 输出被过滤掉的文章示例(前10篇)
    if filtered_out:
        print(f"\n被过滤掉的历史文章示例(前10篇):")
        for i, article in enumerate(filtered_out[:10], 1):
            print(f"  {i}. {article['title']}")
            print(f"     来源: {article['source']}")
            print(f"     发布日期: {article['pub_date']}")
            print(f"     上次检查: {article['last_date']}")
            print(f"     差值: {(parse_date(article['pubDate']) - parse_date(article['last_post_date'])).days} 天")
    
    # 输出真正的新增文章
    if truly_new:
        print(f"\n真正的新增文章({len(truly_new)}篇):")
        for i, article in enumerate(truly_new, 1):
            pub_date = parse_date(article['pubDate'])
            print(f"  {i}. {article['title']}")
            print(f"     来源: {article['source']}")
            print(f"     日期: {pub_date.strftime('%Y-%m-%d %H:%M') if pub_date else 'N/A'}")
            print(f"     链接: {article['link']}")
    else:
        print("\n无真正新增文章")
    
    # 保存结果
    result = {
        'truly_new_articles': truly_new,
        'filtered_count': len(filtered_out),
        'total_fetched': len(fetch_result['new_articles']),
        'truly_new_count': len(truly_new)
    }
    
    with open('/Users/admin/.openclaw/workspace/truly-new-articles.json', 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    
    print(f"\n结果已保存到: /Users/admin/.openclaw/workspace/truly-new-articles.json")

if __name__ == '__main__':
    main()
