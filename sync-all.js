// NGA 帖子监控脚本 - 每次抓取最新100条
// 抓取帖子最新几页的所有发言，输出为 Markdown 格式

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CONFIG = {
  ngaUrl: 'https://ngabbs.com/read.php?tid=45974302',
  targetUid: '150058',  // 楼主UID，用于标记
  githubRepo: '09jungs/jm',
  githubToken: process.env.GH_TOKEN || '',
  dataFile: 'data/all-posts.md',
  cookieFile: 'data/cookies.json',
  postsToFetch: 100  // 每次只抓取最新的100条
};

// 每天每5分钟执行一次，无需时间检查

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
    
    const startPage = Math.max(1, totalPages - Math.ceil(CONFIG.postsToFetch / 20) + 1);
    
    for (let pageNum = startPage; pageNum <= totalPages; pageNum++) {
      console.log(`抓取第 ${pageNum} 页...`);
      const url = pageNum === 1 ? CONFIG.ngaUrl : `${CONFIG.ngaUrl}&page=${pageNum}`;
      
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        
        // 等待帖子内容加载
        await page.waitForSelector('tbody tr', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);
        
        const pagePosts = await page.evaluate((targetUid) => {
          const rows = document.querySelectorAll('tbody tr');
          const results = [];
          
          for (const row of rows) {
            try {
              const links = row.querySelectorAll('a[href*="uid="]');
              if (links.length === 0) continue;
              
              // 第一个链接是发帖人
              // 先找带[]的昵称
              let username = '';
              let uid = '';
              
              for (const link of links) {
                const text = link.textContent.trim();
                const href = link.getAttribute('href');
                const uidMatch = href.match(/uid=(\d+)/);
                
                if (text.includes('[') && text.includes(']')) {
                  username = text.replace(/[\[\]]/g, '').trim();
                  uid = uidMatch?.[1] || '';
                  break;
                }
              }
              
              // 如果没找到昵称，用第一个链接
              if (!username && links.length > 0) {
                const firstLink = links[0];
                const href = firstLink.getAttribute('href');
                const text = firstLink.textContent.trim();
                const uidMatch = href.match(/uid=(\d+)/);
                
                if (!uidMatch) continue;
                
                uid = uidMatch[1];
                if (text.startsWith('UID:')) {
                  username = 'UID:' + uid;
                } else {
                  username = text;
                }
              }
              
              if (!uid) continue;
              
              // 检查是否是楼主
              const isLouzhu = uid === targetUid;
              
              // 获取楼层号
              const floorLink = row.querySelector('a[href*="#pid"]');
              const floorText = floorLink?.textContent?.trim() || '';
              const floor = floorText.replace('#', '') || 'unknown';
              
              const rowText = row.textContent || '';
              const timeMatch = rowText.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
              const time = timeMatch ? timeMatch[1] : '';
              
              // 清理内容：去掉用户信息和各种杂质
              let content = rowText;
              
              // 清理整个用户信息区块
              content = content.replace(/UID:\d+.*?(?=20\d{2}-\d{2}-\d{2})/s, '');
              
              // 清理回复/评分信息
              content = content.replace(/Reply to.*?\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)/g, '');
              content = content.replace(/\+R by.*?\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)/g, '');
              
              // 清理附件、ubbcode等（直接截断）
              const attachIdx = content.indexOf('附件显示');
              if (attachIdx > -1) {
                content = content.substring(0, attachIdx);
              }
              // 清理 JS 变量
              content = content.replace(/ubbcode\..*$/g, '');
              content = content.replace(/commonui\..*$/g, '');
              
              // 清理用户属性
              content = content.replace(/财富:\s*\d+/g, '');
              content = content.replace(/威望:\s*\d+.*?(?=\d{2}:)/g, '');
              content = content.replace(/徽章:/g, '');
              content = content.replace(/级别:/g, '');
              
              // 简化日期清理：直接去掉年月日
              content = content.replace(/\d{4}-\d{2}-\d{2}/g, '');
              content = content.replace(/\d{2}:\d{2}/g, '');
              
              // 清理评分等数字
              content = content.replace(/\+\d+/g, '');
              content = content.replace(/反对/g, '');
              
              // 清理楼层号和评分（如 #45895 1 或 1）
              content = content.replace(/#\d+\s*\d*/, '').replace(/\s+\d+$/, '');
              
              // 清理多余空格和符号
              content = content.replace(/\s+/g, ' ').trim();
              
              // 去掉开头的时间（如果还有残留）
              content = content.replace(/^-\d+-\d+\s+/, '');
              
              const cleanContent = content;
              
              if (cleanContent && cleanContent.length > 5) {
                results.push({
                  floor,
                  uid,
                  username: username || 'UID:' + uid,
                  isLouzhu,
                  time,
                  content: cleanContent.substring(0, 2000)
                });
              }
            } catch (e) {
              // 跳过
            }
          }
          
          return results;
        }, CONFIG.targetUid);
        posts.push(...pagePosts);
        
      } catch (pageErr) {
        console.log(`  页面加载失败: ${pageErr.message}`);
      }
    }
    
    console.log(`共抓取 ${posts.length} 条发言`);
    
    // 调试：检查抓取的数据
    const louzhuCount = posts.filter(p => p.isLouzhu).length;
    console.log('抓到的帖子中，有', louzhuCount, '条是楼主的');
    
    return posts;
  } finally {
    await browser.close();
  }
}

function saveToGitHub(posts) {
  const dataPath = path.join(__dirname, 'data', 'all-posts.md');
  
  // 只保留最新的100条，不再做增量比对
  const newPosts = posts.slice(0, CONFIG.postsToFetch);
  
  if (newPosts.length === 0) {
    console.log('没有新发言');
    return false;
  }
  
  console.log(`获取最新 ${newPosts.length} 条发言`);
  
  newPosts.sort((a, b) => b.time.localeCompare(a.time));
  
  // 调试：打印楼主的发言
  const louzhuPosts = newPosts.filter(p => p.isLouzhu);
  console.log('DEBUG: 共', louzhuPosts.length, '条楼主发言');
  for (const p of louzhuPosts.slice(0, 3)) {
    console.log('  楼主:', p.uid, p.username, 'isLouzhu:', p.isLouzhu);
  }
  
  const mdLines = newPosts.map(p => {
    // 去掉内容开头的时间和多余空格
    let content = p.content
      .replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*/, '')
      .replace(/^\d{2}:\d{2}\s*/, '')
      .replace(/\|/g, '\\|')
      .replace(/\n/g, ' ')
      .trim();
    // 标记楼主
    const prefix = p.isLouzhu ? '[楼主] ' : '';
    // 输出格式: - 用户名 | #楼层 内容
    return `- ${prefix}${p.username} | #${p.floor} ${content}`;
  });
  
  const header = '# NGA 帖子发言记录\n\n最后更新: ' + new Date().toLocaleString() + '\n\n';
  const newContent = header + mdLines.join('\n');
  
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
  console.log('='.repeat(50));
  console.log('开始抓取 NGA 帖子所有发言...');
  console.log('='.repeat(50));
  
  const posts = await fetchAllPosts(true);
  
  if (posts.length > 0) {
    saveToGitHub(posts);
  }
}

main().catch(console.error);
