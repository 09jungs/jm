#!/usr/bin/env python3
"""每2分钟抓取NGA帖子最新回复，推送到 GitHub fsyb 仓库"""

import json, re, time, urllib.request, base64, subprocess
from typing import Optional

TID = "45974302"
REPO = "09jungs/fsyb"
BRANCH = "main"

COOKIE = "ngacn0comUserInfo=%25D3%25EA%25E0%25AA%25E0%25AA%25B5%25D8%25B4%25F2%09%25E9%259B%25A8%25E5%2597%2592%25E5%2597%2592%25E5%259C%25B0%25E6%2589%2593%0939%0939%09%0910%09100%094%090%090%0961_6%2C226_15; ngacn0comUserInfoCheck=a5863ef391bc67f9d94270da5bac7936; ngacn0comInfoCheckTime=1778762139; ngaPassportUid=60069198; ngaPassportUrlencodedUname=%25D3%25EA%25E0%25AA%25E0%25AA%25B5%25D8%25B4%25F2; ngaPassportCid=X8mn4q2coj509592b195bej6c7ctumf6e1ff5l5o; Hm_lvt_01c4614f24e14020e036f4c3597aa059=1778762176; HMACCOUNT=99019471F769AD20; lastpath=/read.php?tid=45974302&page=5522; lastvisit=1779294271; bbsmisccookies=%7B%22uisetting%22%3A%7B0%3A%22c%22%2C1%3A1779294571%7D%2C%22pv_count_for_insad%22%3A%7B0%3A-46%2C1%3A1779382903%7D%2C%22insad_views%22%3A%7B0%3A1%2C1%3A1779382903%7D%7D; Hm_lpvt_01c4614f24e14020e036f4c3597aa059=1779294272"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Cookie": COOKIE,
    "Accept": "application/json,text/plain,*/*",
    "Referer": "https://bbs.nga.cn/read.php?tid=45974302",
}


def clean_text(text):
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)


def fetch_page(page, json_mode=True):
    url = f"https://bbs.nga.cn/read.php?tid={TID}&page={page}"
    if json_mode:
        url += "&__output=8"
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read()
    charset = resp.headers.get_content_charset() or "gb18030"
    return raw.decode(charset, errors="replace")


def parse_posts(text):
    try:
        cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
        data = json.loads(cleaned, strict=False)
    except json.JSONDecodeError as e:
        print(f"  JSON parse error: {e}")
        return []
    replies = data.get("data", {}).get("__R", {})
    users = data.get("data", {}).get("__U", {})
    posts = []
    if isinstance(replies, dict):
        for k, v in reversed(list(replies.items())):
            uid = str(v.get("authorid", ""))
            user = users.get(uid, {})
            uname = user.get("username", v.get("author", ""))
            content = re.sub(r"<[^>]+>", "", str(v.get("content", "")))
            content = re.sub(r"\[img[^\]]*\].*?\[/img\]", "", content, flags=re.S).strip()
            pid = v.get("pid", k)
            post_time = v.get("postdate", "")
            posts.append({"pid": pid, "uid": uid, "user": uname, "content": content, "time": post_time})
    return posts


def get_total_pages_from_html():
    """从 HTML 页面解析总页数（通过页面链接中的最大页码）"""
    for candidate in [999999, 888888, 777777]:
        text = fetch_page(candidate, json_mode=False)
        # 检测 NGA 错误页面（cookie 过期或需要登录）
        if 'msgcodestart' in text and '2048' in text:
            print(f"  HTML 探测 page={candidate}: NGA 返回错误(2048 need login)，Cookie 可能已过期")
            return None
        pages_found = sorted(set(int(p) for p in re.findall(r'href=[^>]+page=(\d+)', text) if p.isdigit()))
        if pages_found:
            max_page = max(pages_found)
            print(f"  HTML 探测 page={candidate}: 找到最大页码 {max_page}")
            # 验证：fetch 最后一页，检查其链接中最大页是否指向自己
            # 如果最后一页返回 2048 need login（HTML 无后续页），说明 max_page 就是末页
            last_text = fetch_page(max_page, json_mode=False)
            last_pages = sorted(set(int(p) for p in re.findall(r'href=[^>]+page=(\d+)', last_text) if p.isdigit()))
            # 如果最大页不在末页链接中，或末页返回 2048，说明 max_page 就是末页
            if max_page not in last_pages or ('msgcodestart' in last_text and '2048' in last_text):
                print(f"  确认 max_page={max_page} 为末页")
                return max_page
            # 末页链接里的最大页比 max_page 大，说明还有下一页
            real_max = max(last_pages) if last_pages else max_page
            print(f"  max_page={max_page} 不在末页链接中，links={last_pages}，实际末页可能是 {real_max}")
            return real_max
    return None


def build_markdown(posts, total_pages):
    lines = [
        f"# NGA帖子 #{TID} 回复抓取",
        "",
        f"最后更新: {time.strftime('%Y/%m/%d %H:%M:%S')}",
        f"总页数: {total_pages}",
        f"本次抓取: 倒数3页 (最新 ~60条)",
        "",
        f"---",
        "",
    ]
    for i, p in enumerate(posts, 1):
        lines.append(f"**[{i}] {p['time']} | {p['user']} (uid:{p['uid']})**")
        lines.append(f"> {p['content']}")
        lines.append("")
    return "\n".join(lines)


def get_sha(path):
    result = subprocess.run(
        ["gh", "api", f"repos/{REPO}/contents/{path}", "--jq", ".sha"],
        capture_output=True, text=True
    )
    s = result.stdout.strip()
    return s if s else None


def upsert_file(path, content, sha):
    encoded = base64.b64encode(content.encode("utf-8")).decode()
    msg = f"update {path}"
    for attempt in range(3):
        sha_param = ["-f", f"sha={sha}"] if sha else ["-f", "sha="]
        cmd = [
            "gh", "api", f"repos/{REPO}/contents/{path}",
            "-X", "PUT",
            "-f", f"message={msg}",
            "-f", f"content={encoded}",
        ] + sha_param + ["-f", "branch=main"]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            return True
        # Retry: re-fetch sha if it's a conflict
        if "sha" in result.stderr.lower() or "404" not in result.stderr.lower():
            new_sha = get_sha(path)
            if new_sha and new_sha != sha:
                sha = new_sha
                continue
        print(f"  upsert failed for {path}: {result.stderr}")
        return False
    print(f"  upsert failed for {path} after 3 attempts")
    return False


def get_last_floor():
    """从 GitHub 获取上次记录的总页数"""
    result = subprocess.run(
        ["gh", "api", f"repos/{REPO}/contents/last_floor.txt", "--jq", ".content"],
        capture_output=True, text=True
    )
    content = result.stdout.strip()
    if content:
        try:
            return int(base64.b64decode(content).decode().strip())
        except Exception:
            pass
    return None


def main():
    print("开始抓取 NGA 帖子...")

    total_pages = None

    # 策略1: 从 last_floor.txt 读上次页数
    last_known = get_last_floor()

    # 策略2: HTML 模式探测总页数（NGA __output=8 JSON API 经常不返回 __PAGE）
    if not total_pages:
        print("  尝试 HTML 模式解析总页数...")
        total_pages = get_total_pages_from_html()

    # 策略3: JSON 探测（候选页码）
    if not total_pages:
        print("  JSON 探测页解析失败，尝试从尾页往前探测...")
        for candidate in [9999, 9500, 9000, 8500, 8000, 7500, 7000, 6500, 6000, 5500, 5000, 4500, 4000]:
            text = fetch_page(candidate, json_mode=True)
            try:
                data = json.loads(clean_text(text), strict=False)
                total_pages = data.get("data", {}).get("__PAGE", 0)
                if total_pages:
                    print(f"  从候选页{candidate}找到总页数: {total_pages}")
                    break
            except json.JSONDecodeError:
                continue
        else:
            print("  所有探测失败，尝试解析最后一页回复中的页数信息...")
            if last_known:
                text = fetch_page(last_known, json_mode=True)
                m = re.search(r'total_pages[^"]*"(\d+)"', text)
                if m:
                    total_pages = int(m.group(1))
            if not total_pages:
                print("无法获取总页数，退出")
                return

    pages = [total_pages, total_pages - 1, total_pages - 2]
    print(f"总页数: {total_pages}")
    all_posts = []
    errors = []
    for p in pages:
        if p < 1:
            continue
        print(f"抓取第 {p} 页 (JSON)...")
        try:
            text = fetch_page(p, json_mode=True)
            posts = parse_posts(text)
            if not posts:
                print(f"  第 {p} 页解析结果为空，可能是 JSON 截断，跳过继续")
                errors.append(p)
            else:
                all_posts.extend(posts)
        except Exception as e:
            print(f"  第 {p} 页抓取异常: {e}，跳过继续")
            errors.append(p)
        if p > min(pages):
            time.sleep(1)
    if errors:
        print(f"警告: 第 {errors} 页抓取失败（已知高页码 JSON 截断问题）")

    seen = set()
    unique = []
    for post in all_posts:
        if post["pid"] not in seen:
            seen.add(post["pid"])
            unique.append(post)

    print(f"去重后共 {len(unique)} 条")

    md = build_markdown(unique, total_pages)
    posts_data = {
        "tid": TID,
        "total_pages": total_pages,
        "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "posts": unique,
    }
    posts_json = json.dumps(posts_data, ensure_ascii=False, indent=2)

    print("推送到 GitHub...")
    for path, content in [
        ("nga_posts.md", md),
        ("posts.json", posts_json),
        ("last_floor.txt", str(total_pages)),
    ]:
        sha = get_sha(path)
        ok = upsert_file(path, content, sha)
        sha_short = ((sha or "new")[:8])
        print(f"  {'ok' if ok else 'fail'} {path} (sha: {sha_short})")

    print(f"\n完成！总页码: {total_pages}，回复数: {len(unique)}")


if __name__ == "__main__":
    main()