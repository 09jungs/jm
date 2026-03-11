// NGA 帖子监控脚本
// 监控楼主阿狼- 的发言，推送到 GitHub
// 支持登录态和公开抓取两种模式

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CONFIG = {
  ngaUrl: 'https://ngabbs.com/read.php?tid=45974302&authorid=150058&opt=262144', // 只看楼主
  targetUid: '150058', // 阿狼-
  targetName: '阿狼-',
  githubRepo: '09jungs/jm',
  githubToken: process.env.GH_TOKEN || '',
  mdFile: 'data/louzhu-posts.md',
  cookieFile: 'data/cookies.json',
  stateFile: 'data/louzhu-state.json' // 保存阿狼最后发帖页码
};

// 每天每5分钟执行一次，无需时间检查

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
    
    // 读取上次记录的页码
    let lastCheckedPage = 1;
    const statePath = path.join(__dirname, CONFIG.stateFile);
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      lastCheckedPage = state.lastPage || 1;
      console.log(`上次检查到第 ${lastCheckedPage} 页`);
    }
    
    // 从上次页码开始抓取
    const startPage = Math.max(1, lastCheckedPage);
    
    let foundNewPost = false;
    let maxPageWithTarget = 0;
    
    for (let pageNum = startPage; pageNum <= totalPages; pageNum++) {
      console.log(`抓取第 ${pageNum} 页...`);
      const baseUrl = CONFIG.ngaUrl.split('&page=')[0];
      const url = pageNum === 1 ? CONFIG.ngaUrl : `${baseUrl}&page=${pageNum}`;
      
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 30000 });
        
        // 等待帖子内容加载
        await page.waitForSelector('tbody tr', { timeout: 15000 }).catch(() => {});
        // 额外等待确保动态内容加载完成
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
              let content = row.textContent || '';
              // 尝试去掉用户信息部分
              content = content.replace(/UID:\d+.*?级别:.*?注册:/s, '');
              
              // 过滤楼中楼 - 只过滤"别人回复楼主的帖子"（楼中楼）
              // +R by [ - 阿狼-] 表示别人引用了楼主的帖子，这是楼中楼，应该跳过
              // +R by [其他用户] 表示楼主回复别人，应该保留
              const isLouzhonglou = content.includes('+R by') && content.match(/\+R by\s*\[.*?\b阿狼.*?\]/);
              if (isLouzhonglou) {
                continue; // 跳过楼中楼（别人回复楼主的帖子）
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
          if (pageNum > maxPageWithTarget) {
            maxPageWithTarget = pageNum;
          }
        }
        
      } catch (pageErr) {
        console.log(`  页面加载失败: ${pageErr.message}`);
      }
    }
    
    // 保存最新的页码
    if (maxPageWithTarget > 0) {
      fs.writeFileSync(statePath, JSON.stringify({ lastPage: maxPageWithTarget }, null, 2));
      console.log(`已更新检查页码到 ${maxPageWithTarget}`);
    }
    
    return posts;
  } finally {
    await browser.close();
  }
}

function saveToGitHub(posts, isFirstRun = false) {
  const mdPath = path.join(__dirname, CONFIG.mdFile);
  
  // 从 MD 文件解析已有帖子
  let existingPosts = [];
  if (fs.existsSync(mdPath)) {
    const mdContent = fs.readFileSync(mdPath, 'utf-8');
    const lines = mdContent.split('\n');
    for (const line of lines) {
      const match = line.match(/^-\s*([^|]+)\|\s*(.+)$/);
      if (match) {
        existingPosts.push({
          username: match[1].trim(),
          content: match[2].trim(),
          floor: ''
        });
      }
    }
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
  
  // 保存 MD 格式: 昵称 | 楼层 时间 内容
  const mdLines = uniquePosts.slice(0, 100).map(p => {
    let content = p.content
      .replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*/, '')
      .replace(/^\d{2}:\d{2}\s*/, '')
      .replace(/#\d+/g, '')  // 去掉楼层号
      .replace(/\d{2}-\d{2}财富:\s*\d+/g, '')  // 去掉财富信息
      .replace(/\|/g, '\\|')
      .replace(/\n/g, ' ')
      .trim();
    const floor = p.floor ? `#${p.floor}` : '';
    return `- ${p.username} | ${floor} ${p.time} ${content}`;
  });
  
  const header = '# 楼主发言记录\n\n最后更新: ' + new Date().toLocaleString() + '\n\n';
  fs.writeFileSync(mdPath, header + mdLines.join('\n') + '\n');
  
  try {
    if (!fs.existsSync(path.join(__dirname, '.git'))) {
      execSync(`git init`, { cwd: __dirname });
      execSync(`git remote add origin https://${CONFIG.githubToken}@github.com/${CONFIG.githubRepo}.git`, { cwd: __dirname });
    }
    
    execSync('git config user.email "bot@jm.local"', { cwd: __dirname });
    execSync('git config user.name "JM Bot"', { cwd: __dirname });
    execSync(`git add ${mdPath}`, { cwd: __dirname });
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
  console.log('='.repeat(50));
  console.log('开始抓取 NGA 帖子...');
  console.log(`目标: ${CONFIG.targetName} (uid=${CONFIG.targetUid})`);
  console.log('='.repeat(50));
  
  const posts = await fetchPosts(true);
  console.log(`共抓取 ${posts.length} 条帖子`);
  
  const mdPath = path.join(__dirname, CONFIG.mdFile);
  const isFirstRun = !fs.existsSync(mdPath);
  
  if (posts.length > 0) {
    saveToGitHub(posts, isFirstRun);
  }
}

main().catch(console.error);
