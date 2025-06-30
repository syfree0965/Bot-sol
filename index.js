require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const NodeCache = require('node-cache');
const winston = require('winston');
const WebSocket = require('ws');
const fetch = require('node-fetch');

// ======== إعدادات البيئة ========
const BOT_TOKEN = process.env.BOT_TOKEN;
const QUICKNODE_WS_URL = process.env.QUICKNODE_WS_URL || 'wss://yolo-wider-knowledge.solana-mainnet.quiknode.pro/25f92089969ab99aff86c2b35d5b7080782cdda6';
const QUICKNODE_HTTP_URL = process.env.QUICKNODE_HTTP_URL || 'https://yolo-wider-knowledge.solana-mainnet.quiknode.pro/25f92089969ab99aff86c2b35d5b7080782cdda6';
const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !QUICKNODE_WS_URL || !QUICKNODE_HTTP_URL) {
  console.error('يجب تعيين BOT_TOKEN و QUICKNODE_WS_URL و QUICKNODE_HTTP_URL في ملف .env!');
  process.exit(1);
}

// ======== إعداد المسجل (Logger) ========
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

logger.info(`QuickNode WebSocket URL: ${QUICKNODE_WS_URL}`);
logger.info(`QuickNode HTTP URL: ${QUICKNODE_HTTP_URL}`);

// ======== إعداد التخزين المؤقت ========
const tokenCache = new NodeCache({ stdTTL: 300 });
const userCache = new NodeCache();

// ======== تهيئة بوت التلجرام ========
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on('polling_error', (error) => {
  logger.error(`خطأ في استطلاع Telegram: ${error.message}`, { stack: error.stack });
});

// ======== دالة تهريب الأحرف الخاصة لماركداون ========
function escapeMarkdown(text) {
  if (typeof text !== 'string') text = String(text);
  const reservedChars = /([_*[\]()~`>#+\-=|{}.!\\])/g;
  return text.replace(reservedChars, '\\$1');
}

// ======== الحصول على معلومات التوكن باستخدام QuickNode RPC ========
async function getTokenInfo(tokenAddress) {
  const tokenInfo = {
    name: 'غير معروف',
    symbol: '?',
    price: 0,
    liquidity: 0,
    marketCap: 0,
    mint: tokenAddress,
    socials: {}
  };
  try {
    // جلب بيانات الميتاداتا باستخدام getAccountInfo
    const response = await fetch(QUICKNODE_HTTP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [
          tokenAddress,
          { encoding: 'jsonParsed' }
        ]
      })
    });
    const data = await response.json();
    if (data.result && data.result.value) {
      const accountData = data.result.value.data.parsed.info;
      tokenInfo.name = accountData.metadata?.name || tokenInfo.name;
      tokenInfo.symbol = accountData.metadata?.symbol || tokenInfo.symbol;
    }

    // جلب السعر والسيولة والقيمة السوقية باستخدام Birdeye API (اختياري)
    const birdeyeResponse = await fetch(`https://public-api.birdeye.so/public/price?address=${tokenAddress}`, {
      headers: { 'X-API-KEY': process.env.BIRDEYE_API_KEY || '' }
    });
    if (birdeyeResponse.ok) {
      const priceData = await birdeyeResponse.json();
      tokenInfo.price = priceData.data?.value || tokenInfo.price;
      tokenInfo.liquidity = priceData.data?.liquidity || tokenInfo.liquidity;
      tokenInfo.marketCap = priceData.data?.marketCap || tokenInfo.marketCap;
    } else {
      logger.warn('فشل جلب بيانات السعر من Birdeye API', { mint: tokenAddress });
    }
  } catch (error) {
    logger.error(`خطأ في جلب معلومات التوكن: ${error.message}`, { stack: error.stack, mint: tokenAddress });
  }
  return tokenInfo;
}

// ======== مراقبة معاملات Pump.fun عبر QuickNode WebSocket ========
async function pollNewTokens(userId) {
  const ws = new WebSocket(QUICKNODE_WS_URL);

  ws.on('open', () => {
    logger.info('WebSocket متصل');
    const request = {
      jsonrpc2: '2.0',
      id: 1,
      method: 'programSubscribe',
      params: [
        PUMP_FUN_PROGRAM,
        { encoding: 'jsonParsed', commitment: 'confirmed' }
      ]
    };
    ws.send(JSON.stringify(request));
    // إرسال ping كل 30 ثانية للحفاظ على الاتصال
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
        logger.debug('تم إرسال ping');
      }
    }, 30000);
  });

  ws.on('message', async (data) => {
    try {
      const messageStr = data.toString('utf8');
      const messageObj = JSON.parse(messageStr);
      if (messageObj.params && messageObj.params.result) {
        const result = messageObj.params.result;
        const logs = result.value.transaction.meta.logMessages;
        const accountKeys = result.value.transaction.transaction.message.accountKeys.map(ak => ak.pubkey);
        const signature = result.value.signature;

        if (logs && logs.some(log => log.includes('Program log: Instruction: InitializeMint2'))) {
          const tokenAddress = accountKeys[1]; // التوكن هو المفتاح الثاني
          logger.info(`تم اكتشاف توكن جديد: ${tokenAddress}`, { signature });

          if (tokenCache.has(tokenAddress)) {
            logger.debug(`تم تجاهل العملة بسبب وجودها في التخزين المؤقت: ${tokenAddress}`);
            return;
          }

          tokenCache.set(tokenAddress, true);
          await broadcastNewToken({ mint: tokenAddress, created_at: new Date() }, 'pumpfun', userId);
        }
      }
    } catch (error) {
      logger.error(`خطأ في معالجة رسالة WebSocket: ${error.message}`, { stack: error.stack });
    }
  });

  ws.on('error', (err) => {
    logger.error(`خطأ في WebSocket: ${err.message}`, { stack: err.stack });
    bot.sendMessage(userId, escapeMarkdown(`❌ خطأ في WebSocket: ${err.message}`), { parse_mode: 'MarkdownV2' });
  });

  ws.on('close', () => {
    logger.info('WebSocket مغلق، جاري إعادة الاتصال...');
    setTimeout(() => pollNewTokens(userId), 5000); // إعادة المحاولة بعد 5 ثوانٍ
  });
}

// ======== بث التنبيهات للمستخدمين ========
async function broadcastNewToken(coin, service, userId) {
  try {
    const tokenInfo = await getTokenInfo(coin.mint);
    const ageInSeconds = Math.floor((Date.now() - new Date(coin.created_at).getTime()) / 1000);
    const message = formatTokenMessage(tokenInfo, ageInSeconds);
    await bot.sendMessage(userId, message, { parse_mode: 'MarkdownV2', disable_web_page_preview: true });
    logger.info(`تم إرسال عملة جديدة إلى ${userId} عبر ${service}`, { userId, service, mint: coin.mint });
    // إيقاف الاستطلاع بعد إرسال نتيجة واحدة
    userCache.del(userId);
    await bot.sendMessage(userId, escapeMarkdown('🛑 تم إيقاف المراقبة. اضغط "مراقبة عبر Pump.fun" لإعادة التفعيل.'), { parse_mode: 'MarkdownV2' });
  } catch (error) {
    logger.error(`خطأ في بث العملة من ${service}: ${error.message}`, { stack: error.stack, coin });
    await bot.sendMessage(userId, escapeMarkdown(`❌ خطأ في إرسال العملة: ${error.message}`), { parse_mode: 'MarkdownV2' });
  }
}

// ======== تنسيق رسالة التنبيه ========
function formatTokenMessage(tokenInfo, ageInSeconds) {
  const socialLinks = [];
  if (tokenInfo.socials.twitter) {
    socialLinks.push(`[${escapeMarkdown('X')}](https://x.com/${escapeMarkdown(tokenInfo.socials.twitter.replace('https://x.com/', ''))})`);
  }
  if (tokenInfo.socials.telegram) {
    socialLinks.push(`[${escapeMarkdown('Telegram')}](https://t.me/${escapeMarkdown(tokenInfo.socials.telegram.replace('https://t.me/', ''))})`);
  }
  if (tokenInfo.socials.website) {
    socialLinks.push(`[${escapeMarkdown('Website')}](https://website/${escapeMarkdown(tokenInfo.socials.website.replace('https://website/', ''))})`);
  }
  const socialsText = socialLinks.length > 0 ? socialLinks.join(' | ') : 'غير متوفرة';

  return `
🚀 *${escapeMarkdown('تم إطلاق عملة جديدة على Pump.fun!')}*
━━━━━━━━━━━━━━━━━━
🪙 *${escapeMarkdown('الاسم:')}* ${escapeMarkdown(tokenInfo.name)}
🔤 *${escapeMarkdown('الرمز:')}* ${escapeMarkdown(tokenInfo.symbol)}
💰 *${escapeMarkdown('السعر:')}* $${escapeMarkdown((tokenInfo.price?.toFixed(6) || '0.000000'))}
📊 *${escapeMarkdown('السيولة:')}* $${escapeMarkdown(tokenInfo.liquidity.toFixed(2))}
🏦 *${escapeMarkdown('القيمة السوقية:')}* $${escapeMarkdown(tokenInfo.marketCap.toFixed(2))}
⏱️ *${escapeMarkdown('العمر:')}* ${escapeMarkdown(ageInSeconds.toString())} ${escapeMarkdown('ثانية')}
━━━━━━━━━━━━━━━━━━
🔗 *${escapeMarkdown('رابط العملة:')}* [${escapeMarkdown('Pump.fun')}](https://pump.fun/${escapeMarkdown(tokenInfo.mint)})
🌐 *${escapeMarkdown('روابط التواصل:')}* ${socialsText}
━━━━━━━━━━━━━━━━━━
📝 *${escapeMarkdown('عنوان العقد:')}* \`${escapeMarkdown(tokenInfo.mint)}\`
`.trim();
}

// ======== إدارة المستخدمين ========
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;
  const keyboard = {
    inline_keyboard: [
      [{ text: '🚀 مراقبة عبر Pump.fun', callback_data: 'select_pumpfun' }],
      [{ text: '❌ إيقاف المراقبة', callback_data: 'stop_monitoring' }],
      [{ text: '🔄 حالة النظام', callback_data: 'system_status' }]
    ]
  };
  await bot.sendMessage(userId, 'مرحبًا! اختر الخدمة لمراقبة العملات الجديدة على Pump.fun:', { reply_markup: keyboard });
});

bot.on('callback_query', async (query) => {
  const userId = query.from.id;
  const data = query.data;
  await bot.answerCallbackQuery(query.id);
  if (data === 'select_pumpfun') {
    userCache.set(userId, 'pumpfun');
    await bot.sendMessage(userId, escapeMarkdown('✅ *تم تفعيل المراقبة عبر Pump.fun! جاري البحث عن عملة جديدة...*'), { parse_mode: 'MarkdownV2' });
    await pollNewTokens(userId);
  } else if (data === 'stop_monitoring') {
    userCache.del(userId);
    await bot.sendMessage(userId, escapeMarkdown('🛑 *تم إيقاف المراقبة!*'), { parse_mode: 'MarkdownV2' });
  } else if (data === 'system_status') {
    const usersPumpFun = userCache.keys().filter(key => userCache.get(key) === 'pumpfun').length;
    const status = escapeMarkdown(`
*حالة النظام:*
• Pump.fun: ${userCache.has(userId) ? '🟢 المراقبة نشطة' : '🔴 المراقبة غير نشطة'}
• مستخدمو Pump.fun: ${usersPumpFun}
    `).trim();
    await bot.sendMessage(userId, status, { parse_mode: 'MarkdownV2' });
  }
});

// ======== التحقق من QuickNode RPC ========
async function checkRpc() {
  try {
    const response = await fetch(QUICKNODE_HTTP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSlot'
      })
    });
    if (!response.ok) {
      throw new Error('فشل التحقق من QuickNode RPC');
    }
    logger.info('QuickNode RPC صالح، بدء تشغيل المراقبة...');
  } catch (error) {
    logger.error(`خطأ في التحقق من QuickNode RPC: ${error.message}`, { stack: error.stack });
    process.exit(1);
  }
}

// ======== بدء تشغيل البوت والتحقق من RPC ========
checkRpc();
logger.info('تم بدء تشغيل البوت بنجاح!');
