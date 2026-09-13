/**
 * Google Flow Automated Video & Image Generator - Telegram Bot & Render Service
 * Author: Zuhra Olimova & Yaxshi Bola
 */

require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const playwright = require('playwright');
const fs = require('fs');
const path = require('path');

// Global in-memory logs
const LOGS = [];
function addLog(type, ...args) {
  const line = `[${new Date().toISOString()}] [${type}] ` + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  if (type === 'ERROR') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
  LOGS.push(line);
  if (LOGS.length > 600) LOGS.shift();
}

console.log = (...args) => addLog('INFO', ...args);
console.error = (...args) => addLog('ERROR', ...args);
console.warn = (...args) => addLog('WARN', ...args);

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN environment variable is not defined!');
  process.exit(1);
}
const GOOGLE_FLOW_URL = process.env.GOOGLE_FLOW_URL || 'https://flow.google.com/project/a3c7d45c-923f-409c-aa83-9bbde11794c6';
const COOKIES_FILE = path.join(__dirname, 'cookies.json');
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Helper: Escape HTML
function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Initialize Express
const app = express();
app.use(express.json());

// In-memory queue
const queue = [];
let isProcessing = false;
let currentProgress = null;

// Initialize Telegram Bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log('🤖 Google Flow Telegram Bot ishga tushdi...');

bot.on('polling_error', (error) => {
  console.error('⚠️ Telegram polling error:', error?.message || error);
});

bot.on('error', (error) => {
  console.error('⚠️ Telegram general error:', error?.message || error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err);
});

// Helper: Parse cookies from string or JSON
function parseCookies(raw) {
  if (!raw) return [];
  raw = raw.trim();

  // If already JSON
  if (raw.startsWith('[') && raw.endsWith(']')) {
    try {
      return JSON.parse(raw);
    } catch (e) {}
  }

  // If HTTP Cookie header format: name=val; name2=val2
  const list = [];
  const parts = raw.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx > -1) {
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (name) {
        list.push({
          name,
          value,
          domain: '.google.com',
          path: '/',
          secure: true
        });
      }
    }
  }
  return list;
}

function getStoredCookies() {
  if (process.env.GOOGLE_COOKIES) {
    return parseCookies(process.env.GOOGLE_COOKIES);
  }
  if (fs.existsSync(COOKIES_FILE)) {
    try {
      const data = fs.readFileSync(COOKIES_FILE, 'utf8');
      return parseCookies(data);
    } catch (e) {}
  }
  return [];
}

function saveCookies(cookieString) {
  const parsed = parseCookies(cookieString);
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(parsed, null, 2));
  return parsed.length;
}

// ==================== TELEGRAM BOT HANDLERS ====================

// /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const hasCookies = getStoredCookies().length > 0;

  const welcomeText = `
👋 <b>Salom, ${escapeHtml(msg.from.first_name || 'foydalanuvchi')}!</b>

Men <b>Google Flow AI Video & Rasm Generator</b> botiman 🤖⚡

Menga video yoki rasm uchun prompt yuboring, men Google Flow orqali uni tayyorlab, shu yerga yuboraman!

<b>Holat:</b>
- Google sessiyasi: ${hasCookies ? '✅ Ulangan' : '⚠️ Ulanmagan (iltimos /cookie yuboring)'}
- Navbat: ${queue.length} ta
- Server: 24/7 Render.com bulutida faol

<b>Imkoniyatlar:</b>
🎬 <i>Shunchaki matn yuboring ➔ <b>Video</b> yasaydi</i>
🖼 <code>/rasm &lt;matn&gt;</code> <i>➔ <b>Rasm</b> yasaydi</i>
📊 /status <i>➔ Tizim holati</i>
📸 /screenshot <i>➔ Google Flow ekran holatini ko\'rish</i>
🍪 /cookie &lt;matn&gt; <i>➔ Cookie-ni yangilash</i>
🗑 /clear <i>➔ Navbatni tozalash</i>
  `.trim();

  bot.sendMessage(chatId, welcomeText, {
    parse_mode: 'HTML',
    reply_markup: {
      keyboard: [
        [{ text: '📊 Status' }, { text: '📸 Screenshot' }],
        [{ text: 'ℹ️ Yordam' }]
      ],
      resize_keyboard: true
    }
  }).catch(e => console.error('Error sending start message:', e.message));
});

// /status or Status button
bot.onText(/(\/status|📊 Status)/, (msg) => {
  const chatId = msg.chat.id;
  const cookies = getStoredCookies();

  let text = `📊 <b>Tizim holati:</b>\n\n`;
  text += `• Google Hisob: ${cookies.length > 0 ? `✅ Ulangan (${cookies.length} ta cookie)` : '❌ Ulanmagan'}\n`;
  text += `• Hozirgi holat: ${isProcessing ? '🔄 Jarayon davom etmoqda' : '💤 Kutilmoqda (Bo\'sh)'}\n`;
  if (currentProgress) {
    text += `• Joriy progress: <b>${escapeHtml(currentProgress)}</b>\n`;
  }
  text += `• Navbatdagi vazifalar: <b>${queue.length} ta</b>\n`;

  if (queue.length > 0) {
    text += `\n<b>Navbat ro\'yxati:</b>\n`;
    queue.slice(0, 5).forEach((item, idx) => {
      text += `${idx + 1}. [${item.mode === 'image' ? '🖼 Rasm' : '🎬 Video'}] <i>${escapeHtml(item.prompt.slice(0, 40))}...</i>\n`;
    });
    if (queue.length > 5) {
      text += `...va yana ${queue.length - 5} ta\n`;
    }
  }

  bot.sendMessage(chatId, text, { parse_mode: 'HTML' }).catch(e => console.error('Error sending status:', e.message));
});

// /screenshot or Screenshot button
bot.onText(/(\/screenshot|📸 Screenshot)/, async (msg) => {
  const chatId = msg.chat.id;
  const lastShot = path.join(DOWNLOADS_DIR, 'latest_page.png');
  if (fs.existsSync(lastShot)) {
    await bot.sendPhoto(chatId, lastShot, { caption: '📸 Oxirgi olingan brauzer ekrani' }).catch(e => {
      bot.sendMessage(chatId, 'Rasm yuborishda xatolik: ' + e.message);
    });
  } else {
    bot.sendMessage(chatId, 'Hali hech qanday skrinshot olinmadi. Prompt yuboring yoki kuting.');
  }
});

// /clear
bot.onText(/\/clear/, (msg) => {
  const chatId = msg.chat.id;
  const count = queue.length;
  queue.length = 0;
  bot.sendMessage(chatId, `🗑 Navbat tozalandi (${count} ta prompt o\'chirildi).`);
});

// /cookie command
bot.onText(/\/cookie(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const cookieData = match[1];

  if (!cookieData) {
    return bot.sendMessage(
      chatId,
      `⚠️ <b>Cookie kiritish tartibi:</b>\n\n1. Kompyuteringizda Google Flow sahifasida F12 bosing (Console).\n2. <code>copy(document.cookie)</code> deb yozib Enter bosing.\n3. Bu yerga quyidagicha yuboring:\n<code>/cookie &lt;nusxalangan_matn&gt;</code>`,
      { parse_mode: 'HTML' }
    );
  }

  const count = saveCookies(cookieData);
  if (count > 0) {
    bot.sendMessage(chatId, `✅ <b>Muvaffaqiyatli!</b> ${count} ta Google cookie saqlandi. Endi video yoki rasm yaratishga tayyorman!`, { parse_mode: 'HTML' });
  } else {
    bot.sendMessage(chatId, `❌ Cookie formatida xatolik. Qaytadan tekshirib ko\'ring.`);
  }
});

// /rasm or /image command
bot.onText(/\/(?:rasm|image)\s+(.+)/i, (msg, match) => {
  const chatId = msg.chat.id;
  const promptText = match[1]?.trim();
  if (!promptText) return;

  queue.push({
    chatId,
    prompt: promptText,
    mode: 'image',
    addedAt: Date.now()
  });

  bot.sendMessage(
    chatId,
    `🖼 <b>Rasm prompti</b> navbatga qo\'shildi!\n"<i>${escapeHtml(promptText)}</i>"\nJami navbat: ${queue.length} ta.`,
    { parse_mode: 'HTML' }
  );

  triggerQueueProcessing();
});

// Text message handler (User sends prompts)
bot.on('message', async (msg) => {
  const text = msg.text;
  if (!text || text.startsWith('/')) return;
  if (text === '📊 Status' || text === '📸 Screenshot' || text === 'ℹ️ Yordam') return;

  const chatId = msg.chat.id;
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  if (lines.length === 0) return;

  lines.forEach(promptText => {
    queue.push({
      chatId,
      prompt: promptText,
      mode: 'video',
      addedAt: Date.now()
    });
  });

  bot.sendMessage(
    chatId,
    `✅ <b>${lines.length} ta prompt</b> navbatga qo\'shildi! Jami navbat: ${queue.length} ta.\n\n🚀 Video yaratish jarayoni boshlandi...`,
    { parse_mode: 'HTML' }
  ).catch(e => console.error('Error sending queue confirmation:', e.message));

  triggerQueueProcessing();
});

// ==================== GOOGLE FLOW AUTOMATION ====================

async function triggerQueueProcessing() {
  if (isProcessing) return;
  if (queue.length === 0) return;

  isProcessing = true;
  const item = queue.shift();

  try {
    await processPrompt(item);
  } catch (err) {
    console.error('Error processing prompt:', err);
    try {
      const safeErr = escapeHtml(err.message || String(err));
      await bot.sendMessage(item.chatId, `❌ <b>Xatolik yuz berdi:</b>\n<pre>${safeErr}</pre>`, { parse_mode: 'HTML' });
    } catch (e) {
      await bot.sendMessage(item.chatId, `❌ Xatolik yuz berdi:\n${err.message || err}`).catch(() => {});
    }
  } finally {
    isProcessing = false;
    currentProgress = null;
    // Process next if available
    if (queue.length > 0) {
      setTimeout(triggerQueueProcessing, 3000);
    }
  }
}

async function processPrompt(item) {
  const { chatId, prompt, mode } = item;
  const isImageMode = mode === 'image';
  const typeLabel = isImageMode ? 'Rasm' : 'Video';

  console.log(`[FlowBot] Processing ${typeLabel} prompt: "${prompt}" for chat: ${chatId}`);
  currentProgress = 'Brauzer ishga tushirilmoqda...';

  const statusMsg = await bot.sendMessage(
    chatId,
    `🔄 <b>${typeLabel} yaratilmoqda:</b>\n"<i>${escapeHtml(prompt)}</i>"\n\n⏳ Google Flow ochilmoqda...`,
    { parse_mode: 'HTML' }
  );

  const cookies = getStoredCookies();
  let browser = null;
  let page = null;

  try {
    console.log('[FlowBot] Launching Playwright Chromium...');
    browser = await playwright.chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      acceptDownloads: true
    });

    if (cookies.length > 0) {
      console.log(`[FlowBot] Adding ${cookies.length} cookies...`);
      const allCookies = [];
      for (const c of cookies) {
        allCookies.push({
          name: c.name,
          value: c.value,
          domain: c.domain || '.google.com',
          path: c.path || '/',
          secure: c.secure !== undefined ? c.secure : true,
          httpOnly: c.httpOnly !== undefined ? c.httpOnly : false
        });
      }
      await context.addCookies(allCookies).catch(e => console.error('Error adding cookies:', e.message));
    } else {
      console.warn('[FlowBot] No cookies found!');
    }

    page = await context.newPage();

    console.log(`[FlowBot] Navigating to: ${GOOGLE_FLOW_URL}`);
    const navResp = await page.goto(GOOGLE_FLOW_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log(`[FlowBot] Page loaded (Status: ${navResp ? navResp.status() : 'ok'}). URL: ${page.url()}`);
    console.log(`[FlowBot] Page title: "${await page.title()}"`);

    // Give SPA time to initialize
    await page.waitForTimeout(6000);

    // Save current screen
    const screenPath = path.join(DOWNLOADS_DIR, 'latest_page.png');
    await page.screenshot({ path: screenPath }).catch(() => {});

    // Check sign in redirect
    if (page.url().includes('accounts.google.com')) {
      console.error('[FlowBot] Redirected to Google login!');
      if (fs.existsSync(screenPath)) {
        await bot.sendPhoto(chatId, screenPath, {
          caption: '⚠️ Google hisobiga kirish talab qilinmoqda (Cookie eskirgan bo\'lishi mumkin).'
        }).catch(() => {});
      }
      throw new Error('Google hisobiga kirilmadi. Iltimos botga /cookie orqali yangi cookie yuboring!');
    }

    // If 404 project not found, click "Back to projects" and select latest project
    if (page.url().includes('404') || (await page.locator('text=/Project not found/i').isVisible().catch(() => false))) {
      console.log('[FlowBot] 404 Project not found. Clicking "Back to projects"...');
      const backBtn = page.locator('button:has-text("Back to projects"), a:has-text("Back to projects"), [role="button"]:has-text("Back to projects")').first();
      if (await backBtn.isVisible().catch(() => false)) {
        await backBtn.click();
        await page.waitForTimeout(5000);
        console.log('[FlowBot] Now at projects page:', page.url());
      }
      
      const firstProj = page.locator('a[href*="/project/"]').first();
      if (await firstProj.isVisible().catch(() => false)) {
        console.log('[FlowBot] Clicking first existing project...');
        await firstProj.click();
        await page.waitForTimeout(5000);
        console.log('[FlowBot] Opened project:', page.url());
      } else {
        const newProjBtn = page.locator('button:has-text("New"), [role="button"]:has-text("New"), button:has-text("Loyiha"), [role="button"]:has-text("Loyiha")').first();
        if (await newProjBtn.isVisible().catch(() => false)) {
          console.log('[FlowBot] Clicking create new project button...');
          await newProjBtn.click();
          await page.waitForTimeout(5000);
          console.log('[FlowBot] Opened new project:', page.url());
        }
      }
    }

    // Switch to "Rasmlar" if image mode requested
    if (isImageMode) {
      console.log('[FlowBot] Switching to Rasmlar tab...');
      const rasmTab = page.locator('text=/rasmlar|images/i').first();
      if (await rasmTab.isVisible().catch(() => false)) {
        await rasmTab.click();
        await page.waitForTimeout(2000);
      }
    }

    console.log('[FlowBot] Finding prompt input element...');
    currentProgress = 'Prompt kiritilmoqda...';
    try {
      await bot.editMessageText(`🔄 <b>${typeLabel} yaratilmoqda:</b>\n"<i>${escapeHtml(prompt)}</i>"\n\n✍️ Prompt yozilmoqda...`, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        parse_mode: 'HTML'
      });
    } catch (e) {}

    // Flexible selector for input
    const inputSelector = 'textarea, [contenteditable="true"], [role="textbox"], input[placeholder*="yaratilishi" i], input[type="text"]';
    let input = null;

    try {
      await page.waitForSelector(inputSelector, { timeout: 20000 });
      input = page.locator(inputSelector).first();
    } catch (selErr) {
      console.error('[FlowBot] Input element not found within 20s!');
      const pageText = await page.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => '');
      console.log('[FlowBot] Page text preview:', pageText);
      await page.screenshot({ path: screenPath }).catch(() => {});
      if (fs.existsSync(screenPath)) {
        await bot.sendPhoto(chatId, screenPath, {
          caption: `⚠️ Prompt maydoni topilmadi. Sahifa holati rasmda ko\'rsatilgan.`
        }).catch(() => {});
      }
      throw new Error(`Google Flow prompt maydoni topilmadi. Sahifa matni: ${pageText.slice(0, 100)}...`);
    }

    await input.click();
    await input.fill(prompt);
    console.log('[FlowBot] Prompt typed successfully.');
    await page.waitForTimeout(1000);

    // Save screenshot with typed prompt
    await page.screenshot({ path: screenPath }).catch(() => {});

    // Submit button (arrow ->)
    console.log('[FlowBot] Searching for submit button...');
    const buttons = page.locator('button, [role="button"]');
    const btnCount = await buttons.count();
    let submitBtn = null;

    for (let i = btnCount - 1; i >= 0; i--) {
      const b = buttons.nth(i);
      const isVis = await b.isVisible().catch(() => false);
      if (!isVis) continue;
      const text = (await b.innerText().catch(() => '')).toLowerCase();
      if (text.includes('xarajat') || text.includes('batafsil') || text.includes('fikrlash')) continue;
      submitBtn = b;
      break;
    }

    if (submitBtn) {
      console.log('[FlowBot] Clicking submit button...');
      await submitBtn.click();
    } else {
      console.log('[FlowBot] Submit button not detected, pressing Enter...');
    }
    await input.press('Enter');
    await page.waitForTimeout(2500);

    // Auto-confirm credits ("Doim tasdiqlash" / "Tasdiqlash")
    console.log('[FlowBot] Checking confirmation dialog...');
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(500);
      const confirmCandidate = page.locator('text=/doim tasdiqlash|always confirm|tasdiqlash/i').first();
      if (await confirmCandidate.isVisible().catch(() => false)) {
        await confirmCandidate.click();
        console.log('[FlowBot] Confirmed credits dialog!');
        break;
      }
    }

    // Wait for generation (track progress %)
    console.log('[FlowBot] Waiting for generation to complete...');
    let sawProgress = false;
    let completedWait = 0;
    const maxWaitSeconds = isImageMode ? 120 : 600; // 2 mins for image, 10 for video
    let elapsed = 0;

    while (elapsed < maxWaitSeconds) {
      await page.waitForTimeout(2000);
      elapsed += 2;

      // Check for error on page
      const errorEl = page.locator('text=/xatolik|failed|kredit yetarli emas|error/i').first();
      if (await errorEl.isVisible().catch(() => false)) {
        const errText = await errorEl.innerText().catch(() => 'Noma\'lum xatolik');
        throw new Error(`Google Flow xatolik berdi: ${errText}`);
      }

      // Check percentage on cards
      const pctMatch = await page.evaluate(() => {
        const all = document.querySelectorAll('div, span, p');
        for (const el of all) {
          if (el.children.length === 0) {
            const m = (el.textContent || '').trim().match(/^(\d{1,3})%$/);
            if (m) return m[1];
          }
        }
        return null;
      });

      if (pctMatch) {
        sawProgress = true;
        currentProgress = `${pctMatch}% yaratilmoqda`;
        try {
          await bot.editMessageText(`🔄 <b>${typeLabel} yaratilmoqda:</b>\n"<i>${escapeHtml(prompt)}</i>"\n\n📊 Progress: <b>${pctMatch}%</b>`, {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: 'HTML'
          });
        } catch (e) {}
        continue;
      }

      if (sawProgress) {
        completedWait++;
        if (completedWait >= 3) {
          console.log('[FlowBot] Generation completed after progress disappearance!');
          break;
        }
      } else {
        if (elapsed > 20) {
          // If in image mode, check if image exists
          if (isImageMode) {
            const imgCount = await page.locator('img[src*="blob:"], img[src*="googleusercontent"]').count();
            if (imgCount > 0) break;
          } else {
            // Check if video element is visible
            const videoEl = page.locator('video').first();
            if (await videoEl.isVisible().catch(() => false)) {
              break;
            }
          }
        }
      }
    }

    // Save final screenshot
    await page.screenshot({ path: screenPath }).catch(() => {});

    // Delivery
    currentProgress = `${typeLabel} yuklab olinmoqda...`;
    try {
      await bot.editMessageText(`🎉 <b>${typeLabel} tayyor bo\'ldi!</b>\nTelegramga yuklanmoqda...`, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        parse_mode: 'HTML'
      });
    } catch (e) {}

    await page.waitForTimeout(3000);

    if (isImageMode) {
      // Find image element
      const imgSrc = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img'));
        const found = imgs.find(i => i.src && (i.src.includes('googleusercontent') || i.src.startsWith('blob:')));
        return found ? found.src : null;
      });

      if (imgSrc && imgSrc.startsWith('http')) {
        console.log(`[FlowBot] Sending image from URL: ${imgSrc}`);
        await bot.sendPhoto(chatId, imgSrc, {
          caption: `✨ <b>Tayyor rasm:</b>\n"<i>${escapeHtml(prompt)}</i>"`,
          parse_mode: 'HTML'
        });
      } else {
        // Send screenshot of the card
        console.log('[FlowBot] Sending image screenshot');
        await bot.sendPhoto(chatId, screenPath, {
          caption: `✨ <b>Tayyor rasm:</b>\n"<i>${escapeHtml(prompt)}</i>"`,
          parse_mode: 'HTML'
        });
      }
    } else {
      // VIDEO DELIVERY
      const videoSrc = await page.evaluate(() => {
        const v = document.querySelector('video');
        return v ? v.src : null;
      });

      if (videoSrc && videoSrc.startsWith('http')) {
        console.log(`[FlowBot] Sending video from URL: ${videoSrc}`);
        await bot.sendVideo(chatId, videoSrc, {
          caption: `✨ <b>Tayyor video:</b>\n"<i>${escapeHtml(prompt)}</i>"`,
          parse_mode: 'HTML'
        });
      } else {
        // Look for download button
        const downloadBtn = page.locator('button:has(svg), a[download], [aria-label*="download" i], [aria-label*="yuklab" i]').first();
        const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);

        if (await downloadBtn.isVisible().catch(() => false)) {
          await downloadBtn.click();
        }

        const download = await downloadPromise;
        if (download) {
          const filePath = path.join(DOWNLOADS_DIR, `${Date.now()}_video.mp4`);
          await download.saveAs(filePath);
          console.log(`[FlowBot] Sending downloaded video: ${filePath}`);
          await bot.sendVideo(chatId, filePath, {
            caption: `✨ <b>Tayyor video:</b>\n"<i>${escapeHtml(prompt)}</i>"`,
            parse_mode: 'HTML'
          });
          fs.unlinkSync(filePath);
        } else {
          // Fallback: send screenshot
          console.log('[FlowBot] Download button not caught, sending preview screenshot...');
          await bot.sendPhoto(chatId, screenPath, {
            caption: `✅ Video tayyor bo\'ldi! Google Flow sahifangizdan ko\'rishingiz mumkin:\n"<i>${escapeHtml(prompt)}</i>"`,
            parse_mode: 'HTML'
          });
        }
      }
    }

    // Delete status message
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// ==================== EXPRESS ENDPOINTS (RENDER) ====================

app.get('/', (req, res) => {
  res.send(`
    <html>
      <body style="font-family: sans-serif; background: #121212; color: #fff; padding: 30px; text-align: center;">
        <h2>⚡ Google Flow Video & Image Generator Bot</h2>
        <p>Holat: <b>Faol (Running)</b></p>
        <p>Navbatdagi vazifalar: <b>${queue.length} ta</b></p>
        <p>Joriy jarayon: <b>${escapeHtml(currentProgress || 'Bo\'sh')}</b></p>
        <hr style="border-color: #333; margin: 20px 0;">
        <p><a href="/logs" style="color: #4da3ff;">Konsol loglarini ko\'rish (/logs)</a></p>
        <p><a href="/screenshot" style="color: #4da3ff;">Oxirgi skrinshot (/screenshot)</a></p>
        <p><a href="/test-flow" style="color: #4da3ff;">Google Flow ulanishini sinash (/test-flow)</a></p>
        <hr style="border-color: #333; margin: 20px 0;">
        <p>Telegram: <b>@sdkjgnsjgbot</b></p>
      </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', queueLength: queue.length, isProcessing, currentProgress });
});

app.get('/logs', (req, res) => {
  res.type('text/plain').send(LOGS.join('\n') || 'No logs yet.');
});

app.get('/screenshot', (req, res) => {
  const filePath = path.join(DOWNLOADS_DIR, 'latest_page.png');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Hali skrinshot mavjud emas.');
  }
});

app.get('/test-flow', async (req, res) => {
  console.log('[TestFlow] Running Google Flow direct home test...');
  let testBrowser = null;
  try {
    const cookies = getStoredCookies();
    testBrowser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    const ctx = await testBrowser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    });

    if (cookies.length > 0) {
      const allCookies = [];
      for (const c of cookies) {
        allCookies.push({
          name: c.name,
          value: c.value,
          domain: c.domain || '.google.com',
          path: c.path || '/',
          secure: c.secure !== undefined ? c.secure : true,
          httpOnly: c.httpOnly !== undefined ? c.httpOnly : false
        });
      }
      await ctx.addCookies(allCookies);
    }

    const testPage = await ctx.newPage();
    console.log('[TestFlow] Navigating to https://flow.google.com/');
    await testPage.goto('https://flow.google.com/', { waitUntil: 'domcontentloaded', timeout: 50000 });
    await testPage.waitForTimeout(6000);

    const title = await testPage.title();
    const url = testPage.url();
    console.log('[TestFlow] URL:', url, 'Title:', title);

    const screenPath = path.join(DOWNLOADS_DIR, 'latest_page.png');
    await testPage.screenshot({ path: screenPath });

    const pageText = await testPage.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '');

    const links = await testPage.evaluate(() => {
      return Array.from(document.querySelectorAll('a, button, [role="button"]')).map(el => ({
        tag: el.tagName,
        text: (el.innerText || el.textContent || '').trim().slice(0, 50),
        href: el.href || el.getAttribute('href') || null
      })).filter(x => x.text.length > 0).slice(0, 30);
    }).catch(() => []);

    await testBrowser.close();

    res.json({
      success: true,
      url,
      title,
      cookiesLoaded: cookies.length,
      pageTextPreview: pageText,
      elements: links,
      screenshotUrl: '/screenshot'
    });
  } catch (err) {
    if (testBrowser) await testBrowser.close().catch(() => {});
    res.status(500).json({ success: false, error: err.message, stack: err.stack });
  }
});

app.listen(PORT, () => {
  console.log(`🌐 Server ${PORT}-portda ishlamoqda...`);
});
