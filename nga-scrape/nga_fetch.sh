#!/bin/bash
# NGA帖子抓取脚本 - 每6分钟执行一次
# 使用 openclaw browser 工具抓取最新两页

BROWSER_ID="nga_scrape_$$"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MD_FILE="${SCRIPT_DIR}/nga-post-45974302-latest10.md"
TID="45974302"

# 清理函数
cleanup() {
    openclaw browser close --id "$BROWSER_ID" 2>/dev/null
}

trap cleanup EXIT

# 获取当前最高页码
openclaw browser open --id "$BROWSER_ID" "https://bbs.nga.cn/read.php?tid=${TID}"
sleep 5

# 快照获取页码信息
SNAPSHOT=$(openclaw browser snapshot --id "$BROWSER_ID" --limit 200 2>/dev/null)

# 提取最高页码（简单处理：找最后一页数字）
PAGE_NUM=$(echo "$SNAPSHOT" | grep -oE 'page=[0-9]+' | tail -1 | grep -oE '[0-9]+')
if [ -z "$PAGE_NUM" ]; then
    PAGE_NUM=5167  # 默认 fallback
fi

echo "当前最高页码: $PAGE_NUM"

# 抓取最新页
openclaw browser open --id "$BROWSER_ID" "https://bbs.nga.cn/read.php?tid=${TID}&page=${PAGE_NUM}"
sleep 4
openclaw browser snapshot --id "$BROWSER_ID" --limit 400 > /tmp/nga_snap_p1.txt

# 抓取前一页
PAGE_PREV=$((PAGE_NUM - 1))
openclaw browser open --id "$BROWSER_ID" "https://bbs.nga.cn/read.php?tid=${TID}&page=${PAGE_PREV}"
sleep 4
openclaw browser snapshot --id "$BROWSER_ID" --limit 400 > /tmp/nga_snap_p2.txt

# 关闭浏览器
openclaw browser close --id "$BROWSER_ID"

# 解析并生成md（目前 cron 使用 agent 直接解析，此处略过）
echo "快照已保存到 /tmp/nga_snap_p*.txt，请使用 agent 解析"