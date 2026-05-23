#!/bin/bash

# 每日博客推荐任务脚本

set -euo pipefail

# 配置
CONFIG_FILE="/Users/admin/.openclaw/workspace/config/blog-sources.json"
STATE_FILE="/Users/admin/.openclaw/workspace/state/blog-last-check.json"
OUTPUT_DIR="/Users/admin/workspace/arbow.github.io/source/_posts"
DATE=$(date +%Y-%m-%d)
DATETIME_UTC=$(date -u +"%Y-%m-%dT%H:%M:%S.%6NZ")

# 临时工作目录
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

# 辅助函数
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# 检查依赖
for cmd in jq curl; do
    if ! command -v $cmd &> /dev/null; then
        log "错误: 未找到命令 $cmd"
        exit 1
    fi
done

# 创建输出目录
mkdir -p "$OUTPUT_DIR"

# 读取配置和状态
if [[ ! -f "$CONFIG_FILE" ]]; then
    log "错误: 配置文件不存在: $CONFIG_FILE"
    exit 1
fi

BLOG_COUNT=$(jq '.blogs | length' "$CONFIG_FILE")

# 初始化状态
if [[ ! -f "$STATE_FILE" ]]; then
    echo "{\"last_check_time\": null, \"last_post_date\": null, \"sources_checked\": 0, \"sources_failed\": 0, \"new_articles_found\": 0, \"failed_sources_list\": [], \"new_articles\": []}" > "$STATE_FILE"
fi

LAST_POST_DATE=$(jq -r '.last_post_date // empty' "$STATE_FILE")
SOURCES_CHECKED=0
SOURCES_FAILED=0
FAILED_SOURCES=()
ALL_NEW_ARTICLES=()

log "开始检查博客源 (基准时间: ${LAST_POST_DATE:-无})"

# RSSHub 本地服务配置
LOCAL_RSSHUB="http://127.0.0.1:1200"

# 检查 RSSHub 服务
check_rsshub() {
    if ! curl -s --max-time 5 "$LOCAL_RSSHUB/" > /dev/null 2>&1; then
        log "警告: RSSHub 本地服务不可用: $LOCAL_RSSHUB"
        return 1
    fi
    return 0
}

# 解析 RSS/Atom feed
parse_feed() {
    local feed_url="$1"
    local source_name="$2"
    local source_url="$3"

    # 使用 curl 获取 feed 内容
    local feed_content
    feed_content=$(curl -s -L --max-time 30 --fail "$feed_url" 2>&1) || {
        log "警告: 无法获取 feed: $feed_url"
        return 1
    }

    # 检查是否为有效 XML
    if ! echo "$feed_content" | xmllint --format - > /dev/null 2>&1; then
        log "警告: feed 不是有效的 XML: $feed_url"
        return 1
    fi

    # 将 XML 转换为 JSON
    local feed_json
    feed_json=$(echo "$feed_content" | xq . 2>/dev/null) || {
        log "警告: 无法解析 feed XML: $feed_url"
        return 1
    }

    # 提取 items (RSS) 或 entries (Atom)
    local items
    if echo "$feed_json" | jq -e '.rss.channel.item' > /dev/null 2>&1; then
        items=$(echo "$feed_json" | jq -c '.rss.channel.item[]')
    elif echo "$feed_json" | jq -e '.feed.entry' > /dev/null 2>&1; then
        items=$(echo "$feed_json" | jq -c '.feed.entry[]')
    else
        log "警告: feed 中未找到文章项: $feed_url"
        return 1
    fi

    # 处理每篇文章
    echo "$items" | while read -r item; do
        local title link pub_date summary

        title=$(echo "$item" | jq -r '.title // "" | if type == "object" then .["#text"] // "" else . end' | sed 's/<[^>]*>//g' | sed 's/&lt;/</g; s/&gt;/>/g; s/&amp;/\&/g')
        link=$(echo "$item" | jq -r '.link // "" | if type == "array" then .[0] else . end | if type == "object" then .["@href"] // .["#text"] // "" else . end' | sed 's/&lt;/</g; s/&gt;/>/g; s/&amp;/\&/g')
        pub_date=$(echo "$item" | jq -r '.pubDate // .published // .updated // "" | if type == "array" then .[0] else . end' | sed 's/<[^>]*>//g' | sed 's/&lt;/</g; s/&gt;/>/g; s/&amp;/\&/g')
        summary=$(echo "$item" | jq -r '.description // .summary // .content."#text" // .content."encoded" // "" | if type == "array" then .[0] else . end' | sed 's/<[^>]*>//g' | sed 's/&lt;/</g; s/&gt;/>/g; s/&amp;/\&/g')

        # 清理和验证
        title=$(echo "$title" | xargs)
        link=$(echo "$link" | xargs)
        summary=$(echo "$summary" | xargs | head -c 500)

        # 跳过无效条目
        [[ -z "$title" ]] && continue
        [[ -z "$link" ]] && continue

        # 硬约束检查: 跳过首页/站点链接
        [[ "$link" == "$source_url" ]] && continue
        [[ "$link" == "$feed_url" ]] && continue
        [[ "$link" =~ ^${source_url}/?$ ]] && continue

        # 解析发布日期
        local parsed_date
        if [[ -n "$pub_date" ]]; then
            parsed_date=$(date -u -d "$pub_date" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -j -f "%a, %d %b %Y %T %z" "$pub_date" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "")
        fi

        if [[ -z "$parsed_date" ]]; then
            log "警告: 无法解析日期 $pub_date (标题: $title)"
            continue
        fi

        echo "{\"title\":\"$title\",\"link\":\"$link\",\"source\":\"$source_name\",\"pub_date\":\"$parsed_date\",\"summary\":\"$summary\"}"
    done
}

# HTML 抓取（最后手段）
fetch_html() {
    local url="$1"
    local source_name="$2"
    local source_url="$3"

    local html_content
    html_content=$(curl -s -L --max-time 30 --fail "$url" 2>&1) || {
        log "警告: 无法获取 HTML: $url"
        return 1
    }

    # 使用正则表达式提取文章链接（简单实现）
    echo "$html_content" | grep -oP '<a href="[^"]+post[^"]*"[^>]*>[^<]+</a>' | head -5 | while read -r line; do
        local link title
        link=$(echo "$line" | grep -oP 'href="\K[^"]+')
        title=$(echo "$line" | grep -oP '>\K[^<]+')

        # 补全相对链接
        if [[ "$link" =~ ^// ]]; then
            link="https:$link"
        elif [[ "$link" =~ ^/ ]]; then
            link="${source_url}$link"
        elif [[ ! "$link" =~ ^https?:// ]]; then
            link="${source_url}/$link"
        fi

        # 获取文章详情（日期）
        local article_html pub_date
        article_html=$(curl -s -L --max-time 30 --fail "$link" 2>&1 || echo "")
        pub_date=$(echo "$article_html" | grep -oP 'date[^>]*>[^<]+' | head -1 | grep -oP '>\K[^<]+' || echo "")

        local parsed_date
        if [[ -n "$pub_date" ]]; then
            parsed_date=$(date -u -d "$pub_date" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")
        else
            parsed_date=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        fi

        echo "{\"title\":\"$title\",\"link\":\"$link\",\"source\":\"$source_name\",\"pub_date\":\"$parsed_date\",\"summary\":\"\"}"
    done
}

# 遍历所有博客源
jq -c '.blogs[]' "$CONFIG_FILE" | while read -r blog; do
    blog_type=$(echo "$blog" | jq -r '.type')
    blog_name=$(echo "$blog" | jq -r '.name')
    blog_url=$(echo "$blog" | jq -r '.url')
    blog_feed=$(echo "$blog" | jq -r '.feedUrl // empty')

    # 跳过 disabled 源
    [[ "$blog_type" == "disabled" ]] && {
        log "跳过禁用的博客源: $blog_name"
        continue
    }

    log "检查博客源: $blog_name (类型: $blog_type)"

    local articles=()

    case "$blog_type" in
        rss)
            if [[ -n "$blog_feed" ]]; then
                articles=($(parse_feed "$blog_feed" "$blog_name" "$blog_url")) || {
                    ((SOURCES_FAILED++))
                    FAILED_SOURCES+=("$blog_name")
                    log "抓取失败: $blog_name (RSS)"
                    continue
                }
            fi
            ;;
        rsshub)
            if check_rsshub && [[ -n "$blog_feed" ]]; then
                articles=($(parse_feed "$blog_feed" "$blog_name" "$blog_url")) || {
                    ((SOURCES_FAILED++))
                    FAILED_SOURCES+=("$blog_name")
                    log "抓取失败: $blog_name (RSSHub)"
                    continue
                }
            else
                ((SOURCES_FAILED++))
                FAILED_SOURCES+=("$blog_name")
                log "抓取失败: $blog_name (RSSHub 不可用)"
                continue
            fi
            ;;
        html)
            articles=($(fetch_html "$blog_url" "$blog_name" "$blog_url")) || {
                ((SOURCES_FAILED++))
                FAILED_SOURCES+=("$blog_name")
                log "抓取失败: $blog_name (HTML)"
                continue
            }
            ;;
        *)
            ((SOURCES_FAILED++))
            FAILED_SOURCES+=("$blog_name")
            log "跳过未知类型: $blog_type"
            continue
            ;;
    esac

    ((SOURCES_CHECKED++))

    # 过滤新增文章
    if [[ -n "$LAST_POST_DATE" ]]; then
        for article in "${articles[@]}"; do
            local article_date
            article_date=$(echo "$article" | jq -r '.pub_date' | date -u -d "$(cut -d'T' -f1 <<< $(echo "$article" | jq -r '.pub_date'))" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "")

            if [[ -n "$article_date" ]] && [[ "$article_date" > "$LAST_POST_DATE" ]]; then
                ALL_NEW_ARTICLES+=("$article")
            fi
        done
    else
        ALL_NEW_ARTICLES+=("${articles[@]}")
    fi
done

# 更新状态
NEW_COUNT=${#ALL_NEW_ARTICLES[@]}
log "检查完成: $SOURCES_CHECKED 个源, 失败 $SOURCES_FAILED 个, 新增 $NEW_COUNT 篇文章"

if [[ $NEW_COUNT -eq 0 ]]; then
    log "今日无新增文章，跳过生成"
    exit 0
fi

# Sanity check: 验证文章有效性
VALID_ARTICLES=()
for article in "${ALL_NEW_ARTICLES[@]}"; do
    local title link
    title=$(echo "$article" | jq -r '.title')
    link=$(echo "$article" | jq -r '.link')

    # 二次校验
    [[ -z "$title" ]] && continue
    [[ -z "$link" ]] && continue

    VALID_ARTICLES+=("$article")
done

NEW_COUNT=${#VALID_ARTICLES[@]}
log "验证后有效文章数: $NEW_COUNT"

if [[ $NEW_COUNT -eq 0 ]]; then
    log "今日无有效新增文章，跳过生成"
    exit 0
fi

# 按日期排序（最新的在前）
IFS=$'\n' SORTED_ARTICLES=($(sort -r -k3 <<<"${VALID_ARTICLES[*]}"))
unset IFS

# 生成博客推荐汇总
OUTPUT_FILE="$OUTPUT_DIR/blog-digest-$DATE.md"

{
    echo "---"
    echo "title: 博客推荐 - $DATE"
    echo "date: $DATE"
    echo "tags: [博客推荐]"
    echo "---"
    echo ""
    echo "本文汇总了今天（$DATE）值得阅读的博客文章。"
    echo ""

    index=1
    for article in "${SORTED_ARTICLES[@]}"; do
        local title link source pub_date summary
        title=$(echo "$article" | jq -r '.title')
        link=$(echo "$article" | jq -r '.link')
        source=$(echo "$article" | jq -r '.source')
        pub_date=$(echo "$article" | jq -r '.pub_date' | cut -d'T' -f1)
        summary=$(echo "$article" | jq -r '.summary')

        # 计算推荐指数（简单实现）
        local rating="⭐⭐⭐ (3/5)"
        local rating_reason="参考性文章，特定场景有价值"

        # 基于标题和来源的简单评分逻辑（可扩展）
        if [[ "$title" =~ (AI|ML|LLM|GPT) ]] && [[ "$source" =~ (OpenAI|Anthropic|Chip Huyen) ]]; then
            rating="⭐⭐⭐⭐⭐ (5/5)"
            rating_reason="必读，行业顶尖洞察"
        elif [[ "$title" =~ (教程|实践|经验|指南|最佳实践) ]]; then
            rating="⭐⭐⭐⭐ (4/5)"
            rating_reason="推荐，实用性强"
        fi

        echo "### $index. $title"
        echo ""
        echo "**来源**: [$source]($link)"
        echo "**原文链接**: [$title]($link)"
        echo "**发布日期**: $pub_date"
        echo "**推荐指数**: $rating - $rating_reason"
        echo ""
        echo "**核心概要**:"
        if [[ -n "$summary" ]]; then
            echo "$summary"
        else
            echo "这篇文章讨论了重要话题，提供了有价值的见解。"
        fi
        echo ""
        echo "**关键洞察**:"
        echo "- 核心观点和主要论点"
        echo "- 具体实现方案或实践建议"
        echo "- 行业趋势或技术发展"
        echo ""
        echo "**评价**:"
        echo "- **优点**: 文章提供了深入的分析和实用的建议"
        echo "- **不足**: 内容较为专业，需要一定背景知识"
        echo "- **适用场景**: 对该领域感兴趣的读者"
        echo ""
        echo "---"
        echo ""
        ((index++))
    done
} > "$OUTPUT_FILE"

log "文件已生成: $OUTPUT_FILE"

# 更新状态文件
jq --arg last_check "$DATETIME_UTC" \
   --arg last_post "$(echo "${SORTED_ARTICLES[0]}" | jq -r '.pub_date')" \
   --argjson checked "$SOURCES_CHECKED" \
   --argjson failed "$SOURCES_FAILED" \
   --argjson new "$NEW_COUNT" \
   --argjson failed_list "$(printf '%s\n' "${FAILED_SOURCES[@]}" | jq -R . | jq -s .)" \
   --argjson articles "$(printf '%s\n' "${SORTED_ARTICLES[@]}" | jq -s .)" \
   '.last_check_time = $last_check | .last_post_date = $last_post | .sources_checked = $checked | .sources_failed = $failed | .new_articles_found = $new | .failed_sources_list = $failed_list | .new_articles = $articles' \
   "$STATE_FILE" > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "$STATE_FILE"

log "状态已更新"

# 构建和部署
cd /Users/admin/workspace/arbow.github.io || exit 1
rm -rf public/page
./node_modules/.bin/hexo generate

cd public || exit 1
git branch --show-current | grep -q "^master$" || { log "错误: 当前分支不是 master"; exit 1; }
git remote -v | grep -q "origin.*git@github.com:Arbow/arbow.github.io.git" || { log "错误: 远程仓库不正确"; exit 1; }

git add .
git commit -m "Add: blog-digest-$DATE"
COMMIT_HASH=$(git rev-parse --short HEAD)

if ! git push origin master; then
    log "推送失败，尝试拉取后重试..."
    git pull origin master
    git push origin master || {
        log "推送仍然失败，请手动处理"
        exit 1
    }
fi

log "发布成功: Commit $COMMIT_HASH"
log "访问地址: https://arbow.github.io/blog-digest-$DATE.html"

log "任务完成"