// NGA 帖子监控脚本 - 监控所有用户发言
// 抓取帖子最新几页的所有发言，输出为 Markdown 格式

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CONFIG = {
  ngaUrl: 'https://ngabbs.com/read.php?tid=45974302',
  githubRepo: '09jungs/jm',
  githubToken: process.env.GH_TOKEN || '',
  dataFile: 'data/all-posts.md',
  cookieFile: 'data/cookies.json',
  pagesToFetch: 20
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

async function fetchAllPosts(useLogin = true) {
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
      return fetchAllPosts(false);
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
    
    const startPage = Math.max(1, totalPages - CONFIG.pagesToFetch + 1);
    
    for (let pageNum = startPage; pageNum <= totalPages; pageNum++) {
      console.log(`抓取第 ${pageNum} 页...`);
      const url = pageNum === 1 ? CONFIG.ngaUrl : `${CONFIG.ngaUrl}&page=${pageNum}`;
      
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1500);
        
        const pagePosts = await page.evaluate(() => {
          const rows = document.querySelectorAll('tbody tr');
          const results = [];
          
          for (const row of rows) {
            try {
              const links = row.querySelectorAll('a[href*="uid="]');
              let username = '';
              let uid = '';
              
              for (let i = 0; i < links.length; i++) {
                const href = links[i].getAttribute('href');
                const text = links[i].textContent.trim();
                const uidMatch = href.match(/uid=(\d+)/);
                
                if (uidMatch) {
                  uid = uidMatch[1];
                  if (text.includes('[') && text.includes(']')) {
                    username = text.replace(/[\[\]]/g, '').trim();
                    break;
                  }
                  if (!username) {
                    username = text;
                  }
                }
              }
              
              if (!uid) continue;
              
              const floorLink = row.querySelector('a[href*="#pid"]');
              const floorHref = floorLink?.getAttribute('href') || '';
              const floor = floorHref.match(/#pid(\d+)/)?.[1] || 'unknown';
              
              const rowText = row.textContent || '';
              const timeMatch = rowText.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
              const time = timeMatch ? timeMatch[1] : '';
              
              const cells = row.querySelectorAll('td');
              let content = '';
              if (cells.length >= 2) {
                const lastCell = cells[cells.length - 1];
                content = lastCell.textContent || '';
              }
              
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
                .replace(/^\s*\d{2}:\d{2}\s*/, '')
                .replace(/\s+/g, ' ')
                .trim();
              
              if (cleanContent && cleanContent.length > 5) {
                results.push({
                  floor,
                  uid,
                  username: username || 'UID:' + uid,
                  time,
                  content: cleanContent.substring(0, 2000)
                });
              }
            } catch (e) {
              // 跳过
            }
          }
          
          return results;
        });
        
        posts.push(...pagePosts);
        
      } catch (pageErr) {
        console.log(`  页面加载失败: ${pageErr.message}`);
      }
    }
    
    console.log(`共抓取 ${posts.length} 条发言`);
    return posts;
  } finally {
    await browser.close();
  }
}

function saveToGitHub(posts) {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  const dataPath = path.join(dataDir, CONFIG.dataFile);
  
  let existingFloors = new Set();
  let existingCount = 0;
  if (fs.existsSync(dataPath)) {
    const content = fs.readFileSync(dataPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.startsWith('- '));
    existingCount = lines.length;
    for (const line of lines) {
      const match = line.match(/^#(\d+)/);
      if (match) existingFloors.add(match[1]);
    }
  }
  
  const newPosts = posts.filter(p => !existingFloors.has(p.floor));
  
  if (newPosts.length === 0) {
    console.log('没有新发言');
    return false;
  }
  
  console.log(`发现 ${newPosts.length} 条新发言 (已有 ${existingCount} 条)`);
  
  newPosts.sort((a, b) => b.time.localeCompare(a.time));
  
  const mdLines = newPosts.map(p => {
    // 去掉内容开头的时间和多余空格
    let content = p.content
      .replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*/, '')
      .replace(/^\d{2}:\d{2}\s*/, '')
      .replace(/\|/g, '\\|')
      .replace(/\n/g, ' ')
      .trim();
    return `- ${p.username} | ${content}`;
  });
  
  let existingContent = '';
  if (fs.existsSync(dataPath)) {
    existingContent = fs.readFileSync(dataPath, 'utf-8');
  }
  
  const header = '# NGA 帖子发言记录\n\n最后更新: ' + new Date().toLocaleString() + '\n\n';
  const newContent = header + mdLines.join('\n') + '\n\n' + existingContent;
  
  const allLines = newContent.split('\n');
  const keptLines = allLines.slice(0, 5005);
  
  fs.writeFileSync(dataPath, keptLines.join('\n'));
  
  const userCount = new Set(posts.map(p => p.uid)).size;
  console.log(`涉及 ${userCount} 个用户`);
  
  try {
    if (!fs.existsSync(path.join(__dirname, '.git'))) {
      execSync(`git init`, { cwd: __dirname });
      execSync(`git remote add origin https://${CONFIG.githubToken}@github.com/${CONFIG.githubRepo}.git`, { cwd: __dirname });
    }
    
    execSync('git config user.email "bot@jm.local"', { cwd: __dirname });
    execSync('git config user.name "JM Bot"', { cwd: __dirname });
    execSync(`git add ${dataPath}`, { cwd: __dirname });
    execSync(`git commit -m "更新: ${newPosts.length} 条发言"`, { cwd: __dirname });
    
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
  console.log('开始抓取 NGA 帖子所有发言...');
  console.log('='.repeat(50));
  
  const posts = await fetchAllPosts(true);
  
  if (posts.length > 0) {
    saveToGitHub(posts);
  }
}

main().catch(console.error);
