// NGA 帖子监控脚本
// 监控楼主阿狼- 的发言，推送到 GitHub
// 支持登录态和公开抓取两种模式

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CONFIG = {
  ngaUrl: 'https://ngabbs.com/read.php?tid=45974302',
  targetUid: '150058', // 阿狼-
  targetName: '阿狼-',
  githubRepo: '09jungs/jm',
  githubToken: process.env.GH_TOKEN || '',
  dataFile: 'data/louzhu-posts.json',
  cookieFile: 'data/cookies.json'
};

function isAllowedTime() {
  const now = new Date();
  const day = now.getDay();
  const hour = now.getHours();
  
  if (day < 1 || day > 5) return false;
  if (hour >= 9 && hour < 12) return true;
  if (hour >= 13 && hour < 15) return true;
  return false;
}

async function fetchPosts(useLogin = true) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  
  if (useLogin) {
    const cookiePath = path.join(__dirname, CONFIG.cookieFile);
    if (fs.existsSync(cookiePath)) {
      try {
        const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));
        await context.addCookies(cookies);
        console.log('已加载登录态');
      } catch (e) {
        console.log('登录态加载失败，使用公开模式');
      }
    }
  }
  
  const page = await context.newPage();
  const posts = [];
  
  try {
    await page.goto(CONFIG.ngaUrl, { waitUntil: 'networkidle', timeout: 30000 });
    
    const pageContent = await page.content();
    if (pageContent.includes('请登录') || pageContent.includes('登录后')) {
      console.log('检测到需要登录，尝试使用公开模式...');
      await browser.close();
      return fetchPosts(false);
    }
    
    let totalPages = 1;
    const pageLinks = await page.$$('a[href*="&page="]');
    for (const link of pageLinks) {
      const href = await link.getAttribute('href');
      const match = href.match(/page=(\d+)/);
      if (match) {
        totalPages = Math.max(totalPages, parseInt(match[1]));
      }
    }
    console.log(`共 ${totalPages} 页`);
    
    const startPage = Math.max(1, totalPages - 9);
    
    for (let pageNum = startPage; pageNum <= totalPages; pageNum++) {
      console.log(`抓取第 ${pageNum} 页...`);
      const url = pageNum === 1 ? CONFIG.ngaUrl : `${CONFIG.ngaUrl}&page=${pageNum}`;
      
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);
        
        // 使用 evaluate 精确提取
        const pagePosts = await page.evaluate((targetUid) => {
          const rows = document.querySelectorAll('tbody tr');
          const results = [];
          
          for (const row of rows) {
            try {
              const rowHTML = row.innerHTML || '';
              // 只处理目标用户的行
              if (!rowHTML.includes(`uid=${targetUid}`)) continue;
              
              // 获取正文 - 用整个行的文本然后过滤用户信息
              let content = '';
              const lastTd = row.querySelector('td:last-child');
              if (lastTd) {
                content = lastTd.textContent || '';
              }
              if (!content || content.length < 5) {
                content = row.textContent || '';
                // 尝试去掉用户信息部分
                content = content.replace(/UID:\d+.*?级别:.*?注册:/s, '');
              }
              
              // 过滤回复/引用帖子 - 如果内容包含 Reply to 或 +R by，说明是别人回复他
              const isReply = content.includes('Reply to') || content.includes('+R by');
              if (isReply) {
                continue; // 跳过回复帖子
              }
              
              // 获取用户名 - 优先找昵称格式 [xxx]，其次找 UID
              const links = row.querySelectorAll('a[href*="uid="]');
              let username = '';
              for (const link of links) {
                const text = link.textContent.trim();
                // 优先找昵称格式 [xxx]
                if (text.includes('[') && text.includes(']')) {
                  username = text.replace(/[\[\]]/g, '');
                  break;
                }
                // 如果没有昵称，用 UID
                if (!username && text.startsWith('UID:')) {
                  username = text;
                }
              }
              if (!username) username = `UID:${targetUid}`;
              
              // 获取楼层号
              const floorLink = row.querySelector('a[href*="#pid"]');
              const floorHref = floorLink?.getAttribute('href') || '';
              const floor = floorHref.match(/#pid(\d+)/)?.[1] || 'unknown';
              
              // 获取时间
              const timeMatch = content.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
              const time = timeMatch ? timeMatch[1] : '';
              
              // 清理内容
              const cleanContent = content
                .replace(/支持\s*\d+\s*反对/g, '')
                .replace(/收藏\s*分享菜单\s*操作菜单/g, '')
                .replace(/发送自.*NGA官方客户端/g, '')
                .replace(/发送自\s*\/+/g, '')
                .replace(/支持\s*\d+/g, '')
                .replace(/反对/g, '')
                .replace(/收藏/g, '')
                .replace(/操作菜单/g, '')
                .replace(/^\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*/, '')
                .replace(/\s+/g, ' ')
                .trim();
              
              if (cleanContent && cleanContent.length > 10) {
                results.push({
                  floor,
                  uid: targetUid,
                  username,
                  time,
                  content: cleanContent.substring(0, 5000)
                });
              }
            } catch (e) {
              // 跳过
            }
          }
          
          return results;
        }, CONFIG.targetUid);
        
        for (const p of pagePosts) {
          console.log(`  找到: ${p.username}, 楼层: ${p.floor}`);
          posts.push(p);
        }
        
      } catch (pageErr) {
        console.log(`  页面加载失败: ${pageErr.message}`);
      }
    }
    
    return posts;
  } finally {
    await browser.close();
  }
}

function saveToGitHub(posts, isFirstRun = false) {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  const dataPath = path.join(dataDir, CONFIG.dataFile);
  
  let existingPosts = [];
  if (fs.existsSync(dataPath)) {
    existingPosts = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  }
  
  const existingFloors = new Set(existingPosts.map(p => p.floor));
  const newPosts = posts.filter(p => !existingFloors.has(p.floor));
  
  if (newPosts.length === 0 && !isFirstRun) {
    console.log('没有新帖子');
    return false;
  }
  
  if (isFirstRun) {
    console.log(`初始化: 保存 ${posts.length} 条历史帖子`);
  } else {
    console.log(`发现 ${newPosts.length} 条新帖子`);
  }
  
  const allPosts = [...posts, ...existingPosts];
  const uniquePosts = [];
  const seenFloors = new Set();
  for (const p of allPosts) {
    if (!seenFloors.has(p.floor)) {
      seenFloors.add(p.floor);
      uniquePosts.push(p);
    }
  }
  
  fs.writeFileSync(dataPath, JSON.stringify(uniquePosts.slice(0, 100), null, 2));
  
  try {
    if (!fs.existsSync(path.join(__dirname, '.git'))) {
      execSync(`git init`, { cwd: __dirname });
      execSync(`git remote add origin https://${CONFIG.githubToken}@github.com/${CONFIG.githubRepo}.git`, { cwd: __dirname });
    }
    
    execSync('git config user.email "bot@jm.local"', { cwd: __dirname });
    execSync('git config user.name "JM Bot"', { cwd: __dirname });
    execSync(`git add ${dataPath}`, { cwd: __dirname });
    execSync(`git commit -m "${isFirstRun ? '初始化' : '更新'}: ${newPosts.length} 条帖子"`, { cwd: __dirname });
    
    try {
      execSync(`git push -f https://${CONFIG.githubToken}@github.com/${CONFIG.githubRepo}.git main`, { cwd: __dirname });
      console.log('已推送到 GitHub');
    } catch (pushErr) {
      console.log('push 失败');
    }
  } catch (e) {
    console.error('Git 操作失败:', e.message);
  }
  
  return true;
}

async function main() {
  if (!isAllowedTime()) {
    const now = new Date();
    console.log(`[${now.toLocaleString()}] 不在执行时间范围内，跳过`);
    return;
  }
  
  console.log('='.repeat(50));
  console.log('开始抓取 NGA 帖子...');
  console.log(`目标: ${CONFIG.targetName} (uid=${CONFIG.targetUid})`);
  console.log('='.repeat(50));
  
  const posts = await fetchPosts(true);
  console.log(`共抓取 ${posts.length} 条帖子`);
  
  const dataPath = path.join(__dirname, 'data', 'louzhu-posts.json');
  const isFirstRun = !fs.existsSync(dataPath);
  
  if (posts.length > 0) {
    saveToGitHub(posts, isFirstRun);
  }
}

main().catch(console.error);
