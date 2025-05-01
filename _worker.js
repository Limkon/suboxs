// 配置参数
const CONFIG = {
  mytoken: 'auto', // 默认 token，建议 env 配置强随机值
  guestToken: '', // 访客 token，建议 UUID
  botToken: '', // Telegram Bot Token
  chatId: '', // Telegram Chat ID
  tgEnabled: 0, // Telegram 通知开关：1 开启，0 关闭
  fileName: 'CF-Workers-SUB', // 订阅文件名
  subUpdateTime: 6, // 订阅更新时间（小时）
  totalData: 99, // 数据总量（TB）
  expireTimestamp: 4102329600000, // 过期时间（2099-12-31）
  maxUrls: 10, // 最大外部 URL 数量
  maxResponseSize: 1024 * 1024, // 最大响应大小（1MB）
};

// 默认节点链接
let mainData = `
https://raw.githubusercontent.com/mfuu/v2ray/master/v2ray
`;

// 速率限制（每分钟请求数）
const RATE_LIMIT = {
  maxRequests: 100,
  windowMs: 60 * 1000, // 1 分钟
};

// 存储请求计数
const requestCounts = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const clientIp = request.headers.get('CF-Connecting-IP');
    const userAgent = (request.headers.get('User-Agent') || 'null').toLowerCase();

    // 速率限制
    const now = Date.now();
    const clientKey = `${clientIp}:${url.hostname}`;
    const count = requestCounts.get(clientKey) || { count: 0, start: now };
    if (now - count.start > RATE_LIMIT.windowMs) {
      count.count = 0;
      count.start = now;
    }
    count.count += 1;
    requestCounts.set(clientKey, count);
    if (count.count > RATE_LIMIT.maxRequests) {
      return new Response('请求过多，请稍后重试', { status: 429 });
    }

    // 配置优先从环境变量读取
    const mytoken = env.TOKEN || CONFIG.mytoken;
    const botToken = env.TGTOKEN || CONFIG.botToken;
    const chatId = env.TGID || CONFIG.chatId;
    const tgEnabled = env.TG || CONFIG.tgEnabled;
    const fileName = env.SUBNAME || CONFIG.fileName;
    const subUpdateTime = env.SUBUPTIME || CONFIG.subUpdateTime;

    // 生成每日 token（SHA-256）
    const currentDate = new Date();
    currentDate.setHours(0, 0, 0, 0);
    const timeTemp = Math.floor(currentDate.getTime() / 1000);
    const fakeToken = await sha256(`${mytoken}${timeTemp}`);
    const guestToken = env.GUESTTOKEN || env.GUEST || CONFIG.guestToken || await sha256(mytoken);

    // 数据量和过期时间
    const total = CONFIG.totalData * 1099511627776; // TB to bytes
    const ud = Math.floor(((CONFIG.expireTimestamp - Date.now()) / CONFIG.expireTimestamp * total) / 2);
    const expire = Math.floor(CONFIG.expireTimestamp / 1000);

    // 认证
    const token = url.searchParams.get('token');
    const isValidToken = [mytoken, fakeToken, guestToken].includes(token) || url.pathname === `/${mytoken}`;
    if (!isValidToken) {
      if (tgEnabled && url.pathname !== '/' && url.pathname !== '/favicon.ico') {
        await sendMessage(`#异常访问 ${fileName}`, clientIp, `UA: ${userAgent}\n域名: ${url.hostname}\n入口: ${url.pathname + url.search}`, botToken, chatId);
      }
      if (env.URL302) return Response.redirect(env.URL302, 302);
      if (env.URL) return await proxyURL(env.URL, url);
      return new Response(await nginx(), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=UTF-8' },
      });
    }

    // 处理 KV 和订阅数据
    let urls = [];
    if (env.KV) {
      await migrateKvData(env, 'LINK.txt');
      if (userAgent.includes('mozilla') && !url.search && request.method === 'GET') {
        await sendMessage(`#编辑订阅 ${fileName}`, clientIp, `UA: ${userAgent}\n域名: ${url.hostname}\n入口: ${url.pathname + url.search}`, botToken, chatId);
        return await renderKvEditor(request, env, 'LINK.txt', guestToken, fileName, mytoken, url);
      }
      mainData = (await env.KV.get('LINK.txt')) || mainData;
    } else {
      mainData = env.LINK || mainData;
      if (env.LINKSUB) urls = await parseUrls(env.LINKSUB, CONFIG.maxUrls);
    }

    // 汇总节点和订阅链接
    const allLinks = await parseUrls(mainData + '\n' + urls.join('\n'), CONFIG.maxUrls);
    let selfHostedNodes = '';
    let subLinks = '';
    for (const link of allLinks) {
      if (link.toLowerCase().startsWith('http')) {
        subLinks += link + '\n';
      } else {
        selfHostedNodes += link + '\n';
      }
    }
    mainData = selfHostedNodes;
    urls = await parseUrls(subLinks, CONFIG.maxUrls);

    // 记录访问
    await sendMessage(`#获取订阅 ${fileName}`, clientIp, `UA: ${userAgent}\n域名: ${url.hostname}\n入口: ${url.pathname + url.search}`, botToken, chatId);

    // 获取外部订阅数据
    let reqData = mainData;
    if (urls.length > 0) {
      const [subContent] = await fetchSubscriptions(urls, request, userAgent, CONFIG.maxResponseSize);
      reqData += subContent.join('\n');
    }

    // 去重并编码为 Base64
    const uniqueLines = [...new Set(reqData.split('\n').filter(line => line.trim()))].join('\n');
    const base64Data = btoa(encodeUtf8(uniqueLines));

    // 返回 Base64 格式
    return new Response(base64Data, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Profile-Update-Interval': `${subUpdateTime}`,
      },
    });
  },
};

// 解析 URL 列表
async function parseUrls(text, maxUrls) {
  const lines = text
    .replace(/[\t"'|\r\n]+/g, '\n')
    .replace(/\n+/g, '\n')
    .trim()
    .split('\n')
    .filter(line => line.trim() && isValidUrl(line))
    .slice(0, maxUrls);
  return [...new Set(lines)]; // 去重
}

// 验证 URL
function isValidUrl(url) {
  try {
    new URL(url);
    return url.startsWith('https://'); // 强制 HTTPS
  } catch {
    return false;
  }
}

// SHA-256 哈希
async function sha256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Telegram 通知
async function sendMessage(type, ip, details, botToken, chatId) {
  if (!botToken || !chatId) return;
  const msg = `${type}\nIP: ${ip}\n<tg-spoiler>${details}</tg-spoiler>`;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage?chat_id=${chatId}&parse_mode=HTML&text=${encodeURIComponent(msg)}`;
  try {
    await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'CF-Workers-SUB' },
    });
  } catch (error) {
    console.error(`Telegram 通知失败: ${error}`);
  }
}

// Nginx 页面
async function nginx() {
  return `
    <!DOCTYPE html>
    <html>
    <head><title>Welcome to nginx!</title>
    <style>body { width: 35em; margin: 0 auto; font-family: Tahoma, Verdana, Arial, sans-serif; }</style>
    </head>
    <body>
    <h1>Welcome to nginx!</h1>
    <p>If you see this page, the nginx web server is successfully installed and working. Further configuration is required.</p>
    <p>For online documentation and support please refer to <a href="http://nginx.org/">nginx.org</a>.<br/>
    Commercial support is available at <a href="http://nginx.com/">nginx.com</a>.</p>
    <p><em>Thank you for using nginx.</em></p>
    </body>
    </html>
  `;
}

// 反向代理
async function proxyURL(proxyUrl, url) {
  const urls = await parseUrls(proxyUrl, 1);
  if (!urls.length) return new Response('无效代理 URL', { status: 400 });
  const targetUrl = new URL(urls[0]);
  const newUrl = `${targetUrl.protocol}//${targetUrl.hostname}${targetUrl.pathname}${url.pathname}${targetUrl.search}`;
  const response = await fetch(newUrl);
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}

// 获取订阅数据
async function fetchSubscriptions(urls, request, userAgent, maxSize) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  let subContent = [];

  try {
    const responses = await Promise.allSettled(
      urls.map(url =>
        fetchUrl(url, request, userAgent).then(async response => {
          if (!response.ok) throw new Error(`状态: ${response.status}`);
          const content = await response.text();
          if (content.length > maxSize) throw new Error('响应过大');
          return { url, content };
        })
      )
    );

    for (const response of responses) {
      if (response.status === 'fulfilled') {
        const { content, url } = response.value;
        if (content.includes('://')) {
          subContent.push(content);
        } else if (isValidBase64(content)) {
          subContent.push(decodeBase64(content));
        } else {
          subContent.push(`# 无效订阅: ${url}`);
        }
      }
    }
  } catch (error) {
    console.error(`获取订阅失败: ${error}`);
  } finally {
    clearTimeout(timeout);
  }

  return [subContent, ''];
}

// 发起请求
async function fetchUrl(targetUrl, request, userAgent) {
  const headers = new Headers(request.headers);
  headers.set('User-Agent', `v2rayn cmliu/CF-Workers-SUB ${userAgent}`);
  return fetch(targetUrl, {
    method: request.method,
    headers,
    body: request.method === 'GET' ? null : request.body,
    redirect: 'follow',
    signal: AbortSignal.timeout(5000),
  });
}

// Base64 验证和解码
function isValidBase64(str) {
  const cleanStr = str.replace(/\s/g, '');
  const base64Regex = /^[A-Za-z0-9+/=]+$/;
  return base64Regex.test(cleanStr) && cleanStr.length % 4 === 0;
}

function decodeBase64(str) {
  try {
    return atob(str);
  } catch {
    return '';
  }
}

// UTF-8 编码
function encodeUtf8(text) {
  const encoder = new TextEncoder();
  return new TextDecoder().decode(encoder.encode(text));
}

// 迁移 KV 数据
async function migrateKvData(env, key) {
  if (!env.KV) return false;
  const oldData = await env.KV.get(`/${key}`);
  if (oldData && !(await env.KV.get(key))) {
    await env.KV.put(key, oldData);
    await env.KV.delete(`/${key}`);
    return true;
  }
  return false;
}

// KV 编辑器
async function renderKvEditor(request, env, key, guestToken, fileName, mytoken, url) {
  if (request.method === 'POST') {
    if (!env.KV) return new Response('未绑定 KV 空间', { status: 400 });
    try {
      let content = await request.text();
      content = sanitizeInput(content);
      await env.KV.put(key, content);
      return new Response('保存成功', { status: 200 });
    } catch (error) {
      return new Response(`保存失败: ${error.message}`, { status: 500 });
    }
  }

  const content = env.KV ? (await env.KV.get(key)) || '' : '';
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>${fileName} 订阅编辑</title>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { margin: 0; padding: 15px; box-sizing: border-box; font-size: 13px; }
        .editor-container { width: 100%; max-width: 100%; margin: 0 auto; }
        .editor { width: 100%; height: 300px; margin: 15px 0; padding: 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; line-height: 1.5; resize: none; }
        .save-container { margin-top: 8px; display: flex; align-items: center; gap: 10px; }
        .save-btn { padding: 6px 15px; color: white; border: none; border-radius: 4px; cursor: pointer; background: #4CAF50; }
        .save-btn:hover { background: #45a049; }
        .save-status { color: #666; }
      </style>
    </head>
    <body>
      <h3>${fileName} 订阅编辑</h3>
      <p>订阅地址: <a href="https://${url.hostname}/${mytoken}" target="_blank">https://${url.hostname}/${mytoken}</a></p>
      <p>访客订阅 TOKEN: <strong>${guestToken}</strong></p>
      <div class="editor-container">
        ${env.KV ? `
          <textarea class="editor" id="content" placeholder="请输入节点链接或订阅地址">${content}</textarea>
          <div class="save-container">
            <button class="save-btn" onclick="saveContent()">保存</button>
            <span class="save-status" id="saveStatus"></span>
          </div>
        ` : '<p>请绑定 KV 命名空间（变量名：KV）</p>'}
      </div>
      <script>
        async function saveContent() {
          const textarea = document.getElementById('content');
          const status = document.getElementById('saveStatus');
          const button = document.querySelector('.save-btn');
          try {
            button.textContent = '保存中...';
            button.disabled = true;
            const response = await fetch(window.location.href, {
              method: 'POST',
              body: textarea.value,
              headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            });
            if (!response.ok) throw new Error('保存失败');
            status.textContent = '保存成功: ' + new Date().toLocaleString();
          } catch (error) {
            status.textContent = '保存失败: ' + error.message;
            status.style.color = 'red';
          } finally {
            button.textContent = '保存';
            button.disabled = false;
          }
        }
      </script>
    </body>
    </html>
  `;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=utf-8' },
  });
}

// 输入清理
function sanitizeInput(input) {
  return input
    .replace(/：/g, ':')
    .replace(/[<>{}]/g, '')
    .replace(/\s+/g, '\n')
    .trim();
}
