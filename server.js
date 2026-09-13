/**
 * Google Flow Automated Video Generator - Telegram Bot & Render Service
 * Author: Zuhra Olimova & Yaxshi Bola
 */

require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const playwright = require('playwright');
const fs = require('fs');
const path = require('path');

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
👋 <b>Salom, ${msg.from.first_name || 'foydalanuvchi'}!</b>

Men <b>Google Flow AI Video Generator</b> botiman 🤖⚡

Menga video yaratish uchun prompt yuboring, men Google Flow orqali videoni tayyorlab, to'g'ridan-to'g'ri shu yerga yuboraman!

<b>Holat:</b>
- Google sessiyasi: ${hasCookies ? '✅ Ulangan' : '⚠️ Ulanmagan (iltimos /cookie yuboring)'}
- Navbatdagi videolar: ${queue.length} ta
- Server: 24/7 Render.com bulutida faol

<b>Buyruqlar:</b>
📝 <i>Shunchaki prompt matnini yuboring (bir nechta bo'lsa har birini yangi qatordan)</i>
📊 /status — Navbat holati
🍪 /cookie &lt;matn&gt; — Google Flow cookie'sini ulash
🗑 /clear — Navbatni tozalash
  `.trim();

  bot.sendMessage(chatId, welcomeText, {
    parse_mode: 'HTML',
    reply_markup: {
      keyboard: [
        [{ text: '📊 Status' }, { text: '📋 Navbat' }],
        [{ text: 'ℹ️ Yordam' }]
      ],
      resize_keyboard: true
    }
  });
});

// /status or Status button
bot.onText(/(\/status|📊 Status)/, (msg) => {
  const chatId = msg.chat.id;
  const cookies = getStoredCookies();

  let text = `📊 <b>Tizim holati:</b>\n\n`;
  text += `• Google Hisob: ${cookies.length > 0 ? `✅ Ulangan (${cookies.length} ta cookie)` : '❌ Ulanmagan'}\n`;
  text += `• Hozirgi holat: ${isProcessing ? '🔄 Video yaratilmoqda' : '💤 Kutilmoqda (Bo\'sh)'}\n`;
  if (currentProgress) {
    text += `• Joriy progress: <b>${currentProgress}</b>\n`;
  }
  text += `• Navbatdagi videolar: <b>${queue.length} ta</b>\n`;

  if (queue.length > 0) {
    text += `\n<b>Navbat ro'yxati:</b>\n`;
    queue.slice(0, 5).forEach((item, idx) => {
      text += `${idx + 1}. <i>${item.prompt.slice(0, 40)}...</i>\n`;
    });
    if (queue.length > 5) {
      text += `...va yana ${queue.length - 5} ta\n`;
    }
  }

  bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
});

// /clear
bot.onText(/\/clear/, (msg) => {
  const chatId = msg.chat.id;
  const count = queue.length;
  queue.length = 0;
  bot.sendMessage(chatId, `🗑 Navbat tozalandi (${count} ta prompt o'chirildi).`);
});

// /cookie command
bot.onText(/\/cookie(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const cookieData = match[1];

  if (!cookieData) {
    return bot.sendMessage(
      chatId,
      `⚠️ <b>Cookie kiritish tartibi:</b>\n\n1. Kompyuteringizda Google Flow sahifasida F12 bosing (Console).\n2. <code>document.cookie</code> deb yozib, chiqqan matnni nusxalang.\n3. Bu yerga quyidagicha yuboring:\n<code>/cookie &lt;nusxalangan_matn&gt;</code>`,
      { parse_mode: 'HTML' }
    );
  }

  const count = saveCookies(cookieData);
  if (count > 0) {
    bot.sendMessage(chatId, `✅ <b>Muvaffaqiyatli!</b> ${count} ta Google cookie saqlandi. Endi video yaratishga tayyorman!`, { parse_mode: 'HTML' });
  } else {
    bot.sendMessage(chatId, `❌ Cookie formatida xatolik. Qaytadan tekshirib ko'ring.`);
  }
});

// Text message handler (User sends prompts)
bot.on('message', async (msg) => {
  const text = msg.text;
  if (!text || text.startsWith('/')) return;
  if (text === '📊 Status' || text === '📋 Navbat' || text === 'ℹ️ Yordam') return;

  const chatId = msg.chat.id;
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  if (lines.length === 0) return;

  lines.forEach(promptText => {
    queue.push({
      chatId,
      prompt: promptText,
      addedAt: Date.now()
    });
  });

  bot.sendMessage(
    chatId,
    `✅ <b>${lines.length} ta prompt</b> navbatga qo'shildi! Jami navbat: ${queue.length} ta.\n\n🚀 Video yaratish jarayoni boshlandi...`,
    { parse_mode: 'HTML' }
  );

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
    bot.sendMessage(item.chatId, `❌ <b>Xatolik yuz berdi:</b>\n<code>${err.message || err}</code>`, { parse_mode: 'HTML' });
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
  const { chatId, prompt } = item;
  currentProgress = 'Brauzer ishga tushirilmoqda...';

  const statusMsg = await bot.sendMessage(chatId, `🔄 <b>Video yaratilmoqda:</b>\n"<i>${prompt}</i>"\n\n⏳ Google Flow ochilmoqda...`, { parse_mode: 'HTML' });

  const cookies = getStoredCookies();
  let browser = null;

  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      acceptDownloads: true
    });

    if (cookies.length > 0) {
      await context.addCookies(cookies);
    }

    const page = await context.newPage();

    console.log(`[FlowBot] Opening Google Flow: ${GOOGLE_FLOW_URL}`);
    await page.goto(GOOGLE_FLOW_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);

    // Check if redirected to sign in
    if (page.url().includes('accounts.google.com')) {
      throw new Error('Google hisobiga kirilmagan. Iltimos botga /cookie orqali Google Flow cookie-sini yuboring!');
    }

    console.log('[FlowBot] Finding prompt input...');
    currentProgress = 'Prompt kiritilmoqda...';
    try {
      await bot.editMessageText(`🔄 <b>Video yaratilmoqda:</b>\n"<i>${prompt}</i>"\n\n✍️ Prompt yozilmoqda...`, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        parse_mode: 'HTML'
      });
    } catch (e) {}

    // Find input
    const inputSelector = 'textarea, [contenteditable="true"], [role="textbox"], input[placeholder*="yaratilishi" i]';
    await page.waitForSelector(inputSelector, { timeout: 30000 });
    const input = page.locator(inputSelector).first();
    await input.click();
    await input.fill(prompt);
    await page.waitForTimeout(1000);

    // Submit button (arrow ->)
    console.log('[FlowBot] Clicking submit...');
    const buttons = page.locator('button, [role="button"]');
    const btnCount = await buttons.count();
    let submitBtn = null;

    // Search near prompt or rightmost button
    for (let i = btnCount - 1; i >= 0; i--) {
      const b = buttons.nth(i);
      const isVis = await b.isVisible().catch(() => false);
      if (!isVis) continue;
      const text = (await b.innerText().catch(() => '')).toLowerCase();
      // Skip menu buttons
      if (text.includes('xarajat') || text.includes('batafsil') || text.includes('fikrlash')) continue;
      submitBtn = b;
      break;
    }

    if (submitBtn) {
      await submitBtn.click();
    }
    // Also press Enter
    await input.press('Enter');
    await page.waitForTimeout(2000);

    // Auto-confirm credits ("Doim tasdiqlash" / "Tasdiqlash")
    console.log('[FlowBot] Checking confirmation...');
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(600);
      const confirmCandidate = page.locator('text=/doim tasdiqlash|always confirm|tasdiqlash/i').first();
      if (await confirmCandidate.isVisible().catch(() => false)) {
        await confirmCandidate.click();
        console.log('[FlowBot] Confirmed credits!');
        break;
      }
    }

    // Wait for video generation (track progress %)
    console.log('[FlowBot] Waiting for generation...');
    let sawProgress = false;
    let completedWait = 0;
    const maxWaitSeconds = 600; // 10 mins
    let elapsed = 0;

    while (elapsed < maxWaitSeconds) {
      await page.waitForTimeout(2000);
      elapsed += 2;

      // Check for error
      const errorEl = page.locator('text=/xatolik|failed|kredit yetarli emas|error/i').first();
      if (await errorEl.isVisible().catch(() => false)) {
        const errText = await errorEl.innerText().catch(() => 'Noma\'lum xatolik');
        throw new Error(`Google Flow xatolik berdi: ${errText}`);
      }

      // Check percentage (e.g. 50%)
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
          await bot.editMessageText(`🔄 <b>Video yaratilmoqda:</b>\n"<i>${prompt}</i>"\n\n📊 Progress: <b>${pctMatch}%</b>`, {
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
          console.log('[FlowBot] Video generation complete!');
          break;
        }
      } else {
        if (elapsed > 30) {
          // Check if video element is already present
          const videoEl = page.locator('video').first();
          if (await videoEl.isVisible().catch(() => false)) {
            break;
          }
        }
      }
    }

    // Find and download video
    currentProgress = 'Video yuklab olinmoqda...';
    try {
      await bot.editMessageText(`🎉 <b>Video tayyor bo'ldi!</b>\nTelegramga yuklanmoqda...`, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        parse_mode: 'HTML'
      });
    } catch (e) {}

    // Find video download or video src
    await page.waitForTimeout(3000);

    // Try finding video src directly
    const videoSrc = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v ? v.src : null;
    });

    if (videoSrc && videoSrc.startsWith('http')) {
      console.log(`[FlowBot] Sending video from URL: ${videoSrc}`);
      await bot.sendVideo(chatId, videoSrc, {
        caption: `✨ <b>Tayyor video:</b>\n"<i>${prompt}</i>"`,
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
          caption: `✨ <b>Tayyor video:</b>\n"<i>${prompt}</i>"`,
          parse_mode: 'HTML'
        });
        fs.unlinkSync(filePath); // clean up
      } else {
        // Fallback: take a screenshot if video element is visible
        const screenshotPath = path.join(DOWNLOADS_DIR, `${Date.now()}_preview.png`);
        await page.screenshot({ path: screenshotPath });
        await bot.sendPhoto(chatId, screenshotPath, {
          caption: `✅ Video tayyor bo'ldi! Google Flow sahifangizdan ko'rishingiz mumkin:\n"<i>${prompt}</i>"`,
          parse_mode: 'HTML'
        });
        fs.unlinkSync(screenshotPath);
      }
    }

    // Delete status loading message
    bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
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
        <h2>⚡ Google Flow Video Generator Bot</h2>
        <p>Holat: <b>Faol (Running)</b></p>
        <p>Navbatdagi videolar: <b>${queue.length} ta</b></p>
        <p>Joriy jarayon: <b>${currentProgress || 'Bo\'sh'}</b></p>
        <hr style="border-color: #333; margin: 20px 0;">
        <p>Telegram: <b>@sdkjgnsjgbot</b></p>
      </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', queueLength: queue.length, isProcessing });
});

app.listen(PORT, () => {
  console.log(`🌐 Server ${PORT}-portda ishlamoqda...`);
});
