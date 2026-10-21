/**
 * PhimBot — Background Service Worker
 * Central coordinator: message routing, queue management, tab lifecycle, AI proxy
 */

try {
  importScripts('scripts/clip-sync-background.js');
} catch (e) {
  console.error('[PhimBot] Failed to import clip-sync-background.js:', e);
}

const TIKTOK_STUDIO_URL = 'https://www.tiktok.com/tiktokstudio/upload';

const DEFAULT_SETTINGS = { language: 'th', theme: 'dark' };

const DEFAULT_STORAGE = {
  phimbot_queue: [],
  phimbot_settings: { ...DEFAULT_SETTINGS },
  openrouter_api_key: '',
  openrouter_model: 'google/gemini-2.5-flash',
  phimbot_queue_delay: 60,
  phimbot_products: [],
};

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

/* ─── Placeholder Video for Scanner ───────────────────────────────────── */
// Minimal valid MP4 (~600 bytes) so TikTok Studio opens the editor
function generateMinimalMp4DataUrl() {
  // Tiny 1-frame black video encoded as base64
  // We generate it dynamically using canvas + MediaRecorder when needed
  return new Promise((resolve) => {
    try {
      const canvas = new OffscreenCanvas(64, 64);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 64, 64);
      canvas.convertToBlob({ type: 'video/webm' }).then((blob) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      }).catch(() => resolve(''));
    } catch {
      resolve('');
    }
  });
}

let isQueueRunning = false;
let isQueuePaused = false;
let currentQueueAbort = null;
let currentActivePostTabId = null;

/* ─── Storage Helpers ─────────────────────────────────────────────────── */

async function storageGet(keys) {
  try { return await chrome.storage.local.get(keys); }
  catch (e) { console.error('[PhimBot] storageGet:', e); return {}; }
}

async function storageSet(data) {
  try { await chrome.storage.local.set(data); }
  catch (e) { console.error('[PhimBot] storageSet:', e); }
}

async function getQueue() {
  const { phimbot_queue = [] } = await storageGet('phimbot_queue');
  return phimbot_queue;
}

async function saveQueue(queue) {
  await storageSet({ phimbot_queue: queue });
}

/* ─── Tab Management ──────────────────────────────────────────────────── */

function openTabAndWait(url) {
  return new Promise((resolve, reject) => {
    let tabId = null;
    let settled = false;

    const settle = (err, tab) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      err ? reject(err) : resolve(tab);
    };

    const onUpdated = (id, info, tab) => {
      if (id === tabId && info.status === 'complete') settle(null, tab);
    };
    const onRemoved = (id) => {
      if (id === tabId) settle(new Error('Tab closed before loading'));
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    chrome.tabs.create({ url, active: true })
      .then((tab) => {
        tabId = tab.id;
        if (tab.status === 'complete') settle(null, tab);
      })
      .catch((err) => settle(err));
  });
}

async function safeCloseTab(tabId) {
  try { await chrome.tabs.remove(tabId); } catch { /* already closed */ }
}

/* ─── Delay ───────────────────────────────────────────────────────────── */

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); return reject(new DOMException('Aborted', 'AbortError')); }
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    }
  });
}

/* ─── Broadcast ───────────────────────────────────────────────────────── */

async function broadcast(message) {
  try { await chrome.runtime.sendMessage(message).catch(() => {}); } catch { /* no listeners */ }
}

/* ─── JSON Extraction Helper ─────────────────────────────────────────── */

function extractJsonArray(text) {
  // Try 1: Direct parse
  try { const parsed = JSON.parse(text.trim()); if (Array.isArray(parsed)) return parsed; } catch {}
  // Try 2: Remove markdown code fences
  const noFence = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  try { const parsed = JSON.parse(noFence); if (Array.isArray(parsed)) return parsed; } catch {}
  // Try 3: Find the first [ ... ] block
  const match = text.match(/\[[\s\S]*\]/);
  if (match) { try { return JSON.parse(match[0]); } catch {} }
  throw new Error('Cannot extract JSON array from AI response');
}

/* ─── OpenRouter AI Proxy ─────────────────────────────────────────────── */

function buildSystemPrompt(action) {
  const prompts = {
    generate_caption: 'คุณเป็นนักสร้างคอนเทนต์ TikTok มืออาชีพ โปรดทำตามคำสั่งและรูปแบบที่ผู้ใช้กำหนดอย่างเคร่งครัด',
    suggest_hashtags: 'คุณเป็นผู้เชี่ยวชาญ TikTok แนะนำแฮชแท็กยอดนิยม ตอบแฮชแท็กบรรทัดละ 1 คำ ไม่ต้องใส่ # ไม่ต้องอธิบาย ผสมไทยและอังกฤษ',
    improve_content: 'คุณเป็นนักเขียนคอนเทนต์มืออาชีพ ปรับปรุงข้อความให้น่าสนใจ ไม่เกิน 300 ตัวอักษร ตอบเฉพาะข้อความที่ปรับปรุงแล้ว',
    brainstorm_ads: `คุณเป็นผู้เชี่ยวชาญด้านการสร้างวิดีโอโฆษณาสินค้าบน TikTok ระดับมืออาชีพ
คุณต้องคิดไอเดียวิดีโอโฆษณาที่แตกต่างกัน แต่ละไอเดียต้องมี headline (หัวข้อดึงดูด) และ concept (แนวคิดคร่าวๆ ของวิดีโอ)
ตอบเป็น JSON Array เท่านั้น ห้ามมี markdown หรือข้อความอื่น
ตัวอย่างรูปแบบ: [{"headline":"หัวข้อ","concept":"แนวคิดสั้นๆ"}]`,
    write_video_script: `คุณเป็นนักเขียนบทวิดีโอโฆษณา TikTok มืออาชีพ
คุณต้องเขียนบทพากย์สำหรับแต่ละฉากของวิดีโอ ให้เป็นภาษาไทยที่เป็นธรรมชาติ เหมือนอินฟลูเอนเซอร์พูดจริงๆ
ตอบเป็น JSON Array เท่านั้น ห้ามมี markdown หรือข้อความอื่น
ตัวอย่างรูปแบบ: [{"beat":"ชื่อฉาก","voiceover":"บทพูดไทย","overlay":"ข้อความบนจอ","visual":"คำอธิบายภาพ/ฉากเป็นภาษาอังกฤษสำหรับ AI สร้างวิดีโอ"}]`,
  };
  return prompts[action] || 'You are a helpful TikTok content assistant.';
}

async function callOpenRouter({ action, prompt, maxTokens }) {
  const tokenLimit = maxTokens || 1024;
  try {
    const config = await storageGet(['openrouter_api_key', 'phimbot_gemini_key', 'openrouter_model', 'phimbot_api_provider']);
    const provider = config.phimbot_api_provider || 'openrouter';
    const model = config.openrouter_model || 'google/gemini-2.5-flash';
    const systemPrompt = buildSystemPrompt(action);

    if (provider === 'gemini') {
      const apiKey = config.phimbot_gemini_key;
      if (!apiKey) return { success: false, error: 'กรุณาใส่ Gemini API Key ในหน้าตั้งค่า' };
      let geminiModel = 'gemini-1.5-flash';
      if (model.includes('gemini')) { geminiModel = model.split('/').pop(); }
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;
      const response = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: tokenLimit }
        })
      });
      if (!response.ok) { const body = await response.text().catch(() => ''); return { success: false, error: `Gemini API Error ${response.status}: ${body || response.statusText}` }; }
      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
      if (!text) return { success: false, error: 'AI ไม่ส่งข้อความกลับมา' };
      return { success: true, text };
    } else {
      const apiKey = config.openrouter_api_key;
      if (!apiKey) return { success: false, error: 'กรุณาใส่ OpenRouter API Key ในหน้าตั้งค่า' };
      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'HTTP-Referer': chrome.runtime.getURL('/'), 'X-Title': 'PhimBot' },
        body: JSON.stringify({ model, messages: [ { role: 'system', content: systemPrompt }, { role: 'user', content: prompt } ], max_tokens: tokenLimit, temperature: 0.7 }),
      });
      if (!response.ok) { const body = await response.text().catch(() => ''); return { success: false, error: `OpenRouter Error ${response.status}: ${body || response.statusText}` }; }
      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content?.trim() ?? '';
      if (!text) return { success: false, error: 'AI ไม่ส่งข้อความกลับมา' };
      return { success: true, text };
    }
  } catch (err) {
    console.error('[PhimBot] API error:', err);
    return { success: false, error: err.message };
  }
}

/* ─── Post Single Video ───────────────────────────────────────────────── */

async function postSingleVideo(job) {
  let tab = null;
  try {
    if (isQueuePaused || currentQueueAbort?.signal?.aborted) {
      return { ok: false, reason: 'คิวถูกสั่งหยุดโดยผู้ใช้', aborted: true };
    }

    const dryStore = await storageGet(['ag_e2e_dry_run']);
    if (dryStore?.ag_e2e_dry_run) {
      job = { ...job, dryRunVerifyOnly: true };
      console.log('[PhimBot] 🛡️ Dry-Run Verified Mode active for postSingleVideo:', job.id);
    }

    tab = await openTabAndWait(TIKTOK_STUDIO_URL);
    currentActivePostTabId = tab.id;

    if (isQueuePaused || currentQueueAbort?.signal?.aborted) {
      if (tab?.id) await safeCloseTab(tab.id);
      currentActivePostTabId = null;
      return { ok: false, reason: 'คิวถูกสั่งหยุดโดยผู้ใช้', aborted: true };
    }

    try {
      await delay(2500, currentQueueAbort?.signal);
    } catch (delayErr) {
      if (delayErr.name === 'AbortError' || isQueuePaused) {
        return { ok: false, reason: 'คิวถูกสั่งหยุดโดยผู้ใช้', aborted: true };
      }
      throw delayErr;
    }

    if (isQueuePaused || currentQueueAbort?.signal?.aborted) {
      if (tab?.id) await safeCloseTab(tab.id);
      currentActivePostTabId = null;
      return { ok: false, reason: 'คิวถูกสั่งหยุดโดยผู้ใช้', aborted: true };
    }

    let lastStep = '';
    const progressListener = (msg) => {
      if (msg?.type === 'PHIMBOT_TIKTOK_POST_PROGRESS' && msg.payload?.jobId === job.id) {
        lastStep = msg.payload.step;
      }
    };
    chrome.runtime.onMessage.addListener(progressListener);

    // Promise that rejects immediately when user clicks Pause/Abort
    const abortPromise = new Promise((_, reject) => {
      if (currentQueueAbort?.signal) {
        currentQueueAbort.signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }
    });

    const sendPostMessageWithRetry = async () => {
      try {
        return await chrome.tabs.sendMessage(tab.id, {
          action: 'PHIMBOT_TIKTOK_POST',
          job,
        });
      } catch (err) {
        const msg = String(err?.message || err || '');
        if (/receiving end does not exist|could not establish connection/i.test(msg)) {
          console.warn('[PhimBot] tiktok-poster.js not ready yet, injecting script and retrying...');
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['scripts/tiktok-poster.js'],
          });
          await delay(1200, currentQueueAbort?.signal);
          return await chrome.tabs.sendMessage(tab.id, {
            action: 'PHIMBOT_TIKTOK_POST',
            job,
          });
        }
        throw err;
      }
    };

    try {
      const postPromise = sendPostMessageWithRetry();
      const result = await Promise.race([postPromise, abortPromise]);
      chrome.runtime.onMessage.removeListener(progressListener);
      return result ?? { ok: true };
    } catch (sendErr) {
      chrome.runtime.onMessage.removeListener(progressListener);
      
      if (isQueuePaused || currentQueueAbort?.signal?.aborted || sendErr.name === 'AbortError') {
        return { ok: false, reason: 'คิวถูกสั่งหยุดโดยผู้ใช้', aborted: true };
      }

      // If the channel closed (e.g. page navigated away after clicking post)
      // and we had reached 'done' or 'submit', it's actually a success!
      const errStr = String(sendErr.message || sendErr).toLowerCase();
      const channelClosed = errStr.includes('closed') || errStr.includes('message port');
      
      if (channelClosed && (lastStep === 'done' || lastStep === 'submit')) {
        console.log('[PhimBot] Channel closed during submit, but last step was', lastStep, '-> SUCCESS');
        return { ok: true };
      }
      
      throw sendErr;
    }
  } catch (err) {
    if (isQueuePaused || currentQueueAbort?.signal?.aborted || err.name === 'AbortError') {
      return { ok: false, reason: 'คิวถูกสั่งหยุดโดยผู้ใช้', aborted: true };
    }
    console.error('[PhimBot] postSingleVideo:', err);
    return { ok: false, reason: err.message || 'Post failed' };
  } finally {
    if (tab?.id && !job?.keepTabOpen) await safeCloseTab(tab.id);
    if (currentActivePostTabId === tab?.id) currentActivePostTabId = null;
  }
}

function isShopeeAffShortLink(url) {
  if (!url || typeof url !== 'string') return false;
  const clean = url.trim();
  return /^https:\/\/(s\.shopee\.co\.th|shope\.ee)\//i.test(clean) && !clean.includes('affiliate.shopee.co.th');
}

function clampShopeePost(caption, hashtags) {
  let tagStr = '';
  if (Array.isArray(hashtags)) {
    tagStr = hashtags.map(h => h.startsWith('#') ? h : '#' + h).join(' ');
  } else if (typeof hashtags === 'string') {
    tagStr = hashtags.trim();
  }
  if (!tagStr) tagStr = '#ShopeeTH #รีวิว #ของดีบอกต่อ';

  // Shopee limit is 150 characters total. Keep <= 135 for absolute safety.
  const maxCapLen = Math.max(15, 135 - tagStr.length - 1);
  let cap = (caption || '').trim();
  if (cap.length > maxCapLen) {
    cap = cap.slice(0, Math.max(0, maxCapLen - 3)).trim() + '...';
  }
  return { caption: cap, hashtags: tagStr };
}

/* ─── Queue Processing ────────────────────────────────────────────────── */

async function processQueue() {
  if (isQueueRunning) return;
  isQueueRunning = true;
  isQueuePaused = false;
  currentQueueAbort = new AbortController();

  try {
    chrome.alarms.create('phimbot-keepalive', { periodInMinutes: 0.4 });

    while (!isQueuePaused) {
      const queue = await getQueue();
      const nextIdx = queue.findIndex((item) => item.status === 'pending');
      if (nextIdx === -1) break;

      const job = queue[nextIdx];
      job.status = 'processing';
      await saveQueue(queue);
      broadcast({ type: 'PHIMBOT_QUEUE_PROGRESS', payload: { id: job.id, status: 'processing', queue } });

      // ★ Lazy AI: generate unique caption right before posting each clip
      if (job.needsAiCaption) {
        try {
          const ctx = job.aiContext || {};
          const vNum = (ctx.videoIndex || 0) + 1;
          const vTotal = ctx.totalVideos || 1;
          broadcast({ type: 'PHIMBOT_QUEUE_PROGRESS', payload: { id: job.id, status: 'ai_generating', message: `🤖 AI กำลังคิดแคปชั่นใหม่คลิปที่ ${vNum}/${vTotal}...` } });
          const context = ctx.productName || job.filename?.replace(/\.[^.]+$/, '').replace(/[_\-]/g, ' ') || 'สินค้า';

          // Get previously done captions to avoid duplicates
          const doneJobs = (await getQueue()).filter(j => j.status === 'done' && j.caption);
          const prevHint = doneJobs.length > 0
            ? `\n\nห้ามซ้ำกับแคปชั่นก่อนหน้า:\n${doneJobs.slice(-5).map((c, idx) => `${idx + 1}. "${(c.caption || '').slice(0, 60)}"`).join('\n')}`
            : '';

          const isFbReels = job.platform === 'fb-reels';
          const isShopee = job.platform === 'shopee';
          const hasShopeeProduct = !!(ctx.affiliateUrl);
          let aiPrompt;

          if (isShopee) {
            // Shopee Video
            aiPrompt = `สร้างแคปชั่น Shopee Video และแฮชแท็ก สำหรับสินค้า "${context}" (คลิปที่ ${vNum} จากทั้งหมด ${vTotal} คลิป)
${ctx.productDesc ? `รายละเอียด: ${ctx.productDesc}` : ''}
${ctx.userCaption ? `แนวทางแคปชั่นจากผู้ใช้: ${ctx.userCaption}` : ''}

กฏแคปชั่น (สำคัญมาก):
- ความยาวแคปชั่นต้องสั้นกระชับ 1 ประโยค ไม่เกิน 65 ตัวอักษร สไตล์ป้ายยา ชวนกดสั่งในตะกร้า
- ความยาวรวมแคปชั่นและแฮชแท็กทั้งหมดต้องไม่เกิน 130 ตัวอักษร (Shopee ตัดทิ้งหากเกิน 150 ตัวอักษร)
- ห้ามพูดถึงราคาเด็ดขาด ห้ามโอเวอร์เคลม
- ใส่อิโมจิ 1-2 ตัว เช่น 🔥 ✨ 👇
- ห้ามใส่ # ในแคปชั่น
- ห้ามใส่คำว่า TikTok หรือ Reels เด็ดขาด
- ต้องไม่ซ้ำกับคลิปก่อนหน้าเด็ดขาด${prevHint}

กฏแฮชแท็ก:
- ใส่เพียง 2-3 แฮชแท็กสั้นๆ เท่านั้น เช่น #ShopeeTH #รีวิว #ของดีบอกต่อ (รวมไม่เกิน 35 ตัวอักษร)

รูปแบบคำตอบ (ตอบ 2 บรรทัดเท่านั้น):
CAPTION: [แคปชั่นสั้นๆ ไม่เกิน 65 ตัวอักษร ห้ามมี #]
HASHTAGS: [#แท็ก1 #แท็ก2 #แท็ก3]`;
          } else if (isFbReels && hasShopeeProduct) {
            // FB Reels with Shopee product
            aiPrompt = `สร้างแคปชั่น Facebook Reels และแฮชแท็ก สำหรับสินค้า "${context}" (คลิปที่ ${vNum} จากทั้งหมด ${vTotal} คลิป)
${ctx.productDesc ? `รายละเอียด: ${ctx.productDesc}` : ''}
${ctx.userCaption ? `แนวทางแคปชั่นจากผู้ใช้: ${ctx.userCaption}` : ''}

กฏแคปชั่น:
- กระชับ 2-3 ประโยค สไตล์รีวิว/แนะนำสินค้า ดึงดูดให้คนกดลิงก์
- ห้ามพูดถึงราคาเด็ดขาด
- ห้ามโอเวอร์เคลม ห้ามพูดว่า "ดีที่สุด" "อันดับ 1"
- ใส่อิโมจิ 2-3 ตัว
- ห้ามใส่ # ในแคปชั่น
- ห้ามใส่ลิงก์ในแคปชั่น (ลิงก์จะถูกใส่อัตโนมัติ)
- ต้องไม่ซ้ำกับคลิปก่อนหน้าเด็ดขาด ใช้มุมมองใหม่ เช่น รีวิวการใช้งาน, บอกต่อความประทับใจ, เน้นความคุ้มค่า หรือป้ายยา${prevHint}

กฏแฮชแท็ก:
- 5-7 แฮชแท็กเกี่ยวกับสินค้า + Facebook Reels
- ขึ้นต้นด้วย # เช่น #ShopeeThailand #ของดีบอกต่อ #รีวิว

รูปแบบคำตอบ (ตอบ 2 บรรทัดเท่านั้น):
CAPTION: [แคปชั่น ห้ามมี # ห้ามมีลิงก์]
HASHTAGS: [#แท็ก1 #แท็ก2 #แท็ก3 #แท็ก4 #แท็ก5]`;
          } else if (isFbReels) {
            // FB Reels without product
            aiPrompt = `สร้างแคปชั่น Facebook Reels สั้นๆ ดึงดูดคนดู สำหรับ "${context}" (คลิปที่ ${vNum} จากทั้งหมด ${vTotal} คลิป)
${ctx.productDesc ? `รายละเอียด: ${ctx.productDesc}` : ''}

กฏ:
- 1-3 ประโยค ใส่อิโมจิ ห้ามใส่ # ห้ามพูดถึงราคา
- ต้องไม่ซ้ำกับคลิปก่อนหน้า${prevHint}

รูปแบบคำตอบ:
CAPTION: [แคปชั่น]
HASHTAGS: [#แท็ก1 #แท็ก2 #แท็ก3 #แท็ก4 #แท็ก5]`;
          } else {
            // TikTok (original prompt)
            aiPrompt = `สร้างแคปชั่น TikTok, แฮชแท็ก และข้อความ CTA ตะกร้า สำหรับ "${context}" (วิดีโอที่ ${vNum} จาก ${vTotal})
${ctx.productDesc ? `รายละเอียดเพิ่มเติม: ${ctx.productDesc}` : ''}

กฏแคปชั่น:
- กระชับ 1-3 ประโยค สไตล์ "ป้ายยา" TikTok ดึงดูด น่าซื้อ แบบธรรมชาติ
- ห้ามพูดถึงราคาเด็ดขาด
- ห้ามโอเวอร์เคลม ห้ามพูดว่า "ดีที่สุด" "อันดับ 1" "ถูกที่สุด" "คุ้มสุด"
- เน้นป้ายยาแบบเบาๆ ธรรมชาติ เหมือนเพื่อนบอกต่อ
- ใส่อิโมจิ 1-2 ตัวที่เข้ากัน
- ห้ามใส่ # ในแคปชั่น (แฮชแท็กแยกไว้บรรทัด HASHTAGS)
- ต้องไม่ซ้ำกับวิดีโอก่อนหน้าเด็ดขาด${prevHint}

กฏแฮชแท็ก:
- ใส่ 3-5 แฮชแท็กที่เกี่ยวข้อง คั่นด้วยช่องว่าง
- ขึ้นต้นแต่ละคำด้วย # เช่น #TikTokShop #ของดีบอกต่อ

กฏข้อความ CTA ตะกร้า:
- สั้นกระชับ ไม่เกิน 25 ตัวอักษร เช่น "กดตะกร้าเลย", "พิกัดในตะกร้าเหลือง"
- ห้ามใส่อิโมจิเด็ดขาด

รูปแบบคำตอบ (ตอบเป็น 3 บรรทัดเท่านั้น):
CAPTION: [ข้อความแคปชั่น ห้ามมี #]
HASHTAGS: [#แท็ก1 #แท็ก2 #แท็ก3 #แท็ก4 #แท็ก5]
CTA: [ข้อความ CTA ไม่เกิน 25 ตัวอักษร]`;
          }

          let generatedCaption = '';
          let generatedHashtags = [];

          try {
            const aiResult = await callOpenRouter({ action: 'generate_caption', prompt: aiPrompt });
            if (aiResult.success && aiResult.text) {
              const capMatch = aiResult.text.match(/CAPTION:\s*(.+)/i);
              const hashMatch = aiResult.text.match(/HASHTAGS?\s*:?\s*(.+)/i);
              const ctaMatch = aiResult.text.match(/CTA:\s*(.+)/i);
              if (capMatch && capMatch[1]) generatedCaption = capMatch[1].trim().replace(/#\S+/g, '').trim();
              else generatedCaption = aiResult.text.replace(/HASHTAGS?:.+/i, '').replace(/CTA:.+/i, '').replace(/CAPTION:/i, '').replace(/#\S+/g, '').trim();
              if (hashMatch && hashMatch[1]) {
                generatedHashtags = (hashMatch[1].trim().match(/#\S+/g) || []).map(h => h.replace(/^#+/, '')).filter(Boolean).slice(0, 6);
              }
              if (ctaMatch && ctaMatch[1] && !job.basketCta) {
                job.basketCta = ctaMatch[1].replace(/[^\w\s฀-๿]/g, '').trim().slice(0, 30);
              }
            }
          } catch (callErr) {
            console.warn('[PhimBot] callOpenRouter error:', callErr);
          }

          // Smart Dynamic Variation Pool (guarantees EVERY clip gets a unique, attractive caption even without API key)
          if (!generatedCaption) {
            const prodTitle = ctx.productName || 'สินค้ายอดนิยม';
            const shortName = prodTitle.length > 50 ? prodTitle.slice(0, 48) + '...' : prodTitle;
            const vIdx = (ctx.videoIndex || 0);

            const variations = [
              `🔥 แนะนำเลยตัวนี้! ${shortName} ดีไซน์สวย ใช้งานดีมาก คุ้มค่าคุ้มราคา สายช้อปห้ามพลาดเด็ดขาด ✨`,
              `✨ ไอเทมเด็ดที่ต้องมีติดตัว! ${shortName} คุณภาพดีเกินคาด ได้ลองใช้แล้วบอกเลยว่าประทับใจสุดๆ 🛒`,
              `🏖️ บอกต่อของดี! ${shortName} ตัวนี้ตอบโจทย์มาก ใช้งานสะดวก สบายใจ คุ้มค่าเกินราคา รีบจัดก่อนหมดโปรนะ ⚡`,
              `💡 เพิ่งได้ลองแล้วเลิฟมาก! ${shortName} งานสวยตรงปก คุณภาพเกินราคา ใครเล็งตัวนี้อยู่แนะนำเลยจ้า 👍`,
              `🎉 ป้ายยาแรงๆ เลยทุกคน ${shortName} ไอเทมยอดฮิตที่ใครๆ ก็พูดถึง รีวิวแน่น ใช้งานดีจริงไม่มีผิดหวัง ✨`,
              `⚡ ของมันต้องมีจริงๆ! ${shortName} ใช้งานง่าย พกพาสะดวก คุณภาพคุ้มเกินเบอร์ สั่งเลยไม่ผิดหวังแน่นอน 💯`,
              `🌟 รีวิวจากใจ! ${shortName} งานเนียน สวยคุ้มค่า ใครตามหาอยู่ต้องจัดตัวนี้เลย การันตีความถูกใจ 💖`,
              `🌊 พร้อมลุยทุกสถานการณ์กับ ${shortName} ตอบโจทย์ทุกกิจกรรม คุณภาพมาตรฐาน สายนี้ต้องมีติดไว้เลยจ้า 🏖️`
            ];

            const hashtagSets = [
              ['reels', 'reelsfb', 'ของดีบอกต่อ', 'ช้อปปี้ถูกชัวร์', 'รีวิว'],
              ['reels', 'รีวิวของดี', 'ของมันต้องมี', 'ไอเทมเด็ด', 'ช้อปปี้'],
              ['reelsfb', 'ป้ายยา', 'ใช้ดีบอกต่อ', 'ของแท้', 'คุ้มค่า'],
              ['reels', 'ไอเทมสุดฮิต', 'ของขวัญ', 'รีวิวชัดเจน', 'แนะนำ']
            ];

            const tiktokHashtagSets = [
              ['TikTokShop', 'TikTokShopTH', 'ของดีบอกต่อ', 'รีวิว'],
              ['TikTokShop', 'ป้ายยา', 'ของมันต้องมี', 'ใช้ดีบอกต่อ'],
              ['TikTokShopTH', 'รีวิวของดี', 'ของดีบอกต่อ', 'พิกัดในตะกร้า'],
              ['TikTokShop', 'tiktokป้ายยา', 'ของแท้', 'คุ้มค่า']
            ];

            if (isShopee) {
              const shopeeShort = prodTitle.length > 25 ? prodTitle.slice(0, 22) + '...' : prodTitle;
              const shopeeCaptions = [
                `🔥 ตัวนี้ปังมาก! ${shopeeShort} ของดีคุ้มราคา กดในตะกร้าเลยจ้า ✨`,
                `✨ ได้มาแล้วชอบมาก! ${shopeeShort} ใช้งานดี ตอบโจทย์ พิกัดในตะกร้าเลย 👇`,
                `🛒 ไอเทมเด็ดต้องมี! ${shopeeShort} คุณภาพดีเกินราคา สั่งในตะกร้าได้เลย 🔥`,
                `💖 บอกต่อของดี! ${shopeeShort} ใช้แล้วประทับใจสุดๆ สั่งในตะกร้าด่วนๆ ✨`,
                `⚡ ถูกและดีมีจริง! ${shopeeShort} คุ้มค่าเกินราคา สั่งในตะกร้าได้เลย 👇`
              ];
              const shopeeTags = [
                ['ShopeeTH', 'รีวิว', 'ของดีบอกต่อ'],
                ['ShopeeVideo', 'ป้ายยา', 'ของดีบอกต่อ'],
                ['ShopeeTH', 'ช้อปปี้ถูกชัวร์', 'รีวิว'],
                ['ShopeeVideo', 'ของแท้', 'ลดราคา']
              ];
              generatedCaption = shopeeCaptions[vIdx % shopeeCaptions.length];
              generatedHashtags = shopeeTags[vIdx % shopeeTags.length];
            } else if (isFbReels) {
              generatedCaption = variations[vIdx % variations.length];
              generatedHashtags = hashtagSets[vIdx % hashtagSets.length];
            } else {
              generatedCaption = variations[vIdx % variations.length];
              generatedHashtags = tiktokHashtagSets[vIdx % tiktokHashtagSets.length];
            }
          }

          job.caption = generatedCaption;
          if (generatedHashtags.length > 0) job.hashtags = generatedHashtags;

          // Format caption with clean line breaks & affiliate link
          if (isFbReels && job.caption) {
            job.caption = formatReelsCaption({
              caption: job.caption,
              affiliateUrl: ctx.affiliateUrl || '',
              hashtags: (job.hashtags || []).map(h => '#' + h).join(' ')
            });
          } else if (isShopee && job.caption) {
            const clamped = clampShopeePost(job.caption, job.hashtags);
            job.caption = clamped.caption;
            job.hashtags = clamped.hashtags.split(/\s+/).filter(Boolean);
          }
          job.needsAiCaption = false;
          // Update queue with AI-generated data
          const qAfterAi = await getQueue();
          const jAfterAi = qAfterAi.find(j => j.id === job.id);
          if (jAfterAi) { jAfterAi.caption = job.caption; jAfterAi.hashtags = job.hashtags; jAfterAi.basketCta = job.basketCta; jAfterAi.needsAiCaption = false; await saveQueue(qAfterAi); }
          broadcast({ type: 'PHIMBOT_QUEUE_PROGRESS', payload: { id: job.id, status: 'processing', message: `✅ AI แคปชั่นคลิปที่ ${vNum}: "${(job.caption || '').slice(0, 35)}..."`, queue: await getQueue() } });
        } catch (aiErr) {
          console.warn('[PhimBot] Lazy AI caption failed:', aiErr);
          if (!job.caption) job.caption = job.filename?.replace(/\.[^.]+$/, '') || 'Video';
        }
      }

      // ★ Route to correct platform
      let result;
      if (job.platform === 'fb-reels') {
        result = await runFbReelsPost({
          mediaFiles: [{ name: job.filename, type: 'video/mp4', dataUrl: job.videoDataUrl }],
          caption: formatReelsCaption({
            caption: job.caption || '',
            affiliateUrl: job.aiContext?.affiliateUrl || '',
            hashtags: (job.hashtags || []).map(h => '#' + h).join(' ')
          }),
          aiLabelEnabled: job.aiLabelEnabled ?? true,
          scheduleMode: job.scheduleMode || 'now',
          scheduleDate: job.scheduleDate || '',
          scheduleTime: job.scheduleTime || '',
          closeTabWhenDone: job.closeTabWhenDone ?? true,
        });
      } else if (job.platform === 'shopee') {
        result = await runShopeePost(job);
      } else {
        result = await postSingleVideo(job);
      }

      const freshQueue = await getQueue();
      const freshJob = freshQueue.find((item) => item.id === job.id);
      if (freshJob) {
        if (isQueuePaused || result?.aborted || !isQueueRunning) {
          freshJob.status = 'pending';
          freshJob.error = null;
        } else {
          freshJob.status = result.ok ? 'done' : 'error';
          freshJob.error = result.ok ? null : (result.reason || 'Unknown error');
        }
        await saveQueue(freshQueue);
      }

      broadcast({ type: 'PHIMBOT_QUEUE_PROGRESS', payload: { id: job.id, status: freshJob?.status, queue: await getQueue() } });

      if (isQueuePaused || result?.aborted || !isQueueRunning) {
        break;
      }

      // ★ Inter-post delay with countdown broadcast
      if (!isQueuePaused) {
        const delayData = await storageGet(['phimbot_queue_delay_min', 'phimbot_queue_delay_max']);
        const minDelay = delayData.phimbot_queue_delay_min || 100;
        const maxDelay = delayData.phimbot_queue_delay_max || 200;
        const randomDelay = (minDelay === 0 && maxDelay === 0) ? 0 : Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
        const remaining = (await getQueue()).filter((i) => i.status === 'pending');
        if (remaining.length > 0 && randomDelay > 0) {
          // Countdown broadcast every second
          for (let sec = randomDelay; sec > 0; sec--) {
            if (isQueuePaused) break;
            broadcast({ type: 'PHIMBOT_COUNTDOWN', payload: { remaining: sec, total: randomDelay, nextJobId: remaining[0]?.id } });
            try { await delay(1000, currentQueueAbort.signal); }
            catch (e) { if (e.name === 'AbortError') { broadcast({ type: 'PHIMBOT_COUNTDOWN', payload: { remaining: 0 } }); break; } throw e; }
          }
          broadcast({ type: 'PHIMBOT_COUNTDOWN', payload: { remaining: 0 } });
        }
      }
    }
  } catch (err) {
    console.error('[PhimBot] processQueue:', err);
  } finally {
    isQueueRunning = false;
    isQueuePaused = false;
    currentQueueAbort = null;
    chrome.alarms.clear('phimbot-keepalive').catch(() => {});
    broadcast({ type: 'PHIMBOT_QUEUE_PROGRESS', payload: { status: 'stopped', queue: await getQueue() } });
  }
}

/* ─── Google Flow Helper Functions ────────────────────────────────────── */

const FLOW_GENERATION_WATCHDOG_ERROR_PATTERNS = [
  'Something went wrong', 'went wrong', 'Generation failed',
  'Image generation failed', 'Video generation failed',
  'Failed to generate', 'Error occurred', 'Try again',
  'เกิดข้อผิดพลาด', 'สร้างวิดีโอไม่ได้', 'สร้างรูปไม่ได้',
  'สร้างรูปภาพไม่ได้', 'ไม่สามารถสร้าง', 'โปรดลองอีกครั้ง',
  'การสร้างล้มเหลว', 'มีผู้ต้องการใช้งานเป็นจำนวนมาก',
];

async function getFlowGenerationWatchdogSnapshot(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [FLOW_GENERATION_WATCHDOG_ERROR_PATTERNS],
    func: (errorPatterns) => {
      const isVisible = (el) => {
        if (!el || typeof el.getBoundingClientRect !== 'function') return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };
      const textOf = (el) => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
      const directText = (el) => Array.from(el?.childNodes || [])
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => String(n.textContent || '').trim()).filter(Boolean).join(' ').trim();
      const owningTile = (el) => el?.closest?.('flow-grid-tile-container, [data-tile-id]')
        || el?.closest?.('button[roledescription="draggable"], [role="button"][roledescription="draggable"]')
        || el?.closest?.('[data-index]') || null;
      const tileIsFailed = (tile) => Boolean(tile && /\bFailed\b|สร้างไม่สำเร็จ|Generation failed/i.test(textOf(tile)));
      const belongsToFailedTile = (el) => {
        let cur = el;
        for (let d = 0; cur && cur !== document.body && d < 12; d++) {
          const r = cur.getBoundingClientRect?.();
          if (r && r.width >= 120 && r.width <= Math.min(720, window.innerWidth * 0.7)
              && r.height >= 120 && r.height <= Math.min(900, window.innerHeight * 0.94)
              && /\bFailed\b|สร้างไม่สำเร็จ|Generation failed/i.test(textOf(cur))) return true;
          cur = cur.parentElement;
        }
        return false;
      };

      // Tile counting
      const explicitTiles = Array.from(document.querySelectorAll('flow-grid-tile-container, [data-tile-id]'))
        .filter(t => !t.parentElement?.closest?.('flow-grid-tile-container, [data-tile-id]'));
      const draggableTiles = Array.from(document.querySelectorAll(
        'button[roledescription="draggable"], [role="button"][roledescription="draggable"]'
      )).filter(t => !t.querySelector('flow-grid-tile-container, [data-tile-id]'));
      const tileNodes = Array.from(new Set([...explicitTiles, ...draggableTiles]));

      const failedTiles = [];
      const failedTileKeys = [];
      for (const tile of tileNodes) {
        if (!isVisible(tile)) continue;
        if (tileIsFailed(tile)) {
          failedTiles.push(textOf(tile).slice(0, 220) || 'Failed Generation');
          const key = tile.getAttribute('data-tile-id') || tile.getAttribute('data-index')
            || tile.getAttribute('data-omnipost-tile-key')
            || (tile.matches?.('flow-grid-tile-container') ? (tile.setAttribute('data-omnipost-tile-key', 'modern:' + crypto.randomUUID()), tile.getAttribute('data-omnipost-tile-key')) : '');
          if (key && !failedTileKeys.includes(key)) failedTileKeys.push(key);
        }
      }

      // Progress detection
      const progressTexts = [];
      let queuedCount = 0;
      let creatingCount = 0;
      let spinningCount = 0;
      const statusSel = 'div, span, p, h1, h2, h3, h4, button, [role="status"], [aria-live]';
      for (const el of document.querySelectorAll(statusSel)) {
        if (!isVisible(el)) continue;
        const dt = directText(el);
        if (/^Queued$/i.test(dt) && !belongsToFailedTile(el)) queuedCount++;
        if (/^Creating scene\b|^กำลังสร้างฉาก/i.test(dt) && !belongsToFailedTile(el)) creatingCount++;
        if (/^\d{1,3}\s?%$/.test(dt) && Number.parseInt(dt, 10) < 100 && !belongsToFailedTile(el)) progressTexts.push(dt);
      }
      for (const icon of document.querySelectorAll('i, mat-icon, .material-icons, .material-symbols-outlined')) {
        if (!isVisible(icon)) continue;
        if (String(icon.textContent || '').trim().toLowerCase() === 'progress_activity' && !belongsToFailedTile(icon)) spinningCount++;
      }

      // Blur-based progress (only active while blur > 0.5px and pct < 95)
      let blurProgress = -1;
      if (progressTexts.length === 0) {
        for (const blurEl of document.querySelectorAll('[style*="--blur-amount"], [style*="blur"]')) {
          if (!isVisible(blurEl) || belongsToFailedTile(blurEl)) continue;
          const style = blurEl.getAttribute('style') || '';
          const match = style.match(/--blur-amount\s*:\s*([\d.]+)/) || style.match(/blur\(\s*([\d.]+)/);
          if (match) {
            const rawBlur = parseFloat(match[1]);
            // When rawBlur <= 0.5, the image has finished unblurring / rendering.
            if (rawBlur > 0.5) {
              const pct = Math.max(0, Math.min(94, Math.round((1 - rawBlur / 10) * 100)));
              if (pct > blurProgress) blurProgress = pct;
            }
          }
        }
      }

      // Error text detection
      let errorText = '';
      for (const el of document.querySelectorAll('div, span, p, h1, h2, h3, [role="alert"], [aria-live]')) {
        if (!isVisible(el)) continue;
        const t = textOf(el);
        if (!t || t.length > 260) continue;
        const lower = t.toLowerCase();
        if (errorPatterns.some(p => lower.includes(String(p).toLowerCase()))) { errorText = t; break; }
      }

      // Count media
      const videos = Array.from(document.querySelectorAll('video'))
        .map(v => v.src || v.querySelector('source')?.src || '').filter(s => /^https?:/i.test(s));
      const images = Array.from(document.querySelectorAll('img'))
        .filter(img => {
          const src = String(img.currentSrc || img.src || '');
          return isVisible(img) && Boolean(owningTile(img))
            && Number(img.naturalWidth || 0) >= 128 && Number(img.naturalHeight || 0) >= 128
            && /^(https?:|blob:|data:image\/)/i.test(src)
            && !/avatar|profile|icon|logo|sprite|emoji|favicon/i.test(src);
        }).map(img => img.currentSrc || img.src).filter((s, i, a) => Boolean(s) && a.indexOf(s) === i);

      const tileKeys = tileNodes.filter(isVisible).map(tile => {
        return tile.getAttribute('data-tile-id') || tile.getAttribute('data-index')
          || tile.getAttribute('data-omnipost-tile-key')
          || (tile.matches?.('flow-grid-tile-container') ? (tile.setAttribute('data-omnipost-tile-key', 'modern:' + crypto.randomUUID()), tile.getAttribute('data-omnipost-tile-key')) : '');
      }).filter(Boolean);

      return {
        failedCount: failedTiles.length, failedReason: failedTiles[0] || '', failedTileKeys, errorText,
        isGenerating: progressTexts.length > 0 || queuedCount > 0 || creatingCount > 0 || spinningCount > 0 || (blurProgress >= 0 && blurProgress < 95),
        progress: progressTexts[0] || (blurProgress >= 0 ? `${blurProgress}%` : ''),
        queuedCount, creatingCount, spinningCount,
        imageCount: images.length, videoCount: videos.length, videoUrls: videos, tileKeys, blurProgress,
      };
    },
  });
  return result?.result || {};
}

async function normalizeFlowProjectUiBg(tabId) {
  try {
    const tabInfo = await chrome.tabs.get(tabId).catch(() => null);
    if (!tabInfo?.url || !tabInfo.url.includes('/project/')) {
      return { success: true, skipped: true };
    }
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const isVisible = (el) => {
          if (!el || typeof el.getBoundingClientRect !== 'function') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0
            && rect.bottom > 0 && rect.right > 0
            && rect.top < window.innerHeight && rect.left < window.innerWidth;
        };
        const heavyClick = (el) => {
          if (!el) return;
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          el.click();
        };
        const hasAgentPanelText = (el) => {
          let node = el;
          for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
            const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
            if (text.includes('Untitled session')
              || text.includes('What would you like to do?')
              || text.includes('Hi Kubdee')
              || text.includes('Hi OmniPost')
              || (text.includes('History') && text.includes('New session'))) {
              return true;
            }
          }
          return false;
        };
        const findAgentPanelCloseButton = () => {
          const buttons = Array.from(document.querySelectorAll('button')).filter(isVisible);
          for (const btn of buttons) {
            const iconText = Array.from(btn.querySelectorAll('i, mat-icon, .google-symbols, .material-symbols-outlined'))
              .map((icon) => (icon.textContent || '').trim().toLowerCase())
              .find(Boolean);
            const text = (btn.textContent || '').trim().toLowerCase();
            const label = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
            if (('close' === iconText || 'close' === text || 'close' === label)
              && hasAgentPanelText(btn)) {
              return btn;
            }
          }
          return null;
        };
        const findAgentButton = () => {
          for (const btn of document.querySelectorAll('button[aria-pressed]')) {
            if (!isVisible(btn)) continue;
            if (btn.closest('[role="menu"]') || btn.closest('[role="dialog"]')) continue;
            const span = btn.querySelector('span.content, span');
            if (span && 'Agent' === (span.textContent || '').trim()) return btn;
            if ('Agent' === (btn.textContent || '').trim()) return btn;
          }
          return null;
        };

        let closedPanel = false;
        for (let i = 0; i < 3; i++) {
          const closeBtn = findAgentPanelCloseButton();
          if (!closeBtn) {
            if (i > 0) closedPanel = true;
            break;
          }
          heavyClick(closeBtn);
          await sleep(600);
        }

        let disabledAgent = false;
        const agentBtn = findAgentButton();
        if (agentBtn && 'true' === agentBtn.getAttribute('aria-pressed')) {
          heavyClick(agentBtn);
          await sleep(800);
          disabledAgent = true;
        }

        return { success: true, closedPanel, disabledAgent };
      },
    }).catch(() => [null]);
    return result?.result || { success: false };
  } catch (_) {
    return { success: false };
  }
}

async function clearAcceptedGoogleFlowPrompt(tabId, kind = 'image') {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [kind],
    func: async (mediaKind) => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const isVisible = (el) => {
        if (!el?.getBoundingClientRect) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };
      const getEditor = () => Array.from(document.querySelectorAll(
        '[data-slate-editor="true"][contenteditable="true"], textarea, [contenteditable="true"][role="textbox"]'
      )).find(isVisible) || null;
      const getEditorText = (editor = getEditor()) => String(editor?.value ?? editor?.innerText ?? editor?.textContent ?? '').trim();
      const buttonLabel = (btn) => String([
        btn?.getAttribute?.('aria-label'), btn?.getAttribute?.('title'),
        btn?.innerText, btn?.textContent,
      ].filter(Boolean).join(' ')).replace(/\s+/g, ' ').trim().toLowerCase();

      const findClearPromptButton = () => {
        const buttons = Array.from(document.querySelectorAll('button')).filter(b => isVisible(b) && !b.disabled);
        return buttons.find(b => /clear\s*(?:the\s*)?prompt|ล้าง\s*(?:prompt|พรอมต์|คำสั่ง)/i.test(buttonLabel(b)))
          || buttons.find(b => {
            const icons = Array.from(b.querySelectorAll('i, mat-icon, .material-icons, .material-symbols-outlined'))
              .map(i => String(i.textContent || '').trim().toLowerCase());
            const spans = Array.from(b.querySelectorAll('span')).map(s => String(s.textContent || '').trim().toLowerCase()).join(' ');
            return icons.includes('close') && /clear\s*prompt|ล้าง\s*(?:prompt|พรอมต์|คำสั่ง)/i.test(spans);
          }) || null;
      };

      const clickBtn = async (btn) => {
        btn.scrollIntoView({ behavior: 'instant', block: 'center' });
        btn.focus?.();
        const rect = btn.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', button: 0, buttons: 1, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
        try { btn.dispatchEvent(new PointerEvent('pointerdown', opts)); btn.dispatchEvent(new MouseEvent('mousedown', opts)); await sleep(45); btn.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 })); btn.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 })); } catch (_) {}
        try { btn.click(); } catch (_) {}
      };

      const initialEditor = getEditor();
      if (!initialEditor) return { ok: true, cleared: true, method: 'already_empty', kind: mediaKind };
      const initialClear = findClearPromptButton();
      if (!getEditorText(initialEditor) && !initialClear) return { ok: true, cleared: true, method: 'already_empty', kind: mediaKind };

      for (let attempt = 0; attempt < 12; attempt++) {
        const clearBtn = attempt === 0 ? initialClear : findClearPromptButton();
        if (clearBtn) {
          await clickBtn(clearBtn);
          for (let c = 0; c < 10; c++) {
            await sleep(200);
            if (!getEditorText()) return { ok: true, cleared: true, method: 'clear_prompt_button', kind: mediaKind };
          }
        }
        await sleep(250);
      }

      // Also clear any lingering chips in flow-ingredient-bar
      try {
        const chipButtons = Array.from(document.querySelectorAll('flow-prompt-box flow-ingredient-bar button, flow-prompt-box flow-ingredient-bar [role="button"]'))
          .filter(b => isVisible(b) && (/remove|delete|close|clear|ลบ|ปิด/i.test(buttonLabel(b)) || Array.from(b.querySelectorAll('i, mat-icon')).some(i => (i.textContent || '').trim() === 'close')));
        for (const cb of chipButtons) {
          await clickBtn(cb);
          await sleep(150);
        }
      } catch (_) {}

      // Fallback: select all + delete in editor
      const editor = getEditor();
      if (!editor) return { ok: true, cleared: true, method: 'editor_removed', kind: mediaKind };
      try {
        editor.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(300);
        if (!getEditorText()) return { ok: true, cleared: true, method: 'fallback_selectAll_delete', kind: mediaKind };
      } catch (_) {}
      return { ok: true, cleared: false, reason: 'clear_control_not_ready', kind: mediaKind };
    },
  });
  return result?.result || { ok: true, cleared: false, reason: 'script_failed' };
}

async function fetchGeneratedImageFromFlowOnce(tabId, timeoutMs = 180000) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [timeoutMs],
    func: async (timeoutMs) => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const toDataUrl = (blob) => new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
      });
      const isVisible = (el) => {
        if (!el || typeof el.getBoundingClientRect !== 'function') return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const owningTile = (el) => el?.closest?.('flow-grid-tile-container, [data-tile-id]')
        || el?.closest?.('button[roledescription="draggable"], [role="button"][roledescription="draggable"]')
        || el?.closest?.('[data-index]') || null;
      const tileIsFailed = (tile) => Boolean(tile && /\bFailed\b|สร้างไม่สำเร็จ|Generation failed/i.test(
        String(tile?.innerText || tile?.textContent || '').replace(/\s+/g, ' ').trim()
      ));
      const belongsToFailed = (el) => {
        let cur = el;
        for (let d = 0; cur && cur !== document.body && d < 12; d++) {
          const r = cur.getBoundingClientRect?.();
          if (r && r.width >= 120 && r.width <= Math.min(720, window.innerWidth * 0.7)
              && r.height >= 120 && /\bFailed\b|สร้างไม่สำเร็จ|Generation failed/i.test(
                String(cur?.innerText || cur?.textContent || '').trim()
              )) return true;
          cur = cur.parentElement;
        }
        return false;
      };
      const hasActiveProgress = () => {
        for (const el of document.querySelectorAll('div, span, p, [role="status"], [aria-live]')) {
          if (!isVisible(el) || belongsToFailed(el)) continue;
          const dt = Array.from(el.childNodes || []).filter(n => n.nodeType === Node.TEXT_NODE)
            .map(n => String(n.textContent || '').trim()).filter(Boolean).join(' ').trim();
          if (/^Queued$/i.test(dt) || /^Creating scene/i.test(dt) || /^กำลังสร้างฉาก/i.test(dt)) return true;
          if (/^\d{1,3}\s?%$/.test(dt) && Number.parseInt(dt, 10) < 100) return true;
        }
        for (const icon of document.querySelectorAll('i, mat-icon, .material-icons, .material-symbols-outlined')) {
          if (!isVisible(icon) || belongsToFailed(icon)) continue;
          if (String(icon.textContent || '').trim().toLowerCase() === 'progress_activity') return true;
        }
        for (const blurEl of document.querySelectorAll('[style*="--blur-amount"], [style*="blur"]')) {
          if (!isVisible(blurEl) || belongsToFailed(blurEl)) continue;
          const match = (blurEl.getAttribute('style') || '').match(/--blur-amount\s*:\s*([\d.]+)/) || (blurEl.getAttribute('style') || '').match(/blur\(\s*([\d.]+)/);
          if (match && parseFloat(match[1]) > 0.5) return true;
        }
        return false;
      };

      // Snapshot initial images
      const initialImgs = new Set();
      document.querySelectorAll('img').forEach(img => {
        const src = String(img.currentSrc || img.src || '');
        if (/^(https?:|blob:|data:image\/)/i.test(src)
            && Number(img.naturalWidth || 0) >= 64 && Number(img.naturalHeight || 0) >= 64
            && !/avatar|profile|icon|logo|sprite|emoji|favicon|\.svg/i.test(src)) initialImgs.add(src);
      });

      const started = Date.now();
      let lastProgressAt = Date.now();
      const collected = [];

      while (Date.now() - started < timeoutMs && collected.length === 0) {
        await sleep(2000);
        const active = hasActiveProgress();
        if (active) { lastProgressAt = Date.now(); }

        // Check for new images (broad search — not only in tile containers)
        for (const img of document.querySelectorAll('img')) {
          const src = String(img.currentSrc || img.src || '');
          const tile = owningTile(img);
          const inMainArea = img.closest('[role="main"], main, .content-area, flow-canvas') || !img.closest('nav, header, [role="navigation"], [role="banner"]');
          const eligible = (tile || inMainArea) && isVisible(img) && (!tile || !tileIsFailed(tile))
            && /^(https?:|blob:|data:image\/)/i.test(src)
            && Number(img.naturalWidth || 0) >= 64 && Number(img.naturalHeight || 0) >= 64
            && !/avatar|profile|icon|logo|sprite|emoji|favicon|\.svg/i.test(src);
          if (eligible && !initialImgs.has(src)) {
            if (collected.some(c => c.url === src)) continue;
            try {
              const resp = await fetch(src, { credentials: 'include' });
              const blob = await resp.blob();
              if (blob.size > 1024 * 5 && blob.type.startsWith('image/')) {
                collected.push({ url: src, dataUrl: await toDataUrl(blob), type: blob.type });
              }
            } catch (_) {}
          }
        }
        if (collected.length > 0) break;

        // Failure detection
        const failedTile = Array.from(document.querySelectorAll('flow-grid-tile-container, [data-tile-id]'))
          .filter(t => !t.parentElement?.closest?.('flow-grid-tile-container'))
          .find(t => isVisible(t) && tileIsFailed(t));
        if (failedTile && !active && Date.now() - lastProgressAt >= 12000) {
          return { ok: false, reason: 'flow_generation_failed' };
        }
      }
      if (collected.length > 0) return { ok: true, images: collected };
      return { ok: false, reason: 'timeout_waiting_for_images' };
    }
  });
  return result?.result || { ok: false, reason: 'empty_result' };
}

async function openFlowNewProject(tabId, broadcast = null) {
  const log = (msg) => {
    if (typeof broadcast === 'function') {
      broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: msg } });
    }
  };

  log('📁 กำลังเปิดหน้าหลัก Google Flow เพื่อสร้าง New Project...');

  // 1. Navigate tab to Google Flow home (forces leaving current project)
  await chrome.tabs.update(tabId, { url: 'https://flow.google.com/', active: true });
  const navStart = Date.now();
  while (Date.now() - navStart < 25000) {
    await new Promise(r => setTimeout(r, 600));
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (t?.status === 'complete' && !String(t.url || '').includes('/project/')) break;
  }
  await new Promise(r => setTimeout(r, 800));

  // 2. Reload home page to wipe any stale Angular/React caches & detached inputs
  log('🔄 รีเฟรชหน้า Flow เคลียร์แคชระบบ...');
  await chrome.tabs.reload(tabId);
  const reloadStart = Date.now();
  while (Date.now() - reloadStart < 25000) {
    await new Promise(r => setTimeout(r, 600));
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (t?.status === 'complete') break;
  }
  await new Promise(r => setTimeout(r, 1200));

  // 3. Click "+ New project" on the home page (OmniPost Hub battle-tested logic)
  log('🆕 กดปุ่ม New project...');
  const deadline = Date.now() + 35000;
  let clicked = false;
  while (Date.now() < deadline && !clicked) {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const visible = (el) => {
          if (!el?.getBoundingClientRect) return false;
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 20 && r.height > 20 && s.display !== 'none' && s.visibility !== 'hidden';
        };
        const allDeep = (root = document, out = []) => {
          for (const el of root.querySelectorAll('*')) {
            out.push(el);
            if (el.shadowRoot) allDeep(el.shadowRoot, out);
          }
          return out;
        };
        const normalize = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const seen = new Set();
        const candidates = allDeep().map(el => {
          if (!visible(el)) return null;
          const text = normalize([el.innerText, el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' '));
          const isMatch = text === 'new project' || text === '+ new project' || text.includes('new project') || text.includes('โปรเจ็กต์ใหม่') || text.includes('โปรเจคใหม่') || text.includes('สร้างโปรเจกต์');
          if (!isMatch) return null;
          const target = el.matches('button, a, [role="button"], [tabindex]') ? el : el.closest('button, a, [role="button"], [tabindex]');
          if (!target || seen.has(target) || !visible(target)) return null;
          seen.add(target);
          return { target, exact: text === 'new project' || text === '+ new project', isButton: target.tagName === 'BUTTON' };
        }).filter(Boolean);

        candidates.sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.isButton) - Number(a.isButton));
        const chosen = candidates[0]?.target;
        if (!chosen || chosen.disabled) return { ok: false };
        chosen.scrollIntoView({ block: 'center', inline: 'center' });
        chosen.focus?.();
        chosen.click();
        return { ok: true };
      }
    }).catch(() => [null]);

    if (res?.result?.ok) {
      clicked = true;
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  // 4. Wait for URL to navigate to /project/
  const projNavStart = Date.now();
  while (Date.now() - projNavStart < 25000) {
    await new Promise(r => setTimeout(r, 600));
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (String(t?.url || '').includes('/project/') && t.status === 'complete') break;
  }

  // 5. Wait for composer (flow-prompt-box) & dismiss welcome popups
  for (let ci = 0; ci < 25; ci++) {
    const [chk] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        for (const label of ['Get started', 'เริ่มต้น', 'close', 'ปิด', 'Got it', 'เข้าใจแล้ว', 'Dismiss', 'OK', 'Agree', 'ยอมรับ']) {
          const btns = Array.from(document.querySelectorAll('button')).filter(b => b.getBoundingClientRect().width > 0);
          const popup = btns.find(b => (b.textContent || '').trim().toLowerCase().includes(label.toLowerCase()));
          if (popup) try { popup.click(); } catch (_) {}
        }
        return Boolean(document.querySelector('flow-prompt-box'));
      }
    }).catch(() => [null]);
    if (chk?.result) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  await new Promise(r => setTimeout(r, 1000));
  await normalizeFlowProjectUiBg(tabId);

  // 6. Inject OmniPost Battle-Tested Engine Assets into MAIN world
  log('⚡ เชื่อมต่อ OmniPost Hub Engine เข้าโปรเจกต์ใหม่...');
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: [
      'scripts/flowMediaInterceptor.js',
      'scripts/flowSite.js',
      'scripts/flowImageMode.js',
      'scripts/flowModernVideo.js',
      'scripts/flowModernReference.js'
    ]
  }).catch(() => {});
  await new Promise(r => setTimeout(r, 800));

  return true;
}

/* ─── Local Video Composer (FFmpeg WASM via Offscreen Document) ────────── */

const OFFSCREEN_COMPOSER_PATH = 'offscreen.html';
let offscreenComposerInitPromise = null;

async function hasOffscreenComposerDocument() {
  if (chrome.offscreen?.hasDocument) {
    try {
      return await chrome.offscreen.hasDocument();
    } catch (_) {}
  }
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_COMPOSER_PATH);
  try {
    if (typeof clients !== 'undefined' && clients?.matchAll) {
      const matchedClients = await clients.matchAll({
        includeUncontrolled: true,
        type: 'window',
      });
      return matchedClients.some(client => client.url === offscreenUrl);
    }
  } catch (_) {}
  return false;
}

async function ensureOffscreenComposerDocument() {
  if (!chrome.offscreen?.createDocument) return;
  if (offscreenComposerInitPromise) {
    await offscreenComposerInitPromise;
    return;
  }

  offscreenComposerInitPromise = (async () => {
    const exists = await hasOffscreenComposerDocument();
    if (exists) return;
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_COMPOSER_PATH,
        reasons: ['BLOBS', 'DOM_SCRAPING'],
        justification: 'Local FFmpeg WASM video composition and merging',
      });
      console.log('🎬 [PhimBot] Offscreen composer document created');
    } catch (e) {
      if (!String(e?.message || '').includes('already exists')) {
        console.error('❌ [PhimBot] Error creating offscreen composer:', e);
        throw e;
      }
    }
  })();

  try {
    await offscreenComposerInitPromise;
  } finally {
    offscreenComposerInitPromise = null;
  }
}

async function closeOffscreenComposerDocument() {
  if (!chrome.offscreen?.closeDocument) return;
  const exists = await hasOffscreenComposerDocument();
  if (!exists) return;
  try {
    await chrome.offscreen.closeDocument();
    console.log('🎬 [PhimBot] Offscreen composer document closed');
  } catch (_) {}
}

async function composeVideoScenesViaOffscreen(videoList, options = {}) {
  if (!Array.isArray(videoList) || videoList.length === 0) {
    throw new Error('no_videos_to_compose');
  }
  if (videoList.length === 1) {
    return { ok: true, dataUrl: videoList[0], mimeType: 'video/mp4' };
  }

  await ensureOffscreenComposerDocument();

  // Allow offscreen to stabilize
  await new Promise(r => setTimeout(r, 500));

  const jobId = `compose_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  console.log(`🎬 [PhimBot] Sending compose request for ${videoList.length} scenes (jobId=${jobId})...`);

  const response = await new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      action: 'PHIMBOT_COMPOSE_VIDEOS',
      jobId,
      videos: videoList,
      options: {
        width: 720,
        height: 1280,
        fps: 30,
        crf: 23,
        mode: 'concat',
        ...options,
      }
    }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message || 'offscreen_communication_error'));
      } else {
        resolve(res);
      }
    });
  });

  if (!response?.ok) {
    throw new Error(response?.reason || 'video_composition_failed');
  }

  return response;
}

/* ─── Message Router ──────────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type || message?.action;
  const payload = message?.payload ?? message;

  const handle = async () => {
    try {
      switch (type) {
        case 'PHIMBOT_POST_NOW': {
          const result = await postSingleVideo(payload);
          sendResponse(result);
          break;
        }
        case 'PHIMBOT_ADD_TO_QUEUE': {
          const queue = await getQueue();
          const job = {
            ...payload,
            id: payload.id || `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            status: 'pending',
            createdAt: payload.createdAt || new Date().toISOString(),
            error: null,
          };
          queue.push(job);
          await saveQueue(queue);
          sendResponse({ success: true, queue, job });
          break;
        }
        case 'PHIMBOT_REMOVE_FROM_QUEUE': {
          let queue = await getQueue();
          queue = queue.filter((item) => item.id !== payload?.id);
          await saveQueue(queue);
          sendResponse({ success: true, queue });
          break;
        }
        case 'PHIMBOT_RETRY_QUEUE_ITEM': {
          const queue = await getQueue();
          const item = queue.find((it) => it.id === payload?.id);
          if (!item) {
            sendResponse({ success: false, error: 'Item not found' });
            break;
          }
          item.status = 'pending';
          item.error = null;
          // Auto-adjust schedule time if it has expired or is too close (< 16 mins ahead)
          if (item.scheduledAt) {
            const schedMs = new Date(item.scheduledAt).getTime();
            const minAllowed = Date.now() + 16 * 60000;
            if (!Number.isFinite(schedMs) || schedMs < minAllowed) {
              const newTarget = new Date(Date.now() + 20 * 60000);
              newTarget.setMinutes(Math.ceil(newTarget.getMinutes() / 5) * 5);
              newTarget.setSeconds(0);
              newTarget.setMilliseconds(0);
              item.scheduledAt = newTarget.toISOString();
              item.scheduleDate = `${newTarget.getFullYear()}-${String(newTarget.getMonth() + 1).padStart(2, '0')}-${String(newTarget.getDate()).padStart(2, '0')}`;
              item.scheduleTime = `${String(newTarget.getHours()).padStart(2, '0')}:${String(newTarget.getMinutes()).padStart(2, '0')}`;
            }
          }
          await saveQueue(queue);
          broadcast({ type: 'PHIMBOT_QUEUE_PROGRESS', payload: { status: 'updated', queue } });
          sendResponse({ success: true, item, queue });
          break;
        }
        case 'PHIMBOT_RETRY_ALL_FAILED': {
          const queue = await getQueue();
          let count = 0;
          let offsetMin = 20;
          for (const item of queue) {
            if (item.status === 'error') {
              item.status = 'pending';
              item.error = null;
              count++;
              // Auto-adjust schedule time if expired
              if (item.scheduledAt) {
                const schedMs = new Date(item.scheduledAt).getTime();
                const minAllowed = Date.now() + 16 * 60000;
                if (!Number.isFinite(schedMs) || schedMs < minAllowed) {
                  const newTarget = new Date(Date.now() + offsetMin * 60000);
                  newTarget.setMinutes(Math.ceil(newTarget.getMinutes() / 5) * 5);
                  newTarget.setSeconds(0);
                  newTarget.setMilliseconds(0);
                  item.scheduledAt = newTarget.toISOString();
                  item.scheduleDate = `${newTarget.getFullYear()}-${String(newTarget.getMonth() + 1).padStart(2, '0')}-${String(newTarget.getDate()).padStart(2, '0')}`;
                  item.scheduleTime = `${String(newTarget.getHours()).padStart(2, '0')}:${String(newTarget.getMinutes()).padStart(2, '0')}`;
                  offsetMin += 15;
                }
              }
            }
          }
          if (count > 0) {
            await saveQueue(queue);
            broadcast({ type: 'PHIMBOT_QUEUE_PROGRESS', payload: { status: 'updated', queue } });
          }
          sendResponse({ success: true, count, queue });
          break;
        }
        case 'PHIMBOT_CLEAR_QUEUE': {
          isQueuePaused = true;
          isQueueRunning = false;
          currentQueueAbort?.abort();
          if (currentActivePostTabId) {
            safeCloseTab(currentActivePostTabId).catch(() => {});
            currentActivePostTabId = null;
          }
          await saveQueue([]);
          broadcast({ type: 'PHIMBOT_QUEUE_PROGRESS', payload: { status: 'stopped', queue: [] } });
          sendResponse({ success: true, queue: [] });
          break;
        }
        case 'PHIMBOT_GET_QUEUE': {
          sendResponse({ success: true, queue: await getQueue() });
          break;
        }
        case 'PHIMBOT_START_QUEUE': {
          if (isQueueRunning) { sendResponse({ success: false, error: 'Queue already running' }); }
          else { processQueue(); sendResponse({ success: true }); }
          break;
        }
        case 'PHIMBOT_PAUSE_QUEUE': {
          if (!isQueueRunning) { sendResponse({ success: false, error: 'Queue not running' }); }
          else {
            isQueuePaused = true;
            isQueueRunning = false;
            currentQueueAbort?.abort();
            if (currentActivePostTabId) {
              safeCloseTab(currentActivePostTabId).catch(() => {});
              currentActivePostTabId = null;
            }
            const q = await getQueue();
            let changed = false;
            for (const it of q) {
              if (it.status === 'processing') {
                it.status = 'pending';
                changed = true;
              }
            }
            if (changed) await saveQueue(q);
            broadcast({ type: 'PHIMBOT_QUEUE_PROGRESS', payload: { status: 'paused', queue: await getQueue() } });
            sendResponse({ success: true });
          }
          break;
        }
        case 'PHIMBOT_TIKTOK_POST_PROGRESS': {
          broadcast({ type: 'PHIMBOT_TIKTOK_POST_PROGRESS', payload });
          sendResponse({ success: true });
          break;
        }
        case 'PHIMBOT_GET_SETTINGS': {
          const { phimbot_settings = DEFAULT_SETTINGS } = await storageGet('phimbot_settings');
          sendResponse({ success: true, settings: phimbot_settings });
          break;
        }
        case 'PHIMBOT_SAVE_SETTINGS': {
          const { phimbot_settings: existing = DEFAULT_SETTINGS } = await storageGet('phimbot_settings');
          const merged = { ...existing, ...payload };
          await storageSet({ phimbot_settings: merged });
          sendResponse({ success: true, settings: merged });
          break;
        }
        case 'PHIMBOT_AI_REQUEST':
        case 'PHIMBOT_AI_GENERATE': {
          const reqPayload = payload || message;
          const result = await callOpenRouter(reqPayload);
          sendResponse(result);
          break;
        }
        case 'PHIMBOT_GET_QUEUE_STATUS': {
          sendResponse({ success: true, isRunning: isQueueRunning, isPaused: isQueuePaused });
          break;
        }
        case 'PHIMBOT_SAVE_API_KEY': {
          await storageSet({ openrouter_api_key: payload.apiKey, phimbot_gemini_key: payload.geminiKey, openrouter_model: payload.model, phimbot_api_provider: payload.apiProvider });
          sendResponse({ success: true });
          break;
        }
        case 'PHIMBOT_GET_API_CONFIG': {
          const config = await storageGet(['openrouter_api_key', 'phimbot_gemini_key', 'openrouter_model', 'phimbot_api_provider']);
          sendResponse({ success: true, apiKey: config.openrouter_api_key || '', geminiKey: config.phimbot_gemini_key || '', model: config.openrouter_model || 'google/gemini-2.5-flash', apiProvider: config.phimbot_api_provider || 'openrouter' });
          break;
        }
        case 'PHIMBOT_SAVE_QUEUE_DELAY': {
          await storageSet({ phimbot_queue_delay_min: Number(payload.delayMin) || 100, phimbot_queue_delay_max: Number(payload.delayMax) || 200 });
          sendResponse({ success: true });
          break;
        }
        
        case 'PHIMBOT_FETCH_SHOWCASE_API': {
          /* ─── Fetch TikTok Showcase products via API (no DOM scraping!) ─── */
          /* Learned from tiktok-autopilot-suite: step1_fetch_showcase.py */
          /* API: https://shop.tiktok.com/api/v1/streamer_desktop/showcase_product/list */
          try {
            const limit = payload?.limit || 50;
            const offset = payload?.offset || 0;
            console.log('[PhimBot] Fetching TikTok Showcase API, offset=' + offset + ', limit=' + limit);

            // Need a TikTok tab to execute fetch with cookies
            let tikTabs = await chrome.tabs.query({ url: ['*://*.tiktok.com/*'] });
            let tikTab = tikTabs.find((t) => t.url?.includes('tiktok.com'));
            if (!tikTab) {
              tikTab = await chrome.tabs.create({ url: 'https://www.tiktok.com/tiktokstudio/upload', active: false });
              await new Promise((res) => {
                const fn = (id, info) => { if (id === tikTab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(fn); res(); } };
                chrome.tabs.onUpdated.addListener(fn);
                setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); res(); }, 30000);
              });
              await delay(3000);
            }

            // Fetch all pages
            const allProducts = [];
            let currentOffset = offset;
            let totalInShowcase = 0;
            let hasMore = true;

            while (hasMore && allProducts.length < limit) {
              const batchSize = Math.min(50, limit - allProducts.length);
              const [result] = await chrome.scripting.executeScript({
                target: { tabId: tikTab.id },
                world: 'MAIN',
                func: async (fetchOffset, fetchCount) => {
                  try {
                    const res = await fetch(
                      'https://shop.tiktok.com/api/v1/streamer_desktop/showcase_product/list?offset=' + fetchOffset + '&count=' + fetchCount,
                      { credentials: 'include' }
                    );
                    return await res.json();
                  } catch (err) {
                    return { error: err.toString() };
                  }
                },
                args: [currentOffset, batchSize]
              });

              const apiData = result?.result;
              if (!apiData || apiData.error) {
                console.error('[PhimBot] Showcase API error:', apiData?.error);
                if (allProducts.length === 0) {
                  sendResponse({ success: false, error: 'ดึงข้อมูลไม่สำเร็จ กรุณาล็อกอิน TikTok ก่อน' });
                  return;
                }
                break;
              }

              const batchProducts = apiData?.data?.products || [];
              totalInShowcase = apiData?.data?.total || totalInShowcase;

              if (batchProducts.length === 0) break;

              // Convert to PhimBot product format
              for (const item of batchProducts) {
                const coverUrls = item.cover?.url_list || [];
                const imageUrls = (item.images || []).flatMap((img) => (img.url_list || []).slice(0, 1));
                const coverUrl = coverUrls[0] || imageUrls[0] || '';
                // Convert to HD: resize-jpeg:300:300 -> resize-jpeg:1080:1080
                const hdUrl = coverUrl.replace(/resize-jpeg:\d+:\d+/g, 'resize-jpeg:540:540');

                allProducts.push({
                  productId: item.product_id || '',
                  name: item.title || '',
                  imageUrl: hdUrl,
                  images: imageUrls.map((u) => u.replace(/resize-jpeg:\d+:\d+/g, 'resize-jpeg:1080:1080')),
                  price: 0,
                  status: 'showcase',
                  statusLabel: 'Showcase',
                  source: 'api',
                });
              }

              currentOffset += batchProducts.length;
              if (batchProducts.length < batchSize) hasMore = false;
            }

            // Save to storage
            await storageSet({ phimbot_products: allProducts });
            console.log('[PhimBot] Showcase API: fetched ' + allProducts.length + '/' + totalInShowcase + ' products');
            sendResponse({ success: true, products: allProducts, total: totalInShowcase });
          } catch (err) {
            console.error('[PhimBot] Showcase API fetch error:', err);
            sendResponse({ success: false, error: err.message });
          }
          break;
        }
        case 'PHIMBOT_GET_PRODUCTS': {
          const data = await storageGet('phimbot_products');
          sendResponse({ success: true, products: data.phimbot_products || [] });
          break;
        }
        case 'PHIMBOT_SCAN_PRODUCTS': {
          try {
            const scanTabs = await chrome.tabs.query({ url: ['*://*.tiktok.com/*'] });
            let scanTab = scanTabs.find((t) => t.url?.includes('/tiktokstudio/'));
            if (!scanTab) {
              scanTab = await chrome.tabs.create({ url: 'https://www.tiktok.com/tiktokstudio/upload', active: true });
              await new Promise((res) => {
                const fn = (id, info) => { if (id === scanTab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(fn); res(); } };
                chrome.tabs.onUpdated.addListener(fn);
                setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); res(); }, 30000);
              });
              await delay(3000);
            }

            const scanResult = await chrome.scripting.executeScript({
              target: { tabId: scanTab.id },
              world: 'MAIN',
              func: async (scanOpts) => {
                /* All scanner logic inline — runs in TikTok page context */
                const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
                const txt = (v) => String(v == null ? '' : v).trim();
                const num = (v) => { if (typeof v === 'number' && Number.isFinite(v)) return v; const m = txt(v).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : 0; };
                const compNum = (v) => { const n = txt(v).replace(/,/g, '').toUpperCase(); const m = n.match(/(-?\d+(?:\.\d+)?)\s*([KMB]?)/); if (!m) return 0; return Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2]] || 1); };
                const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 3 && r.height > 3 && s.display !== 'none' && s.visibility !== 'hidden'; };
                const findBtn = (labels, root = document) => Array.from(root.querySelectorAll('button, [role="button"], [tabindex]')).filter(vis).find((b) => labels.some((l) => txt(b.textContent).toLowerCase().includes(l.toLowerCase())));
                const waitFor = async (factory, tms = 20000, ims = 300) => { const s = Date.now(); while (Date.now() - s < tms) { const r = factory(); if (r) return r; await sleep(ims); } return null; };
                const dedup = (items) => Array.from(new Map(items.filter(Boolean).map((i) => [i.productId, i])).values());
                const collectImgs = (root) => {
                  const c = [];
                  const elements = Array.from(root?.querySelectorAll?.('*') || []);
                  elements.forEach((el) => {
                    if (el.tagName === 'IMG' || el.tagName === 'SOURCE') {
                      [el.currentSrc, el.src, el.getAttribute('src'), el.getAttribute('data-src')].filter(Boolean).filter((u) => /^https?:\/\//i.test(u)).forEach((u) => c.push(u));
                    }
                    const bg = getComputedStyle(el).backgroundImage;
                    if (bg && bg !== 'none') {
                      const m = bg.match(/url\(['"]?(https?:\/\/[^'"]+)['"]?\)/i);
                      if (m && m[1]) c.push(m[1]);
                    }
                  });
                  return Array.from(new Set(c)).slice(0, 12);
                };

                /* Check if product rows already visible */
                const hasRows = () => Array.from(document.querySelectorAll('tbody tr')).some((r) => vis(r) && /\b(1[0-9]{12,}|[2-9][0-9]{12,})\b/.test(txt(r.innerText)));

                /* Try to open product modal if not visible */
                if (!hasRows()) {
                  const anchor = document.querySelector('[data-e2e="anchor_container"]');
                  const addLink = anchor ? (anchor.querySelector('.TUXButton') || findBtn(['เพิ่ม', 'Add'], anchor)) : findBtn(['Add link', 'เพิ่มลิงก์', 'เพิ่มสินค้า']);
                  if (addLink) { addLink.click(); await sleep(2000); }

                  const dd = document.querySelector('button[role="combobox"]');
                  if (dd && vis(dd) && !/สินค้า|Product/i.test(txt(dd.textContent))) {
                    dd.click(); await sleep(800);
                    const opt = Array.from(document.querySelectorAll('[role="option"]')).filter(vis).find((n) => /สินค้า|Product/i.test(txt(n.textContent)));
                    if (opt) { opt.click(); await sleep(600); }
                  }

                  const nxtBtn = findBtn(['ถัดไป', 'Next']);
                  if (nxtBtn) { nxtBtn.click(); await sleep(1500); }

                  const stabs = Array.from(document.querySelectorAll('.TUXTabBar-itemTitle, [role="tab"], button')).filter(vis);
                  const stab = stabs.find((n) => { const v = txt(n.textContent); return v === 'นำเสนอสินค้า' || v === 'Showcase products' || v.includes('Showcase'); });
                  if (stab) { stab.click(); await sleep(1000); }

                  await waitFor(hasRows, 30000, 500);
                }

                /* Find active product modal */
                const modal = () => Array.from(document.querySelectorAll('.TUXModal, .common-modal, [role="dialog"]')).filter(vis).sort((a, b) => b.querySelectorAll('tbody tr').length - a.querySelectorAll('tbody tr').length)[0] || document;

                /* Parse product rows */
                const parseRows = () => Array.from(modal().querySelectorAll('tbody tr')).filter((row) => vis(row) && /\b(1[0-9]{12,}|[2-9][0-9]{12,})\b/.test(txt(row.innerText))).map((row) => {
                  const rt = txt(row.innerText);
                  const idM = rt.match(/\b(1[0-9]{12,}|[2-9][0-9]{12,})\b/);
                  const pid = idM?.[1] || '';
                  if (!pid) return null;
                  const cells = Array.from(row.querySelectorAll(':scope > td')).filter((c) => txt(c.innerText) || c.querySelector('img'));
                  const pc = row.querySelector('.product-name')?.closest('td') || cells.find((c) => c.querySelector('img')) || cells[1] || row;
                  const pl = txt(pc.innerText).split('\n').map(txt).filter(Boolean);
                  const nm = txt(row.querySelector('.product-name')?.textContent) || pl.find((l) => !l.includes(pid) && !/^฿/.test(l) && !/^\d+(\.\d+)?$/.test(l)) || `TikTok ${pid}`;
                  const gl = collectImgs(pc);
                  const pt = txt(cells.find((c) => /฿|THB/i.test(c.innerText))?.innerText) || rt.match(/฿\s*[\d,.]+/)?.[0] || '';
                  const sl = txt(row.querySelector('.product-status')?.textContent) || txt(cells[cells.length - 1]?.innerText) || '';
                  const sc = cells.map((c) => txt(c.innerText)).filter((v) => /^\d[\d,.KMB]*$/i.test(v));
                  return { productId: pid, name: nm, imageUrl: gl[0] || '', galleryImages: gl, price: num(pt), stock: compNum(sc[sc.length - 1] || '0'), stockLabel: sc[sc.length - 1] || '', currency: 'THB', status: /ดำเนินอยู่|วางขาย|active|available/i.test(sl) ? 'active' : 'inactive', statusLabel: sl || '', scrapedAt: Date.now(), source: 'phimbot_scan' };
                }).filter(Boolean);

                /* Pagination helpers */
                const pgRoot = () => Array.from((modal() || document).querySelectorAll('[class*="pagination"], .tiktok-pagination, .arco-pagination')).filter((n) => vis(n) && /\d/.test(txt(n.textContent)))[0] || null;
                const aPage = () => txt((pgRoot() || document).querySelector('.tiktok-pagination-item-is-active, .arco-pagination-item-active, [aria-current="page"]')?.textContent) || '1';
                const findNextBtn = () => { const r = pgRoot(); if (!r) return null; for (const sel of ['.tiktok-pagination-item-right-arrow', '.arco-pagination-item-next', '[aria-label*="ถัด"]', '[aria-label*="Next"]']) { const el = r.querySelector(sel); if (el && vis(el) && !el.disabled) return el; } return Array.from(r.querySelectorAll('button, [role="button"]')).filter(vis).find((n) => /^(>|›|»|ถัดไป|next)$/i.test(txt(n.textContent))); };
                const goNext = async (pp, pf) => { const b = findNextBtn(); if (!b) return false; b.click(); for (let i = 0; i < 30; i++) { await sleep(250); const fi = parseRows()[0]?.productId || ''; if (aPage() !== pp || (fi && fi !== pf)) return true; } return false; };

                /* Main scan loop */
                const limit = Math.max(0, Math.min(5000, Number(scanOpts.limit) || 0));
                const all = [];
                const visited = new Set();
                for (let p = 0; p < 500; p++) {
                  const rows = await waitFor(() => { const r = parseRows(); return r.length ? r : null; }, 5000, 250) || [];
                  const pk = `${aPage()}:${rows[0]?.productId || ''}`;
                  if (!rows.length || visited.has(pk)) break;
                  visited.add(pk);
                  all.push(...rows);
                  const uq = dedup(all);
                  if ((limit && uq.length >= limit) || uq.length >= 5000) break;
                  const pp = aPage();
                  const pf = rows[0]?.productId || '';
                  if (!await goNext(pp, pf)) break;
                }
                const items = dedup(all).slice(0, limit || 5000);
                return { ok: items.length > 0, items, totalScanned: items.length, reason: items.length ? '' : 'no_products_found' };
              },
              args: [{ limit: payload?.limit || 0 }],
            });

            const scanData = scanResult?.[0]?.result || { ok: false, items: [], reason: 'no_result' };
            // Only keep active products (ดำเนินอยู่)
            if (scanData.items?.length) {
              scanData.items = scanData.items.filter((p) => p.status === 'active');
              scanData.totalScanned = scanData.items.length;
              scanData.ok = scanData.items.length > 0;
            }
            if (scanData.ok && scanData.items?.length) {
              const { phimbot_products = [] } = await storageGet('phimbot_products');
              const byId = new Map(phimbot_products.map((p) => [p.productId, p]));
              scanData.items.forEach((p) => byId.set(p.productId, p));
              await storageSet({ phimbot_products: Array.from(byId.values()) });
            }
            sendResponse({ success: scanData.ok, ...scanData });
          } catch (err) {
            console.error('[PhimBot] SCAN_PRODUCTS:', err);
            sendResponse({ success: false, error: err.message, items: [] });
          }
          break;
        }
        case 'PHIMBOT_GET_PRODUCTS': {
          const { phimbot_products = [] } = await storageGet('phimbot_products');
          sendResponse({ success: true, products: phimbot_products });
          break;
        }
        case 'PHIMBOT_CLEAR_PRODUCTS': {
          await storageSet({ phimbot_products: [] });
          sendResponse({ success: true });
          break;
        }
        case 'PHIMBOT_FETCH_IMAGE_BASE64': {
          try {
            const imgUrl = message.payload?.url || payload?.url || '';
            if (!imgUrl) { sendResponse({ success: false, error: 'no url' }); break; }
            const resp = await fetch(imgUrl);
            if (!resp.ok) { sendResponse({ success: false, error: `HTTP ${resp.status}` }); break; }
            const blob = await resp.blob();
            const reader = new FileReader();
            const base64 = await new Promise((resolve, reject) => {
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(blob);
            });
            sendResponse({ success: true, base64 });
          } catch (e) {
            sendResponse({ success: false, error: e.message });
          }
          break;
        }
        case 'PHIMBOT_GET_SHOPEE_PRODUCTS': {
          try {
            const stored = await chrome.storage.local.get(['phimbot_shopee_scan', 'phimbot_shopee_history']);
            // รวมสินค้าจากผลสแกน + ประวัติดึงลิ้งค์
            const scanItems = (stored.phimbot_shopee_scan?.items || [])
              .filter(item => item.affiliateUrl && !item.affiliateUrl.includes('affiliate.shopee.co.th'))
              .map(item => ({
              productId: item.offerId || `shopee_scan_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
              name: item.title || 'สินค้า Shopee',
              price: item.priceText || item.price || '',
              images: item.imageUrl ? [item.imageUrl] : (item.images || []),
              imageUrl: item.imageUrl || '',
              affiliateUrl: item.affiliateUrl || '',
              productUrl: item.offerUrl || item.productUrl || '',
              offerId: item.offerId || '',
              sold: item.soldText || item.sold || '',
              commissionRate: item.commissionText || item.commissionRate || '',
              platform: 'shopee',
              source: 'scan'
            }));
            const historyItems = (stored.phimbot_shopee_history || []).map(h => ({
              productId: h.productId || h.offerId || `shopee_${Date.now()}`,
              name: h.title || h.name || 'สินค้า Shopee',
              price: h.price || '',
              images: h.images || (h.imageUrl ? [h.imageUrl] : []),
              imageUrl: (h.images && h.images[0]) || h.imageUrl || '',
              affiliateUrl: h.affiliateUrl || '',
              productUrl: h.productUrl || h.url || '',
              platform: 'shopee',
              source: 'history'
            }));
            // Merge: scan first, then history (dedup by productId)
            const seen = new Set();
            const merged = [];
            for (const p of [...scanItems, ...historyItems]) {
              const key = (p.name || '').trim().toLowerCase() || p.productId;
              if (!seen.has(key)) { seen.add(key); merged.push(p); }
            }
            sendResponse({ success: true, products: merged });
          } catch (e) {
            sendResponse({ success: false, products: [], error: e.message });
          }
          break;
        }
        case 'PHIMBOT_GET_AFFILIATE_LINK': {
          const item = message.item || payload?.item || payload || {};
          const url = message.url || payload?.url || item.offerUrl || item.productUrl || item.url || '';
          let result = await getShopeeOfferAffiliateLink(item);
          if (!result || !result.ok || !isShopeeAffShortLink(result.affiliateUrl)) {
            const shortUrl = await resolveShopeeAffiliateShortLink(url, item);
            if (shortUrl && isShopeeAffShortLink(shortUrl)) {
              result = { ok: true, affiliateUrl: shortUrl };
            }
          }
          sendResponse(result || { ok: false, reason: 'cannot_resolve_shortlink' });
          break;
        }
        case 'PHIMBOT_FETCH_SHOPEE': {
          const url = message.url || payload?.url || payload;
          const result = await handleFetchShopee(url);
          sendResponse(result);
          break;
        }
        case 'PHIMBOT_POST_FB_REELS': {
          const result = await runFbReelsPost(message.payload || payload);
          sendResponse(result);
          break;
        }
        case 'PHIMBOT_POST_SHOPEE_VIDEO': {
          const result = await runShopeePost(message.payload || payload || message);
          sendResponse(result);
          break;
        }
        case 'PHIMBOT_SAVE_FB_REELS_MEDIA': {
          const mediaFiles = message.payload?.mediaFiles || payload?.mediaFiles;
          await chrome.storage.local.set({ phimbot_fb_reels_media: mediaFiles });
          sendResponse({ success: true });
          break;
        }

        /* ─── Video Factory Handlers ───────────────────────────────── */

        case 'PHIMBOT_BRAINSTORM_ADS': {
          const { productName, keywords, mode, ideaCount } = payload;
          const modeDesc = mode === 'influencer' ? 'แบบอินฟลูเอนเซอร์รีวิว (เห็นหน้าคนพูด)' : 'แบบเห็นเฉพาะมือหยิบจับสินค้า (Minimalist Hands)';
          const prompt = `สินค้า: ${productName}
คีย์เวิร์ด/จุดเด่น: ${keywords || 'ไม่มีข้อมูล'}
โหมดถ่ายทำ: ${modeDesc}
กรุณาคิดไอเดียวิดีโอโฆษณา TikTok จำนวน ${ideaCount || 1} รูปแบบที่แตกต่างกัน
แต่ละไอเดียต้องมี headline ที่ดึงดูดความสนใจใน 3 วินาทีแรก และ concept อธิบายแนวทางวิดีโอสั้นๆ
ตอบเป็น JSON Array เท่านั้น`;
          const result = await callOpenRouter({ action: 'brainstorm_ads', prompt, maxTokens: 4096 });
          if (result.success) {
            try {
              const ideas = extractJsonArray(result.text);
              sendResponse({ success: true, ideas });
            } catch (parseErr) {
              console.error('[PhimBot] Brainstorm parse error:', parseErr, 'Raw:', result.text);
              sendResponse({ success: true, text: result.text, parseError: true });
            }
          } else {
            sendResponse(result);
          }
          break;
        }

        case 'PHIMBOT_WRITE_SCRIPT': {
          const { headline, concept, sceneCount, productName: pName, keywords: kw, mode: scriptMode, voiceGender } = payload;
          const modeText = scriptMode === 'influencer' ? 'อินฟลูเอนเซอร์พูดต่อหน้ากล้อง' : 'เห็นเฉพาะมือหยิบจับสินค้า';
          const voiceText = voiceGender === 'male' ? 'ชาย' : 'หญิง';
          const prompt = `สินค้า: ${pName}
คีย์เวิร์ด: ${kw || '-'}
Headline: ${headline}
Concept: ${concept}
โหมด: ${modeText}
เพศเสียงพากย์: ${voiceText}

เขียนบทวิดีโอโฆษณา TikTok จำนวน ${sceneCount || 1} ฉาก
แต่ละฉากต้องมี:
- beat: ชื่อฉาก (เช่น "Hook", "ปัญหา", "โชว์สินค้า", "CTA")
- voiceover: บทพูดภาษาไทย (พูดเป็นธรรมชาติเหมือนอินฟลูฯ)
- overlay: ข้อความที่จะขึ้นบนจอ (สั้นๆ 3-5 คำ)
- visual: คำอธิบายฉากเป็นภาษาอังกฤษสำหรับ AI สร้างวิดีโอ (ละเอียด เน้นองค์ประกอบภาพ แสง มุมกล้อง)
ตอบเป็น JSON Array เท่านั้น`;
          const scriptResult = await callOpenRouter({ action: 'write_video_script', prompt, maxTokens: 4096 });
          if (scriptResult.success) {
            try {
              const scenes = extractJsonArray(scriptResult.text);
              sendResponse({ success: true, scenes });
            } catch (parseErr) {
              console.error('[PhimBot] Script parse error:', parseErr, 'Raw:', scriptResult.text);
              sendResponse({ success: true, text: scriptResult.text, parseError: true });
            }
          } else {
            sendResponse(scriptResult);
          }
          break;
        }

        case 'PHIMBOT_VAULT_SAVE': {
          try {
            const store = await chrome.storage.local.get(['phimbot_media_vault', 'phimbot_products']);
            const vault = store.phimbot_media_vault || [];
            const prods = Array.isArray(store.phimbot_products) ? store.phimbot_products : [];

            const rawLen = payload?.videoBase64 ? payload.videoBase64.length : 0;
            // ป้องกันการบันทึกซ้ำจากหลายช่องทาง (flow-automator + video-factory) ภายใน 60 วินาที
            if (rawLen > 50000) {
              const dup = vault.find(v =>
                v.videoBase64Size === rawLen &&
                v.createdAt &&
                (Date.now() - new Date(v.createdAt).getTime()) < 60000
              );
              if (dup) {
                console.log(`[PhimBot] vault_save: skipped duplicate video (${rawLen} chars, existing id=${dup.id})`);
                sendResponse({ success: true, item: dup, deduplicated: true });
                break;
              }
            }

            // ทำความสะอาดรหัสสินค้าและเชื่อมโยงกับคลังสินค้า (phimbot_products) อัตโนมัติ
            const cleanPidFn = (r) => {
              const s = String(r || '').trim().replace(/^PID_/i, '').trim();
              return (!s || /^(unknown|null|undefined|none|n\/a|-)$/i.test(s)) ? '' : s;
            };
            let cleanPid = cleanPidFn(payload?.productId || payload?.tiktokProductId);
            const rawName = String(payload?.productName || payload?.title || '').trim();
            const matchedProd = prods.find(p => {
              const pPid = cleanPidFn(p.productId || p.tiktokProductId || p.id);
              const pName = String(p.name || p.title || '').trim();
              return (cleanPid && pPid === cleanPid) || (rawName && pName && pName === rawName);
            }) || (prods.length === 1 ? prods[0] : null);

            if (!cleanPid && matchedProd) {
              cleanPid = cleanPidFn(matchedProd.productId || matchedProd.tiktokProductId || matchedProd.id);
            }
            const finalProductName = (rawName && rawName !== 'สินค้าจาก AI SALER PRO' && rawName !== 'สินค้าจาก Google Flow')
              ? rawName
              : (matchedProd?.name || matchedProd?.title || rawName || 'สินค้าจาก AI SALER PRO');
            const finalProductUrl = payload?.productUrl || payload?.affiliateUrl || matchedProd?.affiliateUrl || matchedProd?.productUrl || '';

            const item = {
              ...payload,
              id: `vid_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              productId: cleanPid,
              productName: finalProductName,
              productUrl: finalProductUrl,
              createdAt: new Date().toISOString(),
              posted: { tiktok: false, reels: false, shopee: false }
            };

            // ถ้ามี videoBase64 ขนาดใหญ่ → แยกเก็บใน key ต่างหาก
            let videoKey = '';
            if (item.videoBase64 && item.videoBase64.length > 100000) {
              videoKey = `phimbot_video_${item.id}`;
              try {
                await chrome.storage.local.set({ [videoKey]: item.videoBase64 });
                console.log(`[PhimBot] vault_save: video data stored separately in ${videoKey} (${(item.videoBase64.length / 1024 / 1024).toFixed(1)} MB)`);
              } catch (videoErr) {
                console.error('[PhimBot] vault_save: video storage FAILED:', videoErr);
                // ถ้า storage ไม่รับ → เก็บเฉพาะ metadata
                videoKey = 'storage_failed';
              }
              // เก็บ reference แทน base64 ตรง
              item.videoStorageKey = videoKey;
              item.videoBase64Size = item.videoBase64.length;
              item.videoBase64 = ''; // ไม่เก็บ base64 ใน vault array ป้องกัน quota
            }

            vault.unshift(item);
            await chrome.storage.local.set({ phimbot_media_vault: vault });
            console.log(`[PhimBot] vault_save: item ${item.id} (PID: ${item.productId || 'N/A'}) saved OK. vault count: ${vault.length}`);
            sendResponse({ success: true, item, videoKey });
          } catch (err) {
            console.error('[PhimBot] vault_save CRITICAL ERROR:', err);
            sendResponse({ success: false, error: err.message });
          }
          break;
        }

        case 'PHIMBOT_VAULT_GET': {
          try {
            const store2 = await chrome.storage.local.get(['phimbot_media_vault']);
            const vault = store2.phimbot_media_vault || [];

            // ถ้า item มี videoStorageKey → โหลด base64 จาก key แยก
            const keysToFetch = vault
              .filter(v => v.videoStorageKey && v.videoStorageKey !== 'storage_failed' && !v.videoBase64)
              .map(v => v.videoStorageKey);

            if (keysToFetch.length > 0) {
              const videoData = await chrome.storage.local.get(keysToFetch);
              for (const item of vault) {
                if (item.videoStorageKey && videoData[item.videoStorageKey]) {
                  item.videoBase64 = videoData[item.videoStorageKey];
                }
              }
            }

            sendResponse({ success: true, vault });
          } catch (err) {
            console.error('[PhimBot] vault_get error:', err);
            sendResponse({ success: true, vault: [] });
          }
          break;
        }

        case 'PHIMBOT_VAULT_DELETE': {
          const store3 = await storageGet(['phimbot_media_vault']);
          const allItems = store3.phimbot_media_vault || [];
          const toDelete = allItems.find(v => v.id === payload.id);
          // ลบ video key แยกด้วย
          if (toDelete?.videoStorageKey && toDelete.videoStorageKey !== 'storage_failed') {
            await chrome.storage.local.remove(toDelete.videoStorageKey).catch(() => {});
          }
          const vault3 = allItems.filter(v => v.id !== payload.id);
          await storageSet({ phimbot_media_vault: vault3 });
          sendResponse({ success: true });
          break;
        }

        case 'PHIMBOT_VAULT_MARK_POSTED': {
          const store4 = await storageGet(['phimbot_media_vault']);
          const vault4 = store4.phimbot_media_vault || [];
          const item4 = vault4.find(v => v.id === payload.id);
          if (item4) {
            if (!item4.posted) item4.posted = {};
            item4.posted[payload.platform] = true;
          }
          await storageSet({ phimbot_media_vault: vault4 });
          sendResponse({ success: true });
          break;
        }

        case 'PHIMBOT_CHECK_FLOW_LOGIN': {
          try {
            const cookies = await chrome.cookies.getAll({ domain: '.google.com', name: 'SID' });
            const allTabs = await chrome.tabs.query({});
            const hasFlowTab = allTabs.some((t) => t.url && (t.url.includes('flow.google.com') || t.url.includes('labs.google')));
            const loggedIn = cookies.length > 0 || hasFlowTab;
            sendResponse({ success: true, loggedIn });
          } catch (e) {
            sendResponse({ success: true, loggedIn: false });
          }
          break;
        }

        case 'PHIMBOT_OPEN_FLOW_LOGIN': {
          const stFlow = await storageGet(['phimbot_flow_tool_url']);
          const targetFlowUrl = stFlow?.phimbot_flow_tool_url || 'https://flow.google.com/project/6e488c48-d736-4586-9466-e3ad189813e7/tool/4365c4fb-023d-40be-82e6-8b4d0d080c4c?mode=APP';
          const flowTab = await chrome.tabs.create({ url: targetFlowUrl, active: true });
          sendResponse({ success: true, tabId: flowTab.id, url: targetFlowUrl });
          break;
        }

        case 'CLEAR_FLOW_SITE_DATA':
        case 'PHIMBOT_CLEAR_FLOW_SITE_DATA': {
          try {
            if (!chrome.browsingData || !chrome.browsingData.remove) {
              sendResponse({ ok: false, success: false, error: 'เบราว์เซอร์ไม่รองรับ browsingData API' });
              break;
            }
            await chrome.browsingData.remove(
              { origins: ['https://labs.google', 'https://flow.google.com'] },
              { cache: true, cacheStorage: true, indexedDB: true, localStorage: true, serviceWorkers: true }
            );
            // รีเฟรชแท็บ Google Flow ที่เปิดอยู่ (ถ้ามี) เพื่อโหลดข้อมูลใหม่
            try {
              const flowTabs = await chrome.tabs.query({ url: ['https://labs.google/*', 'https://flow.google.com/*'] });
              for (const t of flowTabs) {
                await chrome.tabs.reload(t.id, { bypassCache: true }).catch(() => {});
              }
            } catch (_) {}
            sendResponse({ ok: true, success: true });
          } catch (err) {
            sendResponse({ ok: false, success: false, error: err?.message || String(err) });
          }
          break;
        }

        case 'PHIMBOT_FACTORY_SETTINGS_SAVE': {
          await storageSet({ phimbot_factory_settings: payload });
          sendResponse({ success: true });
          break;
        }

        case 'PHIMBOT_FACTORY_SETTINGS_GET': {
          const fs = await storageGet(['phimbot_factory_settings']);
          sendResponse({ success: true, settings: fs.phimbot_factory_settings || {
            imageModel: '🍌 Nano Banana Pro',
            videoModel: 'Veo 3.1 - Lite [Lower Priority]',
            duration: 8,
            sceneCount: 1,
            ideaCount: 1,
            mode: 'influencer',
            voiceGender: 'female'
          }});
          break;
        }

        case 'PHIMBOT_ABORT_VIDEO_FACTORY': {
          globalThis.__phimbotFactoryAborted = true;
          broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'error', message: '⛔ ผู้ใช้สั่งหยุดการผลิต' } });
          sendResponse({ success: true });
          break;
        }

        case 'PHIMBOT_START_VIDEO_FACTORY': {
          const { products, ideas, scripts, charImages, imageModel, videoModel, duration, mode } = payload;
          globalThis.__phimbotFactoryAborted = false;
          let flowTab = null;

          try {
            // Helper: Download image to base64 Data URL (runs in background, bypasses CORS/CSP)
            async function downloadUrlToDataUrl(url) {
              if (!url) return '';
              if (String(url).startsWith('data:')) return url;
              const resp = await fetch(url);
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              const blob = await resp.blob();
              const buffer = await blob.arrayBuffer();
              const bytes = new Uint8Array(buffer);
              const chunkSize = 8192;
              let binary = '';
              for (let i = 0; i < bytes.length; i += chunkSize) {
                binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
              }
              const base64 = btoa(binary);
              const mime = blob.type || 'image/png';
              return `data:${mime};base64,${base64}`;
            }

            // 1. Open Google Flow tab & enter fresh clean New Project
            broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'running', message: '🚀 กำลังเปิด Google Flow...' } });
            flowTab = await openTabAndWait('https://flow.google.com/');
            broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: 'เปิดแท็บ Google Flow แล้ว — กำลังเตรียม New Project...' } });
            await new Promise(r => setTimeout(r, 2000));

            // 2. Open clean New Project
            await openFlowNewProject(flowTab.id, broadcast);

            // Verify login
            const [loginCheck] = await chrome.scripting.executeScript({
              target: { tabId: flowTab.id },
              world: 'MAIN',
              func: () => Boolean(document.querySelector('img[aria-label*="Google" i], img[alt*="profile" i], img[alt*="avatar" i], [aria-label*="Account" i], [aria-label*="บัญชี" i]'))
            }).catch(() => [{ result: false }]);
            broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: `✅ Engine พร้อมทำงาน! (Login: ${loginCheck?.result ? 'ใช่' : 'ไม่'})` } });

            // 5. Pre-download product references
            broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: '📷 เตรียมรูปสินค้าและรูปตัวละคร...' } });
            const productReferenceMap = {};
            for (let pi = 0; pi < products.length; pi++) {
              const prod = products[pi];
              const pId = prod.productId || prod.id || String(pi);
              productReferenceMap[pId] = [];

              // Product photos (only 1 for reliability)
              if (prod.images && prod.images.length > 0) {
                for (let imgi = 0; imgi < Math.min(prod.images.length, 1); imgi++) {
                  try {
                    const dataUrl = await downloadUrlToDataUrl(prod.images[imgi]);
                    if (dataUrl) productReferenceMap[pId].push({ dataUrl, name: `zzz-omnipost-ref-product-${imgi + 1}.png` });
                  } catch (e) {
                    broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: `⚠️ ไม่สามารถดาวน์โหลดรูปสินค้า ${imgi + 1}: ${e.message}` } });
                  }
                }
              }

              // Character photos (up to 1)
              if (charImages && charImages.length > 0) {
                for (let c = 0; c < Math.min(charImages.length, 1); c++) {
                  try {
                    const cData = await downloadUrlToDataUrl(charImages[c]);
                    if (cData) productReferenceMap[pId].push({ dataUrl: cData, name: `zzz-omnipost-ref-char-${c + 1}.png` });
                  } catch (_) {}
                }
              }
            }

            // 6. Process each product × idea × scene
            const allResults = [];
            const totalJobs = products.length * ideas.length;

            for (let pi = 0; pi < products.length; pi++) {
              if (globalThis.__phimbotFactoryAborted) break;
              const product = products[pi];
              const pId = product.productId || product.id || String(pi);
              const references = productReferenceMap[pId] || [];

              for (let ii = 0; ii < ideas.length; ii++) {
                if (globalThis.__phimbotFactoryAborted) break;
                const idea = ideas[ii];
                let ideaScenes = scripts[String(ii)] || scripts[ii] || [];
                if (!Array.isArray(ideaScenes) || ideaScenes.length === 0) {
                  ideaScenes = [
                    { beat: 'เปิดตัวสินค้า', visual: `รีวิว ${product.name} โชว์สินค้าเด่นชัดเจน`, voiceover: idea.headline || product.name },
                    { beat: 'สาธิตการใช้งาน', visual: `ใช้งานจริง ${product.name} ตอบโจทย์สะดวกสบาย`, voiceover: `ลองใช้แล้วชอบมาก แนะนำเลยค่ะ` }
                  ];
                }

                const ideaSceneVideos = [];
                let firstSceneThumbnail = '';

                broadcast({
                  type: 'PHIMBOT_FACTORY_STATUS',
                  payload: {
                    status: 'progress',
                    message: `\n📦 กำลังผลิต: [${pi + 1}/${products.length}] ${product.name.slice(0, 25)}... | ไอเดีย: ${idea.headline}`,
                    productIdx: pi,
                    ideaIdx: ii,
                    productTotal: products.length,
                    ideaTotal: ideas.length
                  }
                });

                // Execute each scene: Image → Video
                for (let si = 0; si < ideaScenes.length; si++) {
                  if (globalThis.__phimbotFactoryAborted) break;
                  const scene = ideaScenes[si];
                  const currentJobIndex = (pi * ideas.length + ii) * ideaScenes.length + si;
                  const totalSceneJobs = totalJobs * ideaScenes.length;
                  const pct = Math.round((currentJobIndex / totalSceneJobs) * 100);

                  broadcast({
                    type: 'PHIMBOT_FACTORY_STATUS',
                    payload: {
                      status: 'progress',
                      message: `🎬 [ฉาก ${si + 1}/${ideaScenes.length}] "${scene.beat || 'ฉาก ' + (si + 1)}"`,
                      productIdx: pi,
                      ideaIdx: ii,
                      sceneIdx: si,
                      pct
                    }
                  });

                  try {
                    // ── Re-inject OmniPost modules (fresh per scene, matching OmniPost Hub) ──
                    broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: `[ฉาก ${si + 1}] ⚡ Re-inject engine modules...` } });
                    await chrome.scripting.executeScript({
                      target: { tabId: flowTab.id },
                      world: 'MAIN',
                      files: [
                        'scripts/flowMediaInterceptor.js',
                        'scripts/flowSite.js',
                        'scripts/flowImageMode.js',
                        'scripts/flowModernVideo.js',
                        'scripts/flowModernReference.js'
                      ]
                    }).catch(() => {});
                    await new Promise(r => setTimeout(r, 500));
                    await normalizeFlowProjectUiBg(flowTab.id);

                    // ──────── Phase 1: Create Image ────────
                    broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: `[ฉาก ${si + 1}] 🖼️ สลับโหมด Image & แนบรูปอ้างอิง (${references.length} รูป)...` } });

                    // Build Image Prompt (UGC style, Thai influencer holding product)
                    let imgPrompt = 'สร้างภาพถ่ายเดี่ยวรูปเดียวเต็มกรอบภาพ ห้ามแบ่งช่อง ห้ามทำตารางกริด (single shot full-frame photograph, strictly one continuous scene, no collage, no split screen). ';
                    if (scene.visual) imgPrompt += scene.visual + '. ';
                    if (mode === 'hands') {
                      imgPrompt += 'Close-up hands naturally interacting with or holding the product according to uploaded reference photos, clean background, realistic contact shadows. ';
                    } else {
                      imgPrompt += 'Thai influencer naturally holding and presenting the product according to uploaded reference photos, clean authentic product packaging, realistic label print. ';
                    }
                    imgPrompt += 'Both character and product clearly visible, natural indoor lighting, 9:16 vertical format, authentic smartphone camera UGC style. NO text overlays, NO watermarks.';

                    // Take pre-submit snapshot for acceptance checking
                    const preImgSnapshot = await getFlowGenerationWatchdogSnapshot(flowTab.id).catch(() => ({}));

                    // Step 1: Ensure Image mode + select Nano Banana Pro + set aspect ratio 9:16
                    const [imgModeRes] = await chrome.scripting.executeScript({
                      target: { tabId: flowTab.id },
                      world: 'MAIN',
                      args: [{ requestedModel: imageModel || '🍌 Nano Banana Pro' }],
                      func: async (args) => {
                        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                        // Wait for composer
                        let composerEl = null;
                        for (let i = 0; i < 30; i++) {
                          composerEl = document.querySelector('flow-prompt-box');
                          if (composerEl && composerEl.getBoundingClientRect().width > 0) break;
                          await sleep(500);
                        }
                        if (!composerEl) return { ok: false, reason: 'composer_not_found' };

                        // Ensure Image mode via settings panel
                        if (!globalThis.OmniPostFlowImageMode) return { ok: false, reason: 'image_mode_module_missing' };
                        const m = await globalThis.OmniPostFlowImageMode.ensure({ timeoutMs: 15000 });
                        if (!m?.ok) return { ok: false, reason: m?.reason || 'image_mode_failed' };

                        const refetchPopper = () => {
                          return globalThis.OmniPostFlowImageMode?.findPanel?.()
                            || document.querySelector('flow-prompt-box-settings, .cdk-overlay-pane, [data-radix-menu-content][data-state="open"], [role="menu"][data-state="open"], [data-radix-popper-content-wrapper]');
                        };

                        const clickRadixTrigger = async (el) => {
                          if (!el) return;
                          el.scrollIntoView?.({ behavior: 'instant', block: 'center' });
                          el.focus?.();
                          const rect = el.getBoundingClientRect();
                          const opts = { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', button: 0, buttons: 1, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
                          el.dispatchEvent(new PointerEvent('pointerdown', opts));
                          await sleep(100);
                          el.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
                          await sleep(100);
                          el.click();
                        };

                        const clickRadixOption = async (el) => {
                          if (!el) return;
                          el.scrollIntoView?.({ behavior: 'instant', block: 'center' });
                          el.focus?.();
                          const rect = el.getBoundingClientRect();
                          const opts = { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', button: 0, buttons: 1, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
                          el.dispatchEvent(new PointerEvent('pointermove', opts));
                          await sleep(50);
                          el.dispatchEvent(new PointerEvent('pointerdown', opts));
                          await sleep(50);
                          el.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
                          await sleep(50);
                          el.click();
                        };

                        const clickRadixTab = async (element) => {
                          if (!element) return false;
                          const isActive = () => "active" === element.getAttribute("data-state")
                            || "true" === element.getAttribute("aria-selected")
                            || "true" === element.getAttribute("aria-checked")
                            || element.classList.contains("mat-button-toggle-checked")
                            || element.classList.contains("active")
                            || element.classList.contains("selected");
                          element.scrollIntoView({ behavior: 'instant', block: 'center' });
                          element.focus?.();
                          await sleep(80);
                          if (isActive()) return true;
                          element.click();
                          await sleep(80);
                          if (isActive()) return true;
                          const rect = element.getBoundingClientRect();
                          const opts = { bubbles: true, cancelable: true, composed: true, pointerType: "mouse", button: 0, buttons: 1, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
                          element.dispatchEvent(new PointerEvent("pointerdown", opts));
                          await sleep(50);
                          element.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
                          await sleep(50);
                          element.click();
                          await sleep(100);
                          if (isActive()) return true;
                          element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
                          await sleep(50);
                          element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
                          await sleep(50);
                          element.click();
                          await sleep(100);
                          return isActive();
                        };

                        let popper = m.panel || refetchPopper();

                        // ── A. Ensure Nano Banana Pro model is selected (supports 9:16) ──
                        if (popper) {
                          const popperBtns = Array.from(popper.querySelectorAll('button[aria-haspopup="menu"], button[role="combobox"], [data-radix-dropdown-menu-trigger], button'));
                          let modelDropdown = popperBtns.find(b => {
                            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                            if (aria.includes('model') || aria.includes('โมเดล')) return true;
                            const txt = (b.textContent || '').trim().toLowerCase();
                            const icons = Array.from(b.querySelectorAll('i, mat-icon, .material-icons, .google-symbols, .material-symbols-outlined, span'))
                              .map(ic => (ic.textContent || '').trim().toLowerCase());
                            return (icons.some(ic => ic.includes('arrow_drop')) && (txt.includes('banana') || txt.includes('imagen') || txt.includes('nano')))
                              || ((txt.includes('banana 2') || txt.includes('nano banana')) && b.getAttribute('aria-haspopup'));
                          }) || popperBtns.find(b => {
                            const txt = (b.textContent || '').trim().toLowerCase();
                            return (txt.includes('nano banana') || txt.includes('banana 2') || txt.includes('banana pro')) && b.getAttribute('aria-haspopup');
                          });

                          if (modelDropdown) {
                            const curText = (modelDropdown.textContent || '').trim().toLowerCase().replace(/arrow_drop_down|arrow_drop_up/g, '').trim();
                            // Nano Banana Pro is strictly required for 9:16 vertical ratio support
                            if (!curText.includes('nano banana pro') && !curText.includes('banana pro')) {
                              const existingMenus = new Set(document.querySelectorAll('[data-radix-menu-content]'));
                              await clickRadixTrigger(modelDropdown);
                              await sleep(900);

                              let modelMenu = null;
                              for (let i = 0; i < 10; i++) {
                                for (const mm of document.querySelectorAll('[data-radix-menu-content][data-state="open"], [role="menu"][data-state="open"], [role="listbox"]')) {
                                  if (!existingMenus.has(mm) && mm.getBoundingClientRect().height > 0) {
                                    modelMenu = mm;
                                    break;
                                  }
                                }
                                if (modelMenu) break;
                                await sleep(250);
                              }

                              const menuItems = Array.from((modelMenu || document).querySelectorAll('[role="menuitem"], [role="option"], [data-radix-collection-item], button'));
                              const proItem = menuItems.find(it => {
                                if (it.hasAttribute('data-disabled') || it.getAttribute('aria-disabled') === 'true') return false;
                                const t = (it.textContent || '').trim().toLowerCase();
                                return (t.includes('nano banana pro') || (t.includes('banana') && t.includes('pro')));
                              });

                              if (proItem) {
                                const innerBtn = proItem.querySelector('button') || proItem;
                                await clickRadixOption(innerBtn);
                                await sleep(1000); // Give Flow time to switch model and re-render popper
                              } else {
                                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
                                await sleep(300);
                              }
                            }
                          }
                        }

                        // ── B. Select 9:16 Aspect Ratio (Strictly 9:16, NO 3:4 fallback!) ──
                        popper = refetchPopper() || popper;
                        let selected916 = false;

                        const isExact916 = (btn) => {
                          const aria = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').toLowerCase();
                          const txt = (btn.textContent || '').trim().toLowerCase();
                          const html = (btn.innerHTML || '').toLowerCase();
                          const val = (btn.getAttribute('value') || btn.getAttribute('data-value') || '').toLowerCase();
                          const icons = Array.from(btn.querySelectorAll('i, mat-icon, .material-icons, .google-symbols, .material-symbols-outlined, span'))
                            .map(i => (i.textContent || '').trim().toLowerCase());
                          return icons.some(ic => ic === 'crop_9_16' || ic.includes('9_16') || ic.includes('9:16'))
                            || html.includes('crop_9_16') || html.includes('crop_9-16') || html.includes('9_16')
                            || aria.includes('9:16') || aria.includes('9/16') || aria.includes('vertical')
                            || txt === '9:16' || txt.includes('9:16') || txt.includes('9/16')
                            || val === '9:16' || val.includes('9_16');
                        };

                        if (popper) {
                          // Try finding 9:16 tab with up to 5 retries (in case of re-render after model change)
                          let tab916 = null;
                          for (let r = 0; r < 5; r++) {
                            const popperTabs = Array.from(popper.querySelectorAll('button[role="tab"], button[role="radio"], button, [role="button"]'));
                            tab916 = popperTabs.find(isExact916);
                            if (tab916) break;
                            await sleep(300);
                            popper = refetchPopper() || popper;
                          }

                          if (tab916) {
                            for (let attempt = 0; attempt < 3; attempt++) {
                              const active = await clickRadixTab(tab916);
                              if (active) { selected916 = true; break; }
                              await sleep(200);
                            }
                          } else {
                            // Check any aspect ratio tablist (e.g. containers with crop_ icons)
                            const tablists = Array.from(popper.querySelectorAll('[role="tablist"], [role="radiogroup"]'));
                            for (const tl of tablists) {
                              const tabs = Array.from(tl.querySelectorAll('button[role="tab"], button[role="radio"], button'));
                              const isRatioList = tabs.some(t => /crop_|1:1|16:9|3:4|4:3|ratio|aspect/i.test(t.innerHTML || t.textContent || t.getAttribute('aria-label') || ''));
                              if (isRatioList) {
                                const matched = tabs.find(isExact916);
                                if (matched) {
                                  await clickRadixTab(matched);
                                  await sleep(250);
                                  selected916 = true;
                                  break;
                                }
                              }
                            }
                          }

                          // Ensure Output Count is x1
                          const countTabs = Array.from(popper.querySelectorAll('button[role="tab"], button[role="radio"], button'));
                          const x1Tab = countTabs.find(t => {
                            const txt = (t.textContent || '').trim().toLowerCase();
                            return txt === 'x1' || txt === '1x' || txt === '1';
                          });
                          if (x1Tab) {
                            await clickRadixTab(x1Tab);
                            await sleep(200);
                          }
                        }

                        // ── C. Close settings panel ──
                        await globalThis.OmniPostFlowImageMode.close().catch(() => {});
                        await sleep(600);

                        // ── D. Read active settings summary from composer chip ──
                        const trigger = globalThis.OmniPostFlowImageMode?.findTrigger?.()
                          || document.querySelector('flow-prompt-box button[aria-haspopup="menu"]');
                        const triggerSummary = trigger ? `${trigger.textContent || ''} ${trigger.getAttribute('aria-label') || ''}`.replace(/\s+/g, ' ').trim() : '';
                        const triggerIcons = trigger ? Array.from(trigger.querySelectorAll('i, mat-icon, .material-icons, .google-symbols, .material-symbols-outlined, span')).map(i => (i.textContent || '').trim().toLowerCase()) : [];
                        const chipHas916 = triggerSummary.includes('9:16') || triggerSummary.includes('9/16') || triggerIcons.some(ic => ic.includes('9_16') || ic === 'crop_9_16');

                        return { ok: true, triggerSummary, selected916: selected916 || chipHas916 };
                      }
                    });

                    if (!imgModeRes?.result?.ok) {
                      throw new Error(imgModeRes?.result?.reason || 'image_mode_setup_failed');
                    }
                    broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: `[ฉาก ${si + 1}] 📐 ตั้งค่าโหมดภาพสำเร็จ (${imgModeRes?.result?.triggerSummary || '9:16'})` } });
                    await new Promise(r => setTimeout(r, 500));
                    await new Promise(r => setTimeout(r, 500)); // Extra settle time

                    // Step 2: Debug — dump composer state to understand what's available
                    const [debugRes] = await chrome.scripting.executeScript({
                      target: { tabId: flowTab.id },
                      world: 'MAIN',
                      func: () => {
                        const isVisible = (el) => Boolean(el?.isConnected && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
                        const box = document.querySelector('flow-prompt-box');
                        if (!box) return { composerFound: false };
                        const allBtns = Array.from(box.querySelectorAll('button, [role="button"]')).filter(isVisible);
                        const btnInfo = allBtns.map(b => ({
                          text: String(b.textContent || '').trim().substring(0, 60),
                          ariaLabel: b.getAttribute('aria-label') || '',
                          ariaHaspopup: b.getAttribute('aria-haspopup') || '',
                          classes: b.className?.substring?.(0, 80) || '',
                          icons: Array.from(b.querySelectorAll('i, mat-icon, .material-icons, .google-symbols')).map(i => (i.textContent || '').trim()).join(','),
                        }));
                        const ingredientBar = box.querySelector('flow-ingredient-bar');
                        const addMenu = box.querySelector('flow-add-menu-popover-content');
                        return {
                          composerFound: true,
                          composerVisible: isVisible(box),
                          buttonCount: allBtns.length,
                          buttons: btnInfo,
                          hasIngredientBar: Boolean(ingredientBar),
                          hasAddMenu: Boolean(addMenu),
                          hasTextarea: Boolean(box.querySelector('textarea')),
                          hasEditor: Boolean(box.querySelector('[contenteditable="true"]')),
                        };
                      }
                    }).catch(() => [{ result: null }]);
                    broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: `[DEBUG] Composer: ${JSON.stringify(debugRes?.result || 'null').substring(0, 300)}` } });

                    // Step 3: Attach references + Fill prompt (separate executeScript)
                    const [imgSetupRes] = await chrome.scripting.executeScript({
                      target: { tabId: flowTab.id },
                      world: 'MAIN',
                      args: [{ prompt: imgPrompt, references }],
                      func: async (args) => {
                        // 1. Attach reference images (ingredients)
                        if (args.references?.length && globalThis.OmniPostFlowModernReference) {
                          const attachRes = await globalThis.OmniPostFlowModernReference.attach(args.references, {
                            mode: 'ingredients',
                            timeoutMs: 60000
                          });
                          if (!attachRes?.ok) return attachRes;
                        }
                        // 2. Fill prompt
                        if (globalThis.OmniPostFlowModernReference) {
                          const pRes = await globalThis.OmniPostFlowModernReference.fillPrompt(args.prompt);
                          if (!pRes?.ok) return { ok: false, reason: pRes?.err || 'fill_prompt_failed' };
                        }
                        return { ok: true };
                      }
                    });

                    if (!imgSetupRes?.result?.ok) {
                      throw new Error(imgSetupRes?.result?.reason || 'image_setup_failed');
                    }

                    // Verify attached chips count
                    const [chipVerify] = await chrome.scripting.executeScript({
                      target: { tabId: flowTab.id },
                      world: 'MAIN',
                      func: () => {
                        const box = document.querySelector('flow-prompt-box');
                        const chips = Array.from(box?.querySelectorAll('flow-ingredient-bar img') || [])
                          .filter(el => el.getBoundingClientRect().width > 0);
                        return { count: chips.length };
                      }
                    }).catch(() => [{ result: { count: 0 } }]);
                    broadcast({
                      type: 'PHIMBOT_FACTORY_STATUS',
                      payload: {
                        status: 'progress',
                        message: `[ฉาก ${si + 1}] 🏷️ แนบ Reference สำเร็จ: ${chipVerify?.result?.count || references.length}/${references.length} รูป (สินค้า + ตัวละคร)`
                      }
                    });

                    // Capture baseline image URLs and media checkpoint before clicking generate (OmniPost Hub v1.3.1)
                    const [baselineImgsRes] = await chrome.scripting.executeScript({
                      target: { tabId: flowTab.id },
                      world: 'MAIN',
                      func: () => {
                        const urls = Array.from(document.querySelectorAll('img')).map(i => i.currentSrc || i.src || '').filter(Boolean);
                        const checkpoint = window.__OMNIPOST_FLOW_MEDIA__?.checkpoint?.() || { capturedAt: Date.now(), ids: [] };
                        return { urls, checkpoint };
                      }
                    }).catch(() => [{ result: { urls: [], checkpoint: { capturedAt: Date.now(), ids: [] } } }]);
                    const baselineImgs = new Set(baselineImgsRes?.result?.urls || []);
                    const mediaCheckpoint = baselineImgsRes?.result?.checkpoint || { capturedAt: Date.now(), ids: [] };

                    // Wait before clicking generate (matching OmniPost Hub 3s delay)
                    await new Promise(r => setTimeout(r, 3000));
                    broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: `[ฉาก ${si + 1}] 🚀 เริ่มสร้างรูปภาพ...` } });

                    // Click Generate Image (robust matcher matching OmniPost Hub v1.3.1)
                    const [genImgClick] = await chrome.scripting.executeScript({
                      target: { tabId: flowTab.id },
                      world: 'MAIN',
                      func: () => {
                        const composer = document.querySelector('flow-prompt-box');
                        const visible = (el) => Boolean(el?.isConnected && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
                        const labelOf = (el) => `${el?.getAttribute?.('aria-label') || ''} ${el?.textContent || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
                        const submit = globalThis.OmniPostFlowModernReference?.findStartGenerationButton?.(composer)
                          || composer?.querySelector('button[aria-label="Start generation"], button.generate-icon-button')
                          || Array.from(composer?.querySelectorAll('button,[role="button"]') || []).find((b) => {
                            if (!visible(b) || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
                            const l = labelOf(b);
                            return /start generation|generate|create|เริ่ม.*สร้าง|สร้าง.*ภาพ|สร้าง.*วิดีโอ|สร้าง.*วิดิโอ/.test(l)
                              || /generate-icon-button/.test(b.className || '')
                              || Array.from(b.querySelectorAll('i, mat-icon')).some(i => /arrow_forward|send|north_east/.test(i.textContent));
                          });
                        if (!submit || submit.disabled) return { ok: false, reason: 'generate_button_not_ready' };
                        submit.click();
                        return { ok: true };
                      }
                    });
                    if (!genImgClick?.result?.ok) throw new Error(genImgClick?.result?.reason || 'click_generate_image_failed');

                    // ── Acceptance check (matching OmniPost Hub popup.js 15641-15654) ──
                    broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: `[ฉาก ${si + 1}] 🔍 ตรวจสอบว่า Flow รับงานรูป...` } });
                    await new Promise(r => setTimeout(r, 2000));
                    const preImgTiles = new Set(preImgSnapshot?.tileKeys || []);
                    let imgAccepted = false;
                    for (let ci = 0; ci < 20; ci++) {
                      await new Promise(r => setTimeout(r, 750));
                      const snap = await getFlowGenerationWatchdogSnapshot(flowTab.id).catch(() => ({}));
                      const hasNewTile = (snap?.tileKeys || []).some(k => !preImgTiles.has(k));
                      if (snap?.isGenerating || hasNewTile || Number(snap?.imageCount || 0) > Number(preImgSnapshot?.imageCount || 0)) {
                        imgAccepted = true;
                        break;
                      }
                    }

                    // ── Clear prompt after image accepted (CRITICAL — matching OmniPost Hub) ──
                    if (imgAccepted) {
                      const clr = await clearAcceptedGoogleFlowPrompt(flowTab.id, 'image');
                      broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: clr?.cleared ? `[ฉาก ${si + 1}] 🧹 ล้าง Prompt รูปเรียบร้อย` : `[ฉาก ${si + 1}] ⚠️ ล้าง Prompt ไม่สำเร็จ` } });
                    } else {
                      broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: `[ฉาก ${si + 1}] ⚠️ สัญญาณตอบรับช้า — จะรอต่อ` } });
                    }

                    // ── Wait for Image generation to complete (OmniPost Hub v1.3.1 active polling) ──
                    broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: `[ฉาก ${si + 1}] ⏳ รอรูปภาพเจนเสร็จ...` } });
                    let imgResult = { ok: false, reason: 'timeout' };
                    const imgStartTime = Date.now();
                    const imgTimeoutMs = 180000;
                    let sawActiveProgress = false;
                    let completedPollsAfterProgress = 0;

                    while (Date.now() - imgStartTime < imgTimeoutMs) {
                      await new Promise(r => setTimeout(r, 2500));
                      const snap = await getFlowGenerationWatchdogSnapshot(flowTab.id).catch(() => ({}));
                      const elapsed = Date.now() - imgStartTime;

                      if (snap?.isGenerating || snap?.progress) {
                        sawActiveProgress = true;
                        completedPollsAfterProgress = 0;
                        const progressMsg = snap.progress ? ` ${snap.progress}` : ' (กำลังประมวลผล...)';
                        broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: `[ฉาก ${si + 1}] ⏳ กำลังสร้างรูป:${progressMsg}` } });
                      } else if (sawActiveProgress) {
                        completedPollsAfterProgress++;
                      }

                      // Guard: wait at least 8s for Flow to register generation before looking for completed results
                      if (elapsed < 8000) {
                        continue;
                      }

                      // Check for newly generated image (only images created AFTER mediaCheckpoint)
                      const [fetchRes] = await chrome.scripting.executeScript({
                        target: { tabId: flowTab.id },
                        world: 'MAIN',
                        args: [Array.from(baselineImgs), mediaCheckpoint.capturedAt, mediaCheckpoint.ids],
                        func: async (baselineUrls, checkpointCapturedAt, checkpointExcludedIds) => {
                          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                          const toDataUrl = (blob) => new Promise((resolve, reject) => {
                            const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
                          });
                          const baselineSet = new Set(baselineUrls || []);

                          // 1. First check media interceptor WITH STRICT CHECKPOINT (never return pre-existing uploads)
                          if (window.__OMNIPOST_FLOW_MEDIA__) {
                            const latest = await window.__OMNIPOST_FLOW_MEDIA__.exportLatest({
                              kind: 'image',
                              after: checkpointCapturedAt,
                              excludeIds: checkpointExcludedIds,
                              limit: 2
                            });
                            if (latest?.length && (latest[0].dataUrl || latest[0].url)) {
                              const intercepted = [];
                              for (const it of latest) {
                                let dUrl = it.dataUrl;
                                if (!dUrl && it.url) {
                                  try {
                                    const r = await fetch(it.url);
                                    if (r.ok) dUrl = await toDataUrl(await r.blob());
                                  } catch (_) {}
                                }
                                if (dUrl) intercepted.push({ url: it.url || '', dataUrl: dUrl, type: 'image/png' });
                              }
                              if (intercepted.length > 0) return { ok: true, images: intercepted, source: 'interceptor' };
                            }
                          }

                          // 2. Find eligible generated images from DOM
                          const isUploadedRef = (img) => {
                            const marker = `${img.currentSrc || img.src || ''} ${img.alt || ''} ${img.className || ''}`.toLowerCase();
                            // Reference images uploaded by PhimBot always have 'zzz-omnipost-ref-' in their filename/src/alt
                            if (/zzz-omnipost-ref-|blob:.*ref/i.test(marker)) return true;
                            // Exclude images residing in the prompt box, ingredient bar, or upload popover
                            if (img.closest('flow-prompt-box, flow-ingredient-bar, flow-add-menu-popover-content, [data-testid="ingredient-bar"]')) return true;
                            return false;
                          };

                          const allCandidateImgs = Array.from(document.querySelectorAll('img')).filter(img => {
                            const rect = img.getBoundingClientRect();
                            if (rect.width < 64 || rect.height < 64) return false;
                            const naturalW = Number(img.naturalWidth || 0);
                            const naturalH = Number(img.naturalHeight || 0);
                            if (naturalW < 100 || naturalH < 100) return false;
                            const src = String(img.currentSrc || img.src || '');
                            if (!/^(https?:|blob:|data:image\/)/i.test(src)) return false;
                            if (/avatar|profile|icon|logo|sprite|emoji|favicon|\.svg/i.test(src)) return false;
                            if (img.closest('nav, header, flow-prompt-box, flow-prompt-box-settings, flow-add-menu-popover-content, flow-ingredient-bar')) return false;
                            if (baselineSet.has(src)) return false;
                            if (isUploadedRef(img)) return false;
                            return true;
                          });

                          // Prioritize explicitly marked Generated images or images inside generation tiles
                          const exactGen = allCandidateImgs.filter(i => /generated image|^generated\b/i.test(String(i.alt || '')) || Boolean(i.closest('flow-grid-tile-container, [data-tile-id]')));
                          const imgs = exactGen.length > 0 ? exactGen : allCandidateImgs;

                          if (imgs.length > 0) {
                            const collected = [];
                            for (const img of imgs) {
                              const src = String(img.currentSrc || img.src || '');
                              if (!src) continue;
                              let dUrl = '';
                              let bSize = 0;
                              let bType = 'image/png';
                              try {
                                const resp = await fetch(src, { credentials: 'include' });
                                if (resp.ok) {
                                  const blob = await resp.blob();
                                  bSize = blob.size;
                                  bType = blob.type;
                                  dUrl = await toDataUrl(blob);
                                }
                              } catch (_) {}
                              if (!dUrl && img.complete && img.naturalWidth > 0) {
                                try {
                                  const cvs = document.createElement('canvas');
                                  cvs.width = img.naturalWidth;
                                  cvs.height = img.naturalHeight;
                                  const ctx = cvs.getContext('2d');
                                  ctx.drawImage(img, 0, 0);
                                  dUrl = cvs.toDataURL('image/png');
                                } catch (_) {}
                              }
                              collected.push({ url: src, dataUrl: dUrl, type: bType, size: bSize || (dUrl ? dUrl.length : 100000) });
                            }
                            if (collected.length > 0) {
                              collected.sort((a, b) => b.size - a.size);
                              return { ok: true, images: collected.slice(0, 2), source: 'dom' };
                            }
                          }
                          return { ok: false };
                        }
                      }).catch(() => [{ result: { ok: false } }]);

                      if (fetchRes?.result?.ok && fetchRes.result.images?.length > 0) {
                        imgResult = fetchRes.result;
                        // Ensure each image has a dataUrl (fallback to background fetch if needed)
                        for (const imgItem of imgResult.images) {
                          if (!imgItem.dataUrl && imgItem.url) {
                            try {
                              const resp = await fetch(imgItem.url);
                              const blob = await resp.blob();
                              const toDataUrlBg = (b) => new Promise((resolve, reject) => {
                                const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(b);
                              });
                              imgItem.dataUrl = await toDataUrlBg(blob);
                            } catch (_) {}
                          }
                        }
                        break;
                      }

                      // Check if failed
                      if (Number(snap?.failedCount || 0) > 0 && !snap?.isGenerating && elapsed > 25000) {
                        imgResult = { ok: false, reason: snap.failedReason || 'flow_generation_failed' };
                        break;
                      }
                    }

                    if (imgResult?.ok && imgResult.images?.length > 0) {
                      broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: `[ฉาก ${si + 1}] ✅ รูปภาพพร้อมแล้ว! (${imgResult.images.length} รูป)` } });
                      if (!firstSceneThumbnail && imgResult.images[0]?.dataUrl) {
                        firstSceneThumbnail = imgResult.images[0].dataUrl;
                      }

                      // ──────── Phase 2: Create Video from Start Frame (OmniPost Hub v1.3.1) ────────
                      broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: `[ฉาก ${si + 1}] 🔄 รีเฟรช Flow เพื่อให้ภาพล่าสุดขึ้นบนสุดก่อนสลับโหมด Video...` } });
                      await chrome.tabs.reload(flowTab.id).catch(() => null);

                      // Wait for tab reload to complete and Flow workspace ready
                      const reloadStart = Date.now();
                      while (Date.now() - reloadStart < 30000) {
                        await new Promise(r => setTimeout(r, 750));
                        const tabInfo = await chrome.tabs.get(flowTab.id).catch(() => null);
                        if (tabInfo?.status === 'complete') {
                          const [readyProbe] = await chrome.scripting.executeScript({
                            target: { tabId: flowTab.id },
                            func: () => Boolean(document.querySelector('flow-prompt-box, textarea, [contenteditable="true"]'))
                          }).catch(() => [null]);
                          if (readyProbe?.result) break;
                        }
                      }
                      await new Promise(r => setTimeout(r, 2000));
                      await normalizeFlowProjectUiBg(flowTab.id);
                    } else {
                      broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: `[ฉาก ${si + 1}] ❌ สร้างรูปภาพไม่สำเร็จ (${imgResult?.reason || 'timeout'}) — ข้ามฉากนี้` } });
                      throw new Error(`image_generation_failed_scene_${si + 1}: ${imgResult?.reason || 'timeout'}`);
                    }

                    // Re-inject modules before video phase
                    await chrome.scripting.executeScript({
                      target: { tabId: flowTab.id },
                      world: 'MAIN',
                      files: [
                        'scripts/flowMediaInterceptor.js',
                        'scripts/flowSite.js',
                        'scripts/flowImageMode.js',
                        'scripts/flowModernVideo.js',
                        'scripts/flowModernReference.js'
                      ]
                    }).catch(() => {});
                    await new Promise(r => setTimeout(r, 800));

                    // Dynamic Video Model mapping (from user selection payload.videoModel)
                    const rawVidModel = String(payload.videoModel || 'Veo 3.1 - Lite [Lower Priority]');
                    let vidModelKey = 'veo_31_lite_lower_priority';
                    let vidModelLabel = 'Veo 3.1 - Lite [Lower Priority]';
                    if (/omni/i.test(rawVidModel)) {
                      vidModelKey = 'omni_11_flash';
                      vidModelLabel = 'Omni 1.1 Flash';
                    } else if (/quality/i.test(rawVidModel)) {
                      vidModelKey = 'veo_31_quality';
                      vidModelLabel = 'Veo 3.1 - Quality';
                    } else if (/fast/i.test(rawVidModel)) {
                      vidModelKey = 'veo_31_fast';
                      vidModelLabel = 'Veo 3.1 - Fast';
                    } else if (/lower|ฟรี/i.test(rawVidModel)) {
                      vidModelKey = 'veo_31_lite_lower_priority';
                      vidModelLabel = 'Veo 3.1 - Lite [Lower Priority]';
                    } else if (/lite/i.test(rawVidModel)) {
                      vidModelKey = 'veo_31_lite';
                      vidModelLabel = 'Veo 3.1 - Lite';
                    }

                    // Take pre-submit baseline for video checkpointing & URL isolation
                    const preVidBaseline = await chrome.scripting.executeScript({
                      target: { tabId: flowTab.id },
                      world: 'MAIN',
                      func: () => {
                        const cp = window.__OMNIPOST_FLOW_MEDIA__?.checkpoint?.() || { capturedAt: Date.now(), ids: [] };
                        const videos = [];
                        document.querySelectorAll('video').forEach(v => {
                          const src = v.currentSrc || v.src || v.querySelector('source')?.src;
                          if (src && !videos.includes(src)) videos.push(src);
                        });
                        return {
                          capturedAt: cp.capturedAt,
                          ids: cp.ids || [],
                          baselineVideos: videos,
                        };
                      }
                    }).then(r => r?.[0]?.result).catch(() => ({ capturedAt: Date.now(), ids: [], baselineVideos: [] }));

                    // Build Video Prompt with Thai voiceover
                    let vidPrompt = '';
                    if (scene.voiceover) {
                      vidPrompt += `[SPOKEN AUDIO: THAI LANGUAGE ONLY] ผู้พูดรีวิวสินค้า ปากขยับตรงกับเสียงพูด บทพูดไทย: "${scene.voiceover}"\n\n`;
                    }
                    vidPrompt += 'Seamlessly continue from the Start Frame with a static camera. ';
                    if (scene.visual) vidPrompt += scene.visual + ' ';
                    vidPrompt += 'NO text overlays, NO subtitles. All spoken audio must be Thai only. Natural movements, professional lighting, 9:16 vertical format.';

                    // Take pre-submit snapshot for video acceptance
                    const preVidSnapshot = await getFlowGenerationWatchdogSnapshot(flowTab.id).catch(() => ({}));

                    // Prepare Video Payload matching OmniPost Hub v1.3.1
                    const generatedImg = (imgResult?.ok && imgResult.images?.length > 0) ? imgResult.images[0] : null;
                    const vidPayload = {
                      referenceImages: generatedImg
                        ? [{ dataUrl: generatedImg.dataUrl, name: 'start_frame.png', referenceRole: 'start_frame' }]
                        : [],
                      targetImageUrl: generatedImg?.url || '',
                      prompt: vidPrompt,
                      model: vidModelKey,
                      modelLabel: vidModelLabel,
                      aspect: '9:16',
                      duration: duration || 8,
                      outputCount: 1,
                      preferRecentFlowImage: true
                    };

                    broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: `[ฉาก ${si + 1}] 🎥 ตั้งค่าวิดีโอ (${vidModelLabel}, 9:16, ${duration || 8}s)...` } });

                    // Use OmniPostFlowModernVideo.run() with continueAfterSettings fallback
                    const [vidSetupRes] = await chrome.scripting.executeScript({
                      target: { tabId: flowTab.id },
                      world: 'MAIN',
                      args: [vidPayload],
                      func: async (payload) => {
                        let res = await globalThis.OmniPostFlowModernVideo.run(payload);
                        if (!res.ok && res.reason === 'modern_video_settings_not_closed') {
                          await globalThis.OmniPostFlowModernVideo.closeSettingsPanel();
                          res = await globalThis.OmniPostFlowModernVideo.continueAfterSettings(payload);
                        }
                        return res;
                      },
                    }).catch(e => [{ result: { ok: false, reason: e?.message || 'video_run_script_failed' } }]);

                    if (!vidSetupRes?.result?.ok) {
                      throw new Error(vidSetupRes?.result?.reason || 'video_setup_failed');
                    }

                    // Wait before clicking generate (3s like OmniPost Hub)
                    broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: `[ฉาก ${si + 1}] 🚀 เริ่มสร้างวิดีโอ...` } });
                    await new Promise(r => setTimeout(r, 3000));

                    // Click Generate Video (robust OmniPost Hub v1.3.1 matcher)
                    const [genVidClick] = await chrome.scripting.executeScript({
                      target: { tabId: flowTab.id },
                      world: 'MAIN',
                      func: () => {
                        const composer = document.querySelector('flow-prompt-box');
                        const visible = (el) => Boolean(el?.isConnected && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
                        const labelOf = (el) => `${el?.getAttribute?.('aria-label') || ''} ${el?.textContent || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
                        const submit = globalThis.OmniPostFlowModernReference?.findStartGenerationButton?.(composer)
                          || composer?.querySelector('button[aria-label="Start generation"], button.generate-icon-button')
                          || Array.from(composer?.querySelectorAll('button,[role="button"]') || []).find((b) => {
                            if (!visible(b) || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
                            const l = labelOf(b);
                            return /start generation|generate|create|เริ่ม.*สร้าง|สร้าง.*ภาพ|สร้าง.*วิดีโอ|สร้าง.*วิดิโอ/.test(l)
                              || /generate-icon-button/.test(b.className || '')
                              || Array.from(b.querySelectorAll('i, mat-icon')).some(i => /arrow_forward|send|north_east/.test(i.textContent));
                          });
                        if (!submit || submit.disabled) return { ok: false, reason: 'generate_button_not_ready' };
                        submit.click();
                        return { ok: true };
                      }
                    });
                    if (!genVidClick?.result?.ok) throw new Error(genVidClick?.result?.reason || 'click_generate_video_failed');

                    // ── Video Acceptance check (matching OmniPost Hub popup.js 25443-25485) ──
                    broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: `[ฉาก ${si + 1}] 🔍 ตรวจสอบว่า Flow รับงานวิดีโอ...` } });
                    await new Promise(r => setTimeout(r, 1000));
                    const preVidTiles = new Set(preVidSnapshot?.tileKeys || []);
                    let vidAccepted = false;
                    for (let ci = 0; ci < 20; ci++) {
                      await new Promise(r => setTimeout(r, 1000));
                      const snap = await getFlowGenerationWatchdogSnapshot(flowTab.id).catch(() => ({}));
                      const hasNewTile = (snap?.tileKeys || []).some(k => !preVidTiles.has(k));
                      if (snap?.isGenerating || hasNewTile
                          || Number(snap?.queuedCount || 0) > Number(preVidSnapshot?.queuedCount || 0)
                          || Number(snap?.creatingCount || 0) > Number(preVidSnapshot?.creatingCount || 0)
                          || Number(snap?.videoCount || 0) > Number(preVidSnapshot?.videoCount || 0)) {
                        vidAccepted = true;
                        break;
                      }
                    }

                    // ── Clear prompt after video accepted (CRITICAL) ──
                    if (vidAccepted) {
                      const clr = await clearAcceptedGoogleFlowPrompt(flowTab.id, 'video');
                      broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: clr?.cleared ? `[ฉาก ${si + 1}] 🧹 ล้าง Prompt วิดีโอเรียบร้อย` : `[ฉาก ${si + 1}] ⚠️ ล้าง Prompt วิดีโอไม่สำเร็จ` } });
                    }

                    // Poll Video progress & extract media
                    broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: `[ฉาก ${si + 1}] ⏳ รอระบบสร้างวิดีโอ...` } });
                    const vidStart = Date.now();
                    let lastVidProg = '';
                    let capturedVideo = null;

                    while (Date.now() - vidStart < 360000) { // 6 minutes max
                      await new Promise(r => setTimeout(r, 2500));
                      const elapsed = Math.round((Date.now() - vidStart) / 1000);

                      // Use watchdog snapshot for progress (more reliable)
                      const vidSnap = await getFlowGenerationWatchdogSnapshot(flowTab.id).catch(() => ({}));
                      const pStr = vidSnap?.progress || '';
                      if (pStr && pStr !== lastVidProg) {
                        lastVidProg = pStr;
                        broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: `[ฉาก ${si + 1}] 🎥 วิดีโอ: ${pStr} (${elapsed}s)` } });
                      }

                      // Check for video in DOM or media interceptor (matching OmniPost Hub v1.3.1)
                      const [pollRes] = await chrome.scripting.executeScript({
                        target: { tabId: flowTab.id },
                        world: 'MAIN',
                        args: [preVidBaseline],
                        func: async (baseline) => {
                          const toDataUrl = (blob) => new Promise((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onload = () => resolve(reader.result);
                            reader.onerror = reject;
                            reader.readAsDataURL(blob);
                          });

                          // 1. First check media interceptor (filtered by checkpoint timestamp and ids)
                          if (window.__OMNIPOST_FLOW_MEDIA__) {
                            const latest = await window.__OMNIPOST_FLOW_MEDIA__.exportLatest({
                              kind: 'video',
                              after: Number(baseline?.capturedAt || 0),
                              excludeIds: Array.isArray(baseline?.ids) ? baseline.ids : [],
                              limit: 1
                            });
                            if (latest?.length && (latest[0].dataUrl || latest[0].url)) {
                              let dUrl = latest[0].dataUrl;
                              let bSize = latest[0].size || 0;
                              let bType = latest[0].type || 'video/mp4';
                              if (!dUrl && latest[0].url) {
                                try {
                                  const r = await fetch(latest[0].url);
                                  if (r.ok) {
                                    const b = await r.blob();
                                    bSize = b.size;
                                    bType = b.type;
                                    if (b.size >= 64 * 1024) dUrl = await toDataUrl(b);
                                  }
                                } catch (_) {}
                              }
                              if (dUrl && dUrl.startsWith('data:video/') && (bSize >= 64 * 1024 || dUrl.length > 50000)) {
                                return {
                                  media: {
                                    dataUrl: dUrl,
                                    url: latest[0].url || '',
                                    type: bType,
                                    size: bSize,
                                    source: 'interceptor'
                                  }
                                };
                              }
                            }
                          }

                          // 2. Hover over tiles to trigger video instantiation (v1.3.1 technique)
                          const flowTiles = Array.from(document.querySelectorAll([
                            'flow-video-tile',
                            'flow-grid-tile-container',
                            '[data-testid="virtuoso-item-list"] [data-index]',
                            '[data-tile-id]',
                          ].join(','))).filter(el => {
                            const r = el.getBoundingClientRect();
                            return r.width > 0 && r.height > 0;
                          });
                          for (const tile of flowTiles) {
                            try {
                              tile.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window }));
                              const hoverTarget = tile.querySelector?.('.container, img, video, flow-video-tile') || tile;
                              hoverTarget?.dispatchEvent?.(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window }));
                            } catch (_) {}
                          }

                          // 3. Find candidate video URLs excluding baseline videos
                          const initialSet = new Set(Array.isArray(baseline?.baselineVideos) ? baseline.baselineVideos : []);
                          const candidateSources = [];
                          for (const v of document.querySelectorAll('video')) {
                            const src = v.currentSrc || v.src || v.querySelector('source')?.src || '';
                            if (src && !initialSet.has(src) && !candidateSources.includes(src)) candidateSources.push(src);
                          }

                          // Also check flow tiles for video or /asb/ thumbnail video streams
                          for (const tile of flowTiles) {
                            const vid = tile.querySelector('video[aria-label="Generated video"], video');
                            let vsrc = vid?.currentSrc || vid?.src || vid?.getAttribute('src') || vid?.querySelector('source')?.src || '';
                            if (vsrc) {
                              if (vsrc.startsWith('/')) {
                                try { vsrc = new URL(vsrc, location.origin).href; } catch (_) {}
                              }
                              if (!initialSet.has(vsrc) && !candidateSources.includes(vsrc)) candidateSources.push(vsrc);
                            }
                            const img = tile.querySelector('flow-video-tile img, img[alt*="video" i], img[alt="Generated video thumbnail"], img');
                            const isrc = img?.src || img?.getAttribute('src') || '';
                            if (isrc && isrc.includes('/asb/')) {
                              const videoUrl = isrc.includes('=mm,') ? isrc : `${isrc}=mm,22,15`;
                              if (!initialSet.has(videoUrl) && !candidateSources.includes(videoUrl)) candidateSources.push(videoUrl);
                            }
                          }

                          // 4. Try to fetch the candidate video and convert to base64 DataURL (require >= 64KB)
                          for (const src of candidateSources) {
                            if (src && /^(https?:|blob:|data:video\/)/i.test(src)) {
                              try {
                                const response = await fetch(src);
                                if (!response.ok) continue;
                                const blob = await response.blob();
                                if (blob.size >= 64 * 1024) {
                                  const normalizedBlob = String(blob.type || '').startsWith('video/')
                                    ? blob
                                    : new Blob([blob], { type: /webm/i.test(src) ? 'video/webm' : 'video/mp4' });
                                  const dUrl = await toDataUrl(normalizedBlob);
                                  if (dUrl && dUrl.startsWith('data:video/')) {
                                    return {
                                      media: {
                                        url: src,
                                        dataUrl: dUrl,
                                        type: normalizedBlob.type,
                                        size: normalizedBlob.size,
                                        source: 'dom'
                                      }
                                    };
                                  }
                                }
                              } catch (_) {}
                            }
                          }

                          return { media: null };
                        }
                      }).catch(() => [null]);

                      const candMedia = pollRes?.result?.media;
                      const isStillGenerating = Boolean(vidSnap?.isGenerating);
                      const isProgressComplete = vidSnap?.progress === '100%' || Number(vidSnap?.blurProgress || 0) >= 95;

                      if (candMedia?.dataUrl && candMedia.dataUrl.startsWith('data:video/')) {
                        // Accept if generation completed and at least 20s have elapsed
                        if ((!isStillGenerating || isProgressComplete) && elapsed >= 20) {
                          capturedVideo = candMedia;
                          broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: `[ฉาก ${si + 1}] 🎥 ได้รับวิดีโอเรียบร้อย (${Math.round((candMedia.size || 0) / 1024)} KB, ${elapsed}s)` } });
                          break;
                        }
                        // Safety fallback: if elapsed >= 120s and we have a valid video >= 100KB
                        if (elapsed >= 120 && (candMedia.size || 0) >= 100 * 1024) {
                          capturedVideo = candMedia;
                          broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: `[ฉาก ${si + 1}] 🎥 ได้รับวิดีโอ (Timeout fallback, ${Math.round((candMedia.size || 0) / 1024)} KB)` } });
                          break;
                        }
                      }

                      // Check for failure
                      if (vidSnap?.failedCount > 0 && !vidSnap?.isGenerating && elapsed >= 25) {
                        broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: `[ฉาก ${si + 1}] ❌ วิดีโอ Failed: ${vidSnap.failedReason || 'Unknown'}` } });
                        break;
                      }
                    }

                    // ──────── Phase 3: Collect Scene Video ────────
                    if (capturedVideo?.dataUrl || capturedVideo?.url) {
                      ideaSceneVideos.push({
                        si,
                        beat: scene.beat || `ฉาก ${si + 1}`,
                        dataUrl: capturedVideo.dataUrl || '',
                        url: capturedVideo.url || '',
                        thumbnail: imgResult?.images?.[0]?.dataUrl || ''
                      });

                      broadcast({
                        type: 'PHIMBOT_FACTORY_STATUS',
                        payload: {
                          status: 'progress',
                          message: `✅ [ฉาก ${si + 1}/${ideaScenes.length}] สร้างคลิปฉากสำเร็จ! (${ideaSceneVideos.length}/${ideaScenes.length})`
                        }
                      });
                    } else {
                      broadcast({
                        type: 'PHIMBOT_FACTORY_STATUS',
                        payload: {
                          status: 'progress',
                          message: `⚠️ [ฉาก ${si + 1}/${ideaScenes.length}] ไม่สามารถดึงไฟล์วิดีโอฉากนี้ได้ (หมดเวลา)`
                        }
                      });
                    }

                  } catch (sceneErr) {
                    broadcast({
                      type: 'PHIMBOT_FACTORY_STATUS',
                      payload: {
                        status: 'progress',
                        message: `❌ [ฉาก ${si + 1}] เกิดข้อผิดพลาด: ${sceneErr.message}`
                      }
                    });
                  }

                  // ── Between scenes: New Project (matching OmniPost Hub) ──
                  if (si < ideaScenes.length - 1) {
                    broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'progress', message: `📁 สร้าง New Project ใหม่สำหรับฉากที่ ${si + 2}...` } });
                    await openFlowNewProject(flowTab.id, broadcast);
                  }
                } // end of si scenes loop

                // ──────── Phase 4: Merge Scenes of this Idea into ONE Video ────────
                if (ideaSceneVideos.length > 1) {
                  broadcast({
                    type: 'PHIMBOT_FACTORY_STATUS',
                    payload: {
                      status: 'progress',
                      message: `🎬 กำลังรวมคลิป ${ideaSceneVideos.length} ฉากเข้าด้วยกันเป็นคลิปเดียวด้วย FFmpeg WASM...`
                    }
                  });

                  let mergedVideoDataUrl = '';
                  try {
                    const videoInputs = ideaSceneVideos.map(v => v.dataUrl || v.url).filter(Boolean);
                    const compRes = await composeVideoScenesViaOffscreen(videoInputs, {
                      width: 720,
                      height: 1280,
                      fps: 30,
                      crf: 23,
                      mode: 'concat'
                    });
                    if (compRes?.ok && compRes.dataUrl) {
                      mergedVideoDataUrl = compRes.dataUrl;
                      broadcast({
                        type: 'PHIMBOT_FACTORY_STATUS',
                        payload: {
                          status: 'progress',
                          message: `🎉 รวมคลิป ${ideaSceneVideos.length} ฉากสำเร็จ! เป็นคลิปเดียวความยาวสมบูรณ์`
                        }
                      });
                    }
                  } catch (mergeErr) {
                    console.error('❌ Video merge failed:', mergeErr);
                    broadcast({
                      type: 'PHIMBOT_FACTORY_STATUS',
                      payload: {
                        status: 'progress',
                        message: `⚠️ รวมคลิปไม่สำเร็จ (${mergeErr.message}) — กำลังบันทึกแยกแต่ละฉากเพื่อป้องกันงานสูญหาย`
                      }
                    });
                  }

                  const store = await storageGet(['phimbot_media_vault']);
                  const vault = store.phimbot_media_vault || [];

                  const prodUrl = product.affiliateUrl || product.productUrl || product.offerUrl || product.url || product.link || '';
                  const cleanFactoryPid = String(product.tiktokProductId || product.productId || product.id || '').trim().replace(/^(PID_)?UNKNOWN$/i, '').replace(/^PID_/i, '').trim();

                  if (mergedVideoDataUrl) {
                    const videoId = `vid_${Date.now()}`;
                    const videoKey = `phimbot_video_${videoId}`;
                    await storageSet({ [videoKey]: mergedVideoDataUrl });
                    vault.unshift({
                      id: videoId,
                      productId: cleanFactoryPid,
                      productName: product.name,
                      productUrl: prodUrl,
                      headline: idea.headline,
                      beat: `คลิปเต็ม (${ideaSceneVideos.length} ฉาก)`,
                      videoBase64: '',
                      videoStorageKey: videoKey,
                      videoBase64Size: mergedVideoDataUrl.length,
                      videoUrl: '',
                      thumbnail: firstSceneThumbnail || ideaSceneVideos[0]?.thumbnail || '',
                      createdAt: new Date().toISOString(),
                      posted: { tiktok: false, reels: false, shopee: false }
                    });
                    await storageSet({ phimbot_media_vault: vault });

                    allResults.push({
                      product: product.name,
                      idea: idea.headline,
                      scene: `คลิปเต็ม (${ideaSceneVideos.length} ฉาก)`
                    });

                    broadcast({
                      type: 'PHIMBOT_FACTORY_STATUS',
                      payload: {
                        status: 'progress',
                        message: `💾 บันทึกวิดีโอตัวเต็มลงใน "คลัง" เรียบร้อย!`
                      }
                    });
                  } else {
                    // Fallback: save individual scenes
                    for (const sc of ideaSceneVideos) {
                      const scVidId = `vid_${Date.now()}_${sc.si}`;
                      const scVideoKey = `phimbot_video_${scVidId}`;
                      if (sc.dataUrl) await storageSet({ [scVideoKey]: sc.dataUrl });
                      vault.unshift({
                        id: scVidId,
                        productId: cleanFactoryPid,
                        productName: product.name,
                        productUrl: prodUrl,
                        headline: idea.headline,
                        beat: sc.beat,
                        videoBase64: '',
                        videoStorageKey: sc.dataUrl ? scVideoKey : '',
                        videoBase64Size: sc.dataUrl ? sc.dataUrl.length : 0,
                        videoUrl: sc.url,
                        thumbnail: sc.thumbnail || firstSceneThumbnail || '',
                        createdAt: new Date().toISOString(),
                        posted: { tiktok: false, reels: false, shopee: false }
                      });
                      allResults.push({
                        product: product.name,
                        idea: idea.headline,
                        scene: sc.beat
                      });
                    }
                    await storageSet({ phimbot_media_vault: vault });
                  }
                } else if (ideaSceneVideos.length === 1) {
                  // Single scene: save directly
                  const sc = ideaSceneVideos[0];
                  const store = await storageGet(['phimbot_media_vault']);
                  const vault = store.phimbot_media_vault || [];
                  const prodUrl = product.affiliateUrl || product.productUrl || product.offerUrl || product.url || product.link || '';
                  const cleanFactoryPid = String(product.tiktokProductId || product.productId || product.id || '').trim().replace(/^(PID_)?UNKNOWN$/i, '').replace(/^PID_/i, '').trim();
                  const singleVidId = `vid_${Date.now()}`;
                  const singleVideoKey = `phimbot_video_${singleVidId}`;
                  if (sc.dataUrl) await storageSet({ [singleVideoKey]: sc.dataUrl });
                  vault.unshift({
                    id: singleVidId,
                    productId: cleanFactoryPid,
                    productName: product.name,
                    productUrl: prodUrl,
                    headline: idea.headline,
                    beat: sc.beat,
                    videoBase64: '',
                    videoStorageKey: sc.dataUrl ? singleVideoKey : '',
                    videoBase64Size: sc.dataUrl ? sc.dataUrl.length : 0,
                    videoUrl: sc.url,
                    thumbnail: sc.thumbnail || firstSceneThumbnail || '',
                    createdAt: new Date().toISOString(),
                    posted: { tiktok: false, reels: false, shopee: false }
                  });
                  await storageSet({ phimbot_media_vault: vault });

                  allResults.push({
                    product: product.name,
                    idea: idea.headline,
                    scene: sc.beat
                  });

                  broadcast({
                    type: 'PHIMBOT_FACTORY_STATUS',
                    payload: {
                      status: 'progress',
                      message: `💾 บันทึกวิดีโอลงใน "คลัง" เรียบร้อย!`
                    }
                  });
                }
              }
            }

            // Cleanup & Finish
            if (flowTab?.id) await safeCloseTab(flowTab.id).catch(() => {});
            await closeOffscreenComposerDocument().catch(() => {});

            broadcast({
              type: 'PHIMBOT_FACTORY_STATUS',
              payload: {
                status: 'done',
                message: `🎉 ผลิตเสร็จสิ้น! ได้วิดีโอทั้งหมด ${allResults.length} รายการ`,
                results: allResults
              }
            });
            sendResponse({ success: true, results: allResults });

          } catch (factoryErr) {
            if (flowTab?.id) await safeCloseTab(flowTab.id).catch(() => {});
            await closeOffscreenComposerDocument().catch(() => {});
            broadcast({ type: 'PHIMBOT_FACTORY_STATUS', payload: { status: 'error', message: `❌ ล้มเหลว: ${factoryErr.message}` } });
            sendResponse({ success: false, error: factoryErr.message });
          }
          break;
        }

        case 'PHIMBOT_FLOW_PROGRESS':
        case 'PHIMBOT_FLOW_RESULTS':
        case 'PHIMBOT_FLOW_ERROR': {
          // These are forwarded from content script — relay to sidepanel
          broadcast(message);
          sendResponse({ success: true });
          break;
        }

        case 'ANTIGRAVITY_BRIDGE_WAKE': {
          await pollAntigravityBridgeOnce('wake_msg');
          sendResponse({ ok: true });
          break;
        }

        case 'PHIMBOT_DETECT_CHARACTER_GENDER': {
          const gRes = await detectCharacterGenderFromBase64(payload?.dataUrl || message?.dataUrl);
          if (gRes?.ok && gRes.gender) {
            await setFlowToolGenderInBrowser(gRes.gender);
          }
          sendResponse(gRes);
          break;
        }

        case 'PHIMBOT_SET_FLOW_GENDER': {
          const sRes = await setFlowToolGenderInBrowser(payload?.gender || message?.gender);
          sendResponse(sRes);
          break;
        }

        case 'ANTIGRAVITY_EXEC_CMD': {
          const outcome = await executeAntigravityCommand({
            id: 'ui_' + Date.now(),
            cmd: message.cmd || payload?.cmd,
            args: message.args || payload?.args || {},
          });
          try {
            await fetch(`${ANTIGRAVITY_BRIDGE_URL}/result`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id: 'ui_' + Date.now(),
                ok: Boolean(outcome?.ok),
                result: outcome,
                error: outcome?.error || null,
              }),
            });
          } catch (_) {}
          sendResponse(outcome);
          break;
        }

        case 'ASU_UPLOAD_CLIP_TO_RELAY':
        case 'PHIMBOT_COMPOSE_VIDEOS':
        case 'AG_SIDEPANEL_PING':
        case 'AG_SIDEPANEL_CMD':
        case 'META_AI_VIDEO_CAPTURED':
        case 'META_AI_STATUS':
        case 'PHIMBOT_TIKTOK_POST_PROGRESS':
        case 'PHIMBOT_SHOPEE_VIDEO_PROGRESS':
        case 'PHIMBOT_FB_REELS_PROGRESS':
          // จัดการโดย listener แยก หรือ Sidepanel / Offscreen — ห้ามเรียก sendResponse ที่นี่เด็ดขาด
          return;

        default:
          if (String(type || '').startsWith('ASU_') || String(type || '').startsWith('AG_') || String(type || '').startsWith('META_AI_')) {
            return;
          }
          sendResponse({ success: false, error: `Unknown: ${type}` });
      }
    } catch (err) {
      console.error(`[PhimBot] ${type}:`, err);
      sendResponse({ success: false, error: err.message });
    }
  };

  handle();
  return true;
});

/* ─── Side Panel + Install ────────────────────────────────────────────── */

chrome.runtime.onInstalled.addListener(async (details) => {
  try { if (chrome.sidePanel) { await chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true }); } } catch (e) { console.error('[PhimBot] sidePanel:', e); }
  try { chrome.alarms.create('ag-bridge-keepalive', { periodInMinutes: 0.4 }); } catch (_) {}

  if (details.reason === 'install') {
    const existing = await storageGet(Object.keys(DEFAULT_STORAGE));
    const toSet = {};
    for (const [key, value] of Object.entries(DEFAULT_STORAGE)) {
      if (existing[key] === undefined) toSet[key] = value;
    }
    if (Object.keys(toSet).length > 0) await storageSet(toSet);
  }
});

try { chrome.alarms.create('ag-bridge-keepalive', { periodInMinutes: 0.4 }); } catch (_) {}

chrome.action.onClicked.addListener(async (tab) => {
  if (chrome.sidePanel) {
    try { await chrome.sidePanel.open({ tabId: tab.id }); }
    catch { try { await chrome.sidePanel.open({ windowId: tab.windowId }); } catch (e) { console.error('[PhimBot] open:', e); } }
  } else {
    chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html') });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'ag-bridge-keepalive') {
    pollAntigravityBridgeOnce('alarm');
    return;
  }
  if (alarm.name === 'phimbot-keepalive' && !isQueueRunning) {
    chrome.alarms.clear('phimbot-keepalive').catch(() => {});
  }
});

console.log('[PhimBot] Background service worker loaded.');




/* ─── Facebook Reels Engine ──────────────────────────────────────────── */


function formatReelsCaption({ caption = '', affiliateUrl = '', hashtags = '' } = {}) {
  let rawCaption = String(caption || '').trim();
  let rawHashtags = String(hashtags || '').trim();

  // 1. Extract existing URL
  const urlMatch = rawCaption.match(/https?:\/\/[^\s#]+/i);
  let existingUrl = urlMatch ? urlMatch[0] : '';

  let gluedHashtags = [];
  const gluedMatch = rawCaption.match(/https?:\/\/[^\s#]+#([^\s#]+)/i);
  if (gluedMatch && gluedMatch[1]) {
    gluedHashtags.push('#' + gluedMatch[1]);
  }

  let finalUrl = String(affiliateUrl || '').trim();
  if (finalUrl && finalUrl.includes('affiliate.shopee.co.th')) {
    finalUrl = '';
  }
  if (!finalUrl && existingUrl) {
    finalUrl = existingUrl;
  }
  if (finalUrl && finalUrl.includes('#') && finalUrl.includes('s.shopee.co.th')) {
    const parts = finalUrl.split('#');
    finalUrl = parts[0];
    if (parts[1]) gluedHashtags.push('#' + parts[1]);
  }

  // 2. Extract hashtags
  const capHashtags = (rawCaption.match(/#[^\s#]+/g) || []);
  const fieldHashtags = (rawHashtags.match(/#[^\s#]+/g) || rawHashtags.split(/\s+/).filter(Boolean).map(h => h.startsWith('#') ? h : '#' + h));

  const allHashtags = [];
  const seen = new Set();
  for (const tag of [...fieldHashtags, ...capHashtags, ...gluedHashtags]) {
    const clean = tag.trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      allHashtags.push(clean);
    }
  }

  // 3. Clean body text
  let body = rawCaption;
  const fullUrlMatch = rawCaption.match(/https?:\/\/\S+/i);
  if (fullUrlMatch) {
    body = body.replace(fullUrlMatch[0], '');
  }
  body = body.replace(/🛒\s*(?:พิกัด(?:สินค้า)?[:\s]*)?/g, '');
  for (const h of capHashtags) {
    body = body.replace(h, '');
  }
  body = body.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim();

  // 4. Build 3 distinct clean sections
  const sections = [];
  if (body) sections.push(body);
  if (finalUrl) sections.push('🛒 พิกัดสินค้า: ' + finalUrl);
  if (allHashtags.length) sections.push(allHashtags.join(' '));

  return sections.join('\n\n');
}

async function prepareFbReelsUpload(payload) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Use pre-formatted 3-part layout
  const captionText = String(payload?.caption || '').trim();
  const scheduleMode = String(payload?.scheduleMode || 'now').toLowerCase() === 'scheduled' ? 'scheduled' : 'now';
  const scheduleDate = String(payload?.scheduleDate || '').trim();
  const scheduleTime = String(payload?.scheduleTime || '').trim();
  const aiLabelEnabled = payload?.aiLabelEnabled !== false;

  function log(msg, level = 'info') {
    console.log('[PhimBot FB Reels]', msg);
    try {
      chrome.runtime.sendMessage({ type: 'PHIMBOT_FB_REELS_PROGRESS', payload: { level, message: msg } });
    } catch (_) {}
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function dataUrlToFile(dataUrl, name) {
    if (!dataUrl || typeof dataUrl !== 'string') throw new Error('ไม่พบข้อมูลวิดีโอ (dataUrl ว่างเปล่า)');
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx === -1) throw new Error('รูปแบบ dataUrl ไม่ถูกต้อง (ไม่มี comma)');
    const meta = dataUrl.slice(0, commaIdx);
    const b64 = dataUrl.slice(commaIdx + 1);
    if (!b64) throw new Error('bad dataUrl: ข้อมูล base64 ว่างเปล่า');

    const mimeMatch = meta.match(/data:([^;]+)/);
    let mime = mimeMatch ? mimeMatch[1] : 'video/mp4';
    if (!mime || mime === 'application/octet-stream' || !mime.startsWith('video/')) {
      mime = 'video/mp4';
    }

    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const safeName = String(name || 'reel.mp4').replace(/[^a-zA-Z0-9._-]/g, '_') || 'reel.mp4';
    return new File([buf], safeName, { type: mime, lastModified: Date.now() });
  }

  function fireClick(el) {
    if (!el) return false;
    try {
      const rKey = Object.keys(el).find(k => k.startsWith('__reactProps'));
      if (rKey && typeof el[rKey].onClick === 'function') {
        el[rKey].onClick({ type: 'click', target: el, currentTarget: el, bubbles: true, cancelable: true, preventDefault(){}, stopPropagation(){}, nativeEvent: { target: el }, persist(){} });
        return true;
      }
    } catch (_) {}
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      el.click();
      return true;
    } catch (_) { return false; }
  }

  function pageText() {
    return (document.body?.innerText || '').replace(/\s+/g, ' ').toLowerCase();
  }

  function findCaptionFieldNow() {
    const selectors = [
      '[contenteditable="true"][data-lexical-editor="true"][aria-placeholder*="Reels" i]',
      '[contenteditable="true"][data-lexical-editor="true"][aria-placeholder*="reel" i]',
      '[contenteditable="true"][data-lexical-editor="true"][aria-placeholder*="อธิบายคลิป" i]',
      '[contenteditable="true"][role="textbox"][aria-placeholder*="Reels" i]',
      '[contenteditable="true"][role="textbox"][aria-placeholder*="อธิบายคลิป" i]',
      '[contenteditable="true"][aria-label*="Describe your reel" i]',
      '[contenteditable="true"][aria-label*="อธิบายคลิป" i]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }
    const candidates = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"][contenteditable="true"]')]
      .filter(el => {
        if (!isVisible(el)) return false;
        const txt = String(el.getAttribute('aria-label') || el.getAttribute('aria-placeholder') || '').toLowerCase();
        if (/comment|คอมเมนต์|reply|messenger|ค้นหา|search/.test(txt)) return false;
        const rect = el.getBoundingClientRect();
        return rect.height >= 32 && rect.width >= 220;
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect(); const br = b.getBoundingClientRect();
        return (br.width * br.height) - (ar.width * ar.height);
      });
    return candidates[0] || null;
  }

  function isOnReelsTrimPage() {
    const t = pageText();
    return t.includes('ตัดแต่งวิดีโอ') || t.includes('trim video')
      || t.includes('คำบรรยายทดแทนการได้ยิน') || t.includes('auto-generated captions');
  }

  async function clickBottomAction(texts, timeout = 18000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const normalize = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const keys = texts.map(normalize);
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], div[tabindex], span'));
      const scored = [];
      for (const n of nodes) {
        const raw = (n.innerText || n.textContent || n.getAttribute('aria-label') || '').trim();
        if (!raw || raw.length > 120) continue;
        const txt = normalize(raw);
        const exact = keys.some(k => txt === k);
        const partial = keys.some(k => txt.includes(k));
        if (!exact && !partial) continue;
        const clickable = n.closest('button, [role="button"], div[tabindex]') || n;
        if (!isVisible(clickable)) continue;
        const disabled = clickable.disabled || String(clickable.getAttribute('aria-disabled')).toLowerCase() === 'true';
        if (disabled) continue;
        const rect = clickable.getBoundingClientRect();
        if (rect.top >= (window.innerHeight - 450)) {
          scored.push({ node: clickable, score: exact ? 2 : 1, top: rect.top });
        }
      }
      if (scored.length) {
        scored.sort((a, b) => b.score !== a.score ? b.score - a.score : b.top - a.top);
        fireClick(scored[0].node);
        return true;
      }
      for (const n of nodes) {
        const raw = (n.innerText || n.textContent || n.getAttribute('aria-label') || '').trim();
        if (!raw || raw.length > 120) continue;
        const txt = normalize(raw);
        if (keys.some(k => txt === k)) {
          const clickable = n.closest('button, [role="button"], div[tabindex]') || n;
          if (isVisible(clickable)) {
            const disabled = clickable.disabled || String(clickable.getAttribute('aria-disabled')).toLowerCase() === 'true';
            if (!disabled) {
              fireClick(clickable);
              return true;
            }
          }
        }
      }
      await sleep(350);
    }
    return false;
  }

  function commitInputValue(el, value) {
    if (!el) return false;
    try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }
    try { el.setSelectionRange?.(0, String(el.value || '').length); } catch (_) {}

    let editedByBrowser = false;
    try {
      editedByBrowser = document.execCommand?.('insertText', false, String(value)) === true;
    } catch (_) {}

    if (!editedByBrowser) {
      const proto = (el.tagName || '').toLowerCase() === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter?.set) setter.set.call(el, value);
      else el.value = value;
    }

    try {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, data: String(value), inputType: 'insertReplacementText' }));
    } catch (_) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    try { el.blur?.(); } catch (_) {}
    return true;
  }

  function findFinalReelsSubmitButton({ allowPostFallback = false, includeDisabled = false } = {}) {
    const scheduleLabels = ['กำหนดเวลา', 'schedule'];
    const postLabels = ['โพสต์', 'post'];
    const labels = allowPostFallback ? [...scheduleLabels, ...postLabels] : scheduleLabels;
    const normalize = (s) => String(s || '')
      .normalize('NFC')
      .replace(/[\s\u200B-\u200D\uFEFF]+/g, ' ')
      .trim()
      .toLowerCase();
    const wanted = labels.map(normalize);

    const nodes = Array.from(document.querySelectorAll(
      'button, [role="button"], div[tabindex], input[type="button"], input[type="submit"], [aria-label], [title], span, div'
    ));
    const candidates = [];
    const seen = new Set();
    const hasReactClick = (node) => {
      try {
        const key = Object.keys(node || {}).find((name) => name.startsWith('__reactProps'));
        return !!(key && typeof node[key]?.onClick === 'function');
      } catch (_) { return false; }
    };

    for (const seed of nodes) {
      if (!isVisible(seed)) continue;
      const values = [
        seed.getAttribute?.('aria-label'),
        seed.getAttribute?.('title'),
        seed.value,
        seed.innerText,
        seed.textContent,
      ].map((value) => ({ raw: String(value || '').trim(), normalized: normalize(value) }))
        .filter((entry) => entry.normalized && entry.normalized.length <= 80);
      const matchedValue = values.find((entry) => wanted.includes(entry.normalized));
      if (!matchedValue) continue;

      let clickable = null;
      for (let cursor = seed, depth = 0; cursor && depth < 8; depth += 1, cursor = cursor.parentElement) {
        const tag = String(cursor.tagName || '').toLowerCase();
        const role = String(cursor.getAttribute?.('role') || '').toLowerCase();
        const isClickSurface = tag === 'button'
          || tag === 'input'
          || role === 'button'
          || Number(cursor.tabIndex) >= 0
          || hasReactClick(cursor);
        if (!isClickSurface) continue;
        clickable = cursor;
        break;
      }
      if (!clickable) clickable = seed;
      if (seen.has(clickable) || !isVisible(clickable)) continue;
      seen.add(clickable);

      const disabled = !!(
        clickable.disabled
        || clickable.hasAttribute?.('disabled')
        || String(clickable.getAttribute?.('aria-disabled')).toLowerCase() === 'true'
        || String(getComputedStyle(clickable).pointerEvents).toLowerCase() === 'none'
      );
      if (disabled && !includeDisabled) continue;
      const rect = clickable.getBoundingClientRect();
      const role = String(clickable.getAttribute?.('role') || '').toLowerCase();
      const tag = String(clickable.tagName || '').toLowerCase();
      const matched = labels.find((label) => normalize(label) === matchedValue.normalized) || matchedValue.raw;
      let score = /กำหนดเวลา|schedule/i.test(matched) ? 120 : 80;
      if (tag === 'button' || role === 'button') score += 30;
      if (seed.getAttribute?.('aria-label')) score += 15;
      if (rect.top >= window.innerHeight * 0.5) score += 20;
      if (rect.width >= 70 && rect.height >= 24 && rect.height <= 100) score += 10;
      candidates.push({
        node: clickable,
        top: rect.top,
        label: matched,
        disabled,
        ready: !disabled,
        score,
        matchSource: seed.getAttribute?.('aria-label') ? 'aria-label' : 'text',
      });
    }
    if (!candidates.length) return null;

    const scheduleCandidates = candidates.filter((candidate) => /กำหนดเวลา|schedule/i.test(String(candidate.label || '')));
    const rankedCandidates = scheduleCandidates.length ? scheduleCandidates : candidates;
    rankedCandidates.sort((a, b) => {
      if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
      if (b.score !== a.score) return b.score - a.score;
      return b.top - a.top;
    });
    return rankedCandidates[0];
  }

  function isFinalReelsScheduleSurfaceVisible() {
    const t = pageText();
    if (t.includes('การตั้งค่าคลิป reels') || t.includes('reel settings')) return true;
    const hasSettingsMarker = /ตัวเลือกการกำหนดเวลา|scheduling options|schedule options|เพิ่มป้าย ai|add ai label|โปรโมทคลิป reels|promote reel|การรีมิกซ์|remixing/i.test(t);
    const hasSubmitBtn = !!findFinalReelsSubmitButton({ allowPostFallback: true, includeDisabled: true });
    return hasSettingsMarker && hasSubmitBtn;
  }

  function checkReelsErrors() {
    const t = (document.body?.innerText || '').toLowerCase();
    const errorKeywords = [
      'เวลาที่กำหนดต้องอยู่ระหว่าง',
      'scheduled time must be between',
      'ไม่สามารถอัพโหลด',
      'ไม่สามารถอัปโหลด',
      'ไม่สามารถอัพโหลดไฟล์',
      'ไม่สามารถอัปโหลดไฟล์',
      "couldn't upload",
      'could not upload',
      'upload failed',
      'ไม่สามารถประมวลผล',
      'เกิดข้อผิดพลาด',
      'something went wrong',
      "couldn't share",
      'could not share',
      'ไม่สามารถแชร์',
      'ไม่สามารถกำหนดเวลา',
      'failed to schedule',
      'โปรดลองอีกครั้ง',
      'please try again'
    ];
    for (const kw of errorKeywords) {
      if (t.includes(kw)) {
        const dialogs = [...document.querySelectorAll('[role="alert"], [role="alertdialog"], [data-testid*="error"]')].filter(isVisible);
        for (const d of dialogs) {
          const dt = (d.innerText || d.textContent || '').trim();
          if (dt && dt.length < 250) return dt;
        }
        const matchingNode = [...document.querySelectorAll('span, div, p')].find(n => {
          if (!isVisible(n)) return false;
          const text = (n.innerText || n.textContent || '').trim();
          return text.toLowerCase().includes(kw) && text.length > 5 && text.length < 150;
        });
        if (matchingNode) return (matchingNode.innerText || matchingNode.textContent || '').trim();
        return `Facebook error: ${kw}`;
      }
    }
    return null;
  }

  async function waitForScheduleConfirmation(timeout = 35000) {
    const startTime = Date.now();
    log('⏳ กำลังรอ Facebook ยืนยันผลการบันทึก...');
    let closedCount = 0;
    while (Date.now() - startTime < timeout) {
      const err = checkReelsErrors();
      if (err) {
        log('❌ Facebook แจ้งเตือน: ' + err, 'error');
        return { confirmed: false, error: err };
      }

      const currentUrl = window.location.href;
      if (!currentUrl.includes('/reels/create')) {
        log('✅ Facebook เปลี่ยนหน้าเว็บแล้ว (' + currentUrl + ')', 'ok');
        return { confirmed: true, signal: 'URL เปลี่ยน' };
      }

      const t = (document.body?.innerText || '').toLowerCase();
      const successKeywords = [
        'กำหนดเวลาแล้ว',
        'กำหนดเวลาคลิป reels แล้ว',
        'แชร์คลิป reels แล้ว',
        'your reel has been scheduled',
        'reel scheduled',
        'your post is now scheduled',
        'กำลังเผยแพร่',
        'เผยแพร่แล้ว',
        'แชร์แล้ว',
        'reel shared',
        'post shared'
      ];
      for (const kw of successKeywords) {
        if (t.includes(kw)) {
          log('✅ ได้รับการยืนยันจาก Facebook: ' + kw, 'ok');
          return { confirmed: true, signal: kw };
        }
      }

      if (!isFinalReelsScheduleSurfaceVisible()) {
        closedCount++;
        if (closedCount >= 3) {
          log('✅ หน้าต่างตั้งค่า Reels ปิดลงอย่างสมบูรณ์แล้ว', 'ok');
          return { confirmed: true, signal: 'หน้าตั้งค่าปิดแล้ว' };
        }
      } else {
        closedCount = 0;
      }

      await sleep(500);
    }
    return { confirmed: false, error: 'Facebook ไม่ได้ยืนยันการบันทึกภายในเวลาที่กำหนด (อาจเน็ตช้าหรือประมวลผลนาน)' };
  }

  function focusEditorEnd(el) {
    el.focus();
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
  }

  function insertEditorBreak(el) {
    focusEditorEnd(el);
    let ok = false;
    try { ok = document.execCommand('insertParagraph', false, null); } catch (_) {}
    if (!ok) {
      try { ok = document.execCommand('insertHTML', false, '<br>'); } catch (_) {}
    }
    dispatchEditorEvents(el, 'insertParagraph');
    return ok;
  }

  function insertEditorTextNative(el, text) {
    if (!el) return false;
    const value = String(text || '');
    if (!value) return true;
    focusEditorEnd(el);
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, value);
    } catch (_) {
      inserted = false;
    }
    if (!inserted) {
      try {
        inserted = document.execCommand('insertHTML', false, value.replace(/[&<>"']/g, ch => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch])));
      } catch (_) {
        inserted = false;
      }
    }
    dispatchEditorEvents(el, 'insertText');
    return inserted;
  }

  function dispatchEditorEvents(el, inputType = 'insertText') {
    if (!el) return;
    try { el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType })); } catch (_) {}
    try { el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType })); } catch (_) {}
    try { el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true })); } catch (_) {}
    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
    try { el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Process', code: 'Process' })); } catch (_) {}
  }

  async function replaceEditorText(editor, text) {
    if (!editor) return false;
    const cleanText = String(text || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!cleanText) return true;

    editor.focus();
    await sleep(150);

    // 1. Clear editor completely
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete', false, null);
    } catch (_) {}
    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    } catch (_) {}
    try {
      editor.textContent = '';
      editor.innerHTML = '';
    } catch (_) {}
    await sleep(100);

    // 2. Insert lines natively with zero-width space spacer for empty lines
    const lines = cleanText.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        insertEditorBreak(editor);
        await sleep(30);
      }
      const line = lines[i];
      if (line) {
        insertEditorTextNative(editor, line);
      } else {
        // Zero-width space preserves blank line in Lexical editor
        try { document.execCommand('insertText', false, '\u200B'); } catch (_) {}
      }
      await sleep(20);
    }

    dispatchEditorEvents(editor, 'insertReplacementText');
    await sleep(100);
    log('✅ ใส่ข้อความแคปชั่นเรียบร้อย: ' + cleanText.slice(0, 40) + '...');
    editor.blur();
    return true;
  }

  function findAiLabelToggle() {
    const matchers = ['เพิ่มป้าย ai', 'add ai label', 'ai label', 'ป้ายกำกับ ai'];
    const normalize = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const allNodes = [...document.querySelectorAll('div, span, label, [role="switch"], input[type="checkbox"]')];
    const directSwitch = allNodes.find(el => {
      if (!isVisible(el)) return false;
      const txt = normalize((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || ''));
      return String(el.getAttribute('role') || '').toLowerCase() === 'switch' && matchers.some(k => txt.includes(k));
    });
    if (directSwitch) return directSwitch;
    const labelNode = allNodes.find(el => {
      if (!isVisible(el)) return false;
      const txt = normalize((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || ''));
      return matchers.some(k => txt.includes(k));
    });
    if (!labelNode) return null;
    let scope = labelNode;
    for (let depth = 0; depth < 7 && scope; depth++) {
      const switches = Array.from(scope.querySelectorAll ? scope.querySelectorAll('[role="switch"], input[type="checkbox"], [aria-checked]') : []).filter(isVisible);
      if (switches[0]) return switches[0];
      scope = scope.parentElement;
    }
    return null;
  }

  async function ensureAiLabel(enable) {
    const toggle = findAiLabelToggle();
    if (!toggle) return;
    const isChecked = toggle.getAttribute('aria-checked') === 'true' || toggle.checked === true;
    if (enable !== isChecked) {
      const clickable = toggle.closest('[role="switch"], button, [role="button"], label, div[tabindex]') || toggle;
      fireClick(clickable);
      await sleep(800);
    }
  }

  // ─── MAIN FLOW ───
  try {
    log('Starting Reels upload flow');
    let nextClicks = 0;
    let reachedCaptionPage = false;

    // Step 1: Read media from storage
    const stored = await chrome.storage.local.get(['phimbot_fb_reels_media']);
    const mediaData = stored?.phimbot_fb_reels_media;
    if (!mediaData || !mediaData.length || !mediaData[0]?.dataUrl) {
      return { ok: false, reason: 'No media data in storage' };
    }

    // Step 2: Find video input
    let fileInput = document.querySelector('input[type="file"][accept*="video"]');
    if (!fileInput) {
      const allInputs = [...document.querySelectorAll('input[type="file"]')];
      fileInput = allInputs.find(i => isVisible(i) || i.closest('[role="dialog"]'));
    }
    if (!fileInput) {
      await clickBottomAction(['เพิ่มวิดีโอ', 'อัปโหลดวิดีโอ', 'add video', 'upload video'], 8000);
      await sleep(1000);
      fileInput = document.querySelector('input[type="file"][accept*="video"]') || document.querySelector('input[type="file"]');
    }
    if (!fileInput) {
      return { ok: false, reason: 'Cannot find video input element' };
    }

    // Step 3: Inject video file
    let file;
    try {
      file = dataUrlToFile(mediaData[0].dataUrl, mediaData[0].name || 'reel.mp4');
    } catch (parseErr) {
      log('❌ ข้อมูลไฟล์วิดีโอเสียหาย: ' + parseErr.message, 'error');
      return { ok: false, reason: 'ข้อมูลไฟล์วิดีโอเสียหาย: ' + parseErr.message };
    }

    // ── Pre-upload Validation: File Size & Header ──
    if (file.size < 100 * 1024) {
      log('❌ ขนาดไฟล์วิดีโอเล็กเกินไป (' + Math.round(file.size / 1024) + ' KB) อาจบันทึกไม่สมบูรณ์', 'error');
      return { ok: false, reason: 'ไฟล์วิดีโอเล็กผิดปกติ (' + Math.round(file.size / 1024) + ' KB) อาจเสียหายระหว่างบันทึก' };
    }

    try {
      const headerBytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      const ftypStr = String.fromCharCode(headerBytes[4], headerBytes[5], headerBytes[6], headerBytes[7]);
      if (ftypStr !== 'ftyp') {
        log('⚠️ Header ไฟล์ไม่ใช่ ftyp (' + ftypStr + ') — ไฟล์อาจไม่ใช่ MP4 มาตรฐาน', 'warn');
      } else {
        log('✅ ตรวจสอบไฟล์ผ่าน: ' + file.name + ' (' + (file.size / (1024 * 1024)).toFixed(2) + ' MB)');
      }
    } catch (hErr) {
      console.warn('Cannot read header bytes:', hErr);
    }

    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('input', { bubbles: true }));
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    log('Video file injected, waiting for upload processing...');

    // Step 4: Wait for Facebook to process (12s)
    await sleep(12000);

    // ── Immediate Error Check after upload processing ──
    const immediateErr = checkReelsErrors();
    if (immediateErr) {
      log('❌ Facebook ปฏิเสธการอัปโหลดไฟล์: ' + immediateErr, 'error');
      return { ok: false, reason: 'Facebook ปฏิเสธไฟล์: ' + immediateErr };
    }

    // Step 5: Click Next (ถัดไป) — first time
    let clicked = await clickBottomAction(['ถัดไป', 'ต่อไป', 'Next'], 45000);
    if (clicked) { nextClicks++; log('Clicked Next #1'); await sleep(3000); }

    // Step 6: Handle trim page
    if (isOnReelsTrimPage() || !findCaptionFieldNow()) {
      clicked = await clickBottomAction(['ถัดไป', 'ต่อไป', 'Next'], 18000);
      if (clicked) { nextClicks++; log('Clicked Next #2 (trim page)'); await sleep(3000); }
    }

    // Step 7: Wait for caption field
    let captionField = null;
    for (let i = 0; i < 30; i++) {
      captionField = findCaptionFieldNow();
      if (captionField) break;
      await sleep(500);
    }

    if (captionField) {
      reachedCaptionPage = true;
      log('Caption field found');

      // Step 8: Insert caption
      if (captionText) {
        await replaceEditorText(captionField, captionText);
        log('Caption inserted: ' + captionText.substring(0, 50) + '...');
        await sleep(1000);
      }

      // Step 9: AI Label
      if (aiLabelEnabled) {
        await ensureAiLabel(true);
        log('AI label toggled');
      }

      // Step 10: Schedule or Immediate post
      if (scheduleMode === 'scheduled' && scheduleDate && scheduleTime) {
        log(`🗓️ โหมดกำหนดเวลา: วันที่ ${scheduleDate} เวลา ${scheduleTime}`);
        await sleep(2000);

        // Step 10.1: Open "ตัวเลือกการกำหนดเวลา"
        let schedOpened = false;
        for (let attempt = 1; attempt <= 3 && !schedOpened; attempt++) {
          schedOpened = await clickBottomAction([
            'ตัวเลือกการกำหนดเวลา',
            'Scheduling options',
            'Schedule options'
          ], 8000);
          if (schedOpened) break;
          await sleep(1000);
        }
        if (!schedOpened) {
          return { ok: false, reason: 'ไม่พบเมนู "ตัวเลือกการกำหนดเวลา" บนหน้าการตั้งค่า Reels', reachedCaptionPage };
        }
        await sleep(1500);

        // Helper: Find schedule dialog
        const findScheduleRoot = () => {
          const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(isVisible);
          const exact = dialogs.find(d => {
            const t = (d.innerText || d.textContent || '').toLowerCase();
            return t.includes('ตัวเลือกการกำหนดเวลา') || t.includes('schedule options') || t.includes('เลือกวันที่และเวลา');
          });
          return exact || (dialogs.length ? dialogs[dialogs.length - 1] : document);
        };

        // Step 10.2: Set Date
        const [y, mo, d] = scheduleDate.split('-');
        const thaiMonths = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
        const thaiDate = d + ' ' + thaiMonths[parseInt(mo) - 1] + ' ' + y;
        const slashDate = String(d).padStart(2, '0') + '/' + String(mo).padStart(2, '0') + '/' + y;

        const scope = findScheduleRoot();
        const allInputs = [...scope.querySelectorAll('input[role="combobox"], input[aria-haspopup="listbox"], input[type="text"], input[type="date"], input[type="time"], input')].filter(isVisible);

        const dateEl = allInputs.find(el => {
          const ctx = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || '') + ' ' + (el.closest('label')?.innerText || '')).toLowerCase();
          return /วันที่|date|dd\/mm|วว\/ดด/.test(ctx);
        }) || allInputs[0];

        if (dateEl) {
          log('📅 ใส่วันที่: ' + slashDate);
          for (const fmt of [slashDate, thaiDate, scheduleDate]) {
            commitInputValue(dateEl, fmt);
            await sleep(300);
            const after = String(dateEl.value || dateEl.textContent || '').trim();
            const nums = after.match(/\d{1,4}/g) || [];
            if (nums.some(n => Number(n) === Number(d)) && nums.some(n => Number(n) === Number(y) && n.length === 4)) {
              log('✅ ตรวจสอบวันที่ถูกต้อง: ' + after);
              break;
            }
          }
        }

        await sleep(600);

        // Step 10.3: Set Time
        let [hh, mm] = scheduleTime.split(':').map(Number);
        const hh24 = String(hh).padStart(2, '0');
        const mmStr = String(mm).padStart(2, '0');
        const ampm = hh >= 12 ? 'PM' : 'AM';
        const h12 = hh % 12 === 0 ? 12 : hh % 12;
        const padH12 = String(h12).padStart(2, '0');

        const timeFormats = [
          `${hh24}:${mmStr}`,
          `${hh24}:${mmStr} น.`,
          `${padH12}:${mmStr} ${ampm}`,
          `${padH12}:${mmStr}${ampm}`,
          `${h12}:${mmStr} ${ampm}`,
          `${h12}:${mmStr}${ampm}`,
          `${padH12}:${mmStr} ${ampm.toLowerCase()}`,
          `${h12}:${mmStr} ${ampm.toLowerCase()}`
        ];

        const timeEl = allInputs.find(el => {
          const ctx = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || '') + ' ' + (el.closest('label')?.innerText || '')).toLowerCase();
          return /เวลา|time|hh:mm/.test(ctx);
        }) || allInputs[1];

        if (timeEl) {
          log('🕒 ใส่เวลา: ' + hh24 + ':' + mmStr);
          for (const fmt of timeFormats) {
            commitInputValue(timeEl, fmt);
            await sleep(300);
            const after = String(timeEl.value || timeEl.textContent || '').trim();
            if (after.includes(mmStr)) {
              log('✅ ตรวจสอบเวลาถูกต้อง: ' + after);
              break;
            }
          }
        }

        await sleep(1000);

        // Step 10.4: Click "กำหนดเวลาเริ่มเป็นภายหลัง" (Schedule for later) to SAVE and CLOSE dialog
        log('บันทึกหน้าต่างตั้งเวลา: กำหนดเวลาเริ่มเป็นภายหลัง...');
        const SCHED_SELECTORS = [
          '[aria-label="กำหนดเวลาเริ่มเป็นภายหลัง"][role="button"]',
          '[aria-label="Schedule for later"][role="button"]',
          'button[aria-label="กำหนดเวลาเริ่มเป็นภายหลัง"]',
          'button[aria-label="Schedule for later"]',
        ];

        let confirmed = false;
        for (let attempt = 0; attempt < 5; attempt++) {
          let confirmBtn = null;
          for (const sel of SCHED_SELECTORS) {
            const el = document.querySelector(sel);
            if (el && isVisible(el)) { confirmBtn = el; break; }
          }
          if (!confirmBtn) {
            const schedDialog = findScheduleRoot();
            confirmBtn = [...schedDialog.querySelectorAll('button, [role="button"], div[tabindex]')].find(b => {
              if (!isVisible(b)) return false;
              const t = (b.innerText || b.textContent || b.getAttribute('aria-label') || '').trim();
              return /กำหนดเวลาเริ่มเป็นภายหลัง|schedule for later/i.test(t);
            });
          }
          if (confirmBtn) {
            confirmBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await sleep(200);
            try { confirmBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })); } catch (_) {}
            try { confirmBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); } catch (_) {}
            try { confirmBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true })); } catch (_) {}
            try { confirmBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true })); } catch (_) {}
            confirmBtn.click();
            confirmed = true;
            log('กดปุ่ม กำหนดเวลาเริ่มเป็นภายหลัง เรียบร้อย');
            break;
          }
          await sleep(500);
        }

        // Wait for dialog to close
        for (let w = 0; w < 25; w++) {
          const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(isVisible);
          const stillOpen = dialogs.some(d => {
            const t = (d.innerText || d.textContent || '').toLowerCase();
            return t.includes('ตัวเลือกการกำหนดเวลา') || t.includes('schedule options') || t.includes('เลือกวันที่และเวลา');
          });
          if (!stillOpen) {
            log('หน้าต่างตั้งเวลาปิดแล้ว');
            break;
          }
          await sleep(300);
        }

        await sleep(1500);

        // Step 10.5: Check early error after closing dialog (e.g. time < 20 min)
        const earlyErr = checkReelsErrors();
        if (earlyErr) {
          log('❌ Facebook แจ้งเตือน: ' + earlyErr, 'error');
          return { ok: false, reason: earlyErr, nextClicks, reachedCaptionPage };
        }

        // Step 10.6: Find and wait for the final Schedule button on the main settings page
        log('⏳ กำลังค้นหาปุ่ม "กำหนดเวลา" บนหน้าหลัก และรอให้พร้อมใช้งาน...');
        let submitBtn = null;
        const waitBtnStart = Date.now();
        while (Date.now() - waitBtnStart < 40000) {
          submitBtn = findFinalReelsSubmitButton({ allowPostFallback: false, includeDisabled: true });
          if (submitBtn) {
            if (submitBtn.ready) {
              log(`🔵 พบปุ่ม “${submitBtn.label}” และพร้อมกดแล้ว!`, 'ok');
              break;
            } else {
              log(`⏳ พบปุ่ม “${submitBtn.label}” แต่ Facebook ยังไม่เปิดให้กด (กำลังประมวลผลวิดีโอ)...`, 'info');
            }
          }
          const errCheck = checkReelsErrors();
          if (errCheck) {
            return { ok: false, reason: errCheck, nextClicks, reachedCaptionPage };
          }
          await sleep(1000);
        }

        if (!submitBtn || submitBtn.disabled) {
          return {
            ok: false,
            reason: submitBtn?.disabled
              ? 'ปุ่ม "กำหนดเวลา" ยังคงถูกปิดใช้งาน (Facebook กำลังประมวลผลวิดีโอ หรือเวลาที่เลือกไม่ถูกต้อง)'
              : 'ไม่พบปุ่ม "กำหนดเวลา" บนหน้าการตั้งค่า',
            nextClicks,
            reachedCaptionPage
          };
        }

        // Step 10.7: Check Dry-Run Verified Mode before clicking final submit button
        const dryCfgSched = await chrome.storage.local.get(['ag_e2e_dry_run']);
        if (dryCfgSched?.ag_e2e_dry_run) {
          log(`🛡️ [DRY-RUN VERIFIED] พบปุ่ม “${submitBtn.label}” พร้อมกดแล้ว — หยุดก่อนกดปุ่มเผยแพร่จริงตามโหมดทดสอบปลอดภัย`, 'ok');
          return { ok: true, dryRunVerified: true, posted: false, scheduled: true, buttonLabel: submitBtn.label, nextClicks, reachedCaptionPage };
        }

        log(`🖱️ กำลังกดปุ่ม “${submitBtn.label}”...`);
        submitBtn.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(400);
        submitBtn.node.focus?.({ preventScroll: true });
        try { submitBtn.node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })); } catch (_) {}
        try { submitBtn.node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); } catch (_) {}
        try { submitBtn.node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true })); } catch (_) {}
        try { submitBtn.node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true })); } catch (_) {}
        submitBtn.node.click();

        // Step 10.8: Strict verification
        const verification = await waitForScheduleConfirmation(35000);
        if (verification.confirmed) {
          log('🎉 กำหนดเวลา Reels สำเร็จเรียบร้อย! (' + verification.signal + ')', 'ok');
          await sleep(4000);
          return { ok: true, posted: true, scheduled: true, nextClicks, reachedCaptionPage };
        } else {
          log('❌ ' + (verification.error || 'ไม่ได้รับการยืนยันจาก Facebook'), 'error');
          return {
            ok: false,
            reason: verification.error || 'Facebook ไม่ได้ยืนยันการตั้งเวลา (เก็บแท็บไว้เพื่อให้คุณตรวจสอบ)',
            nextClicks,
            reachedCaptionPage
          };
        }
      } else {
        // Immediate post
        log('Immediate post mode. Waiting for copyright check...');
        let isSafe = false;
        for (let i = 0; i < 60; i++) {
          const t = pageText();
          if (t.includes('ปลอดภัยที่จะเผยแพร่') || t.includes('safe to share') || t.includes('safe to post')) {
            isSafe = true; break;
          }
          if (t.includes('กำลังตรวจหาเนื้อหาที่มีลิขสิทธิ์') || t.includes('checking for copyrighted')) {
            await sleep(2000); continue;
          }
          await sleep(2000);
        }
        log('Copyright check: ' + (isSafe ? 'safe' : 'timeout/unknown'));
        await sleep(1000);

        log('⏳ กำลังค้นหาปุ่ม "โพสต์" บนหน้าหลัก และรอให้พร้อมใช้งาน...');
        let postBtn = null;
        const waitPostStart = Date.now();
        while (Date.now() - waitPostStart < 35000) {
          postBtn = findFinalReelsSubmitButton({ allowPostFallback: true, includeDisabled: true });
          if (postBtn) {
            if (postBtn.ready) {
              log(`🔵 พบปุ่ม “${postBtn.label}” และพร้อมกดแล้ว!`, 'ok');
              break;
            } else {
              log(`⏳ พบปุ่ม “${postBtn.label}” แต่ยังถูกปิดใช้งาน (กำลังอัปโหลดวิดีโอ)...`, 'info');
            }
          }
          const errCheck = checkReelsErrors();
          if (errCheck) {
            return { ok: false, reason: errCheck, nextClicks, reachedCaptionPage };
          }
          await sleep(1000);
        }

        if (!postBtn || postBtn.disabled) {
          return {
            ok: false,
            reason: postBtn?.disabled ? 'ปุ่ม "โพสต์" ยังถูกปิดใช้งาน (วิดีโอยังอัปโหลดไม่เสร็จ)' : 'ไม่พบปุ่ม "โพสต์"',
            nextClicks,
            reachedCaptionPage
          };
        }

        const dryCfgPost = await chrome.storage.local.get(['ag_e2e_dry_run']);
        if (dryCfgPost?.ag_e2e_dry_run) {
          log(`🛡️ [DRY-RUN VERIFIED] พบปุ่ม “${postBtn.label}” พร้อมกดแล้ว — หยุดก่อนกดปุ่มโพสต์จริงตามโหมดทดสอบปลอดภัย`, 'ok');
          return { ok: true, dryRunVerified: true, posted: false, scheduled: false, buttonLabel: postBtn.label, nextClicks, reachedCaptionPage };
        }

        log(`🖱️ กำลังกดปุ่ม “${postBtn.label}”...`);
        postBtn.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(400);
        postBtn.node.focus?.({ preventScroll: true });
        try { postBtn.node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })); } catch (_) {}
        try { postBtn.node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); } catch (_) {}
        try { postBtn.node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true })); } catch (_) {}
        try { postBtn.node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true })); } catch (_) {}
        postBtn.node.click();

        const verification = await waitForScheduleConfirmation(35000);
        if (verification.confirmed) {
          log('🎉 โพสต์ Reels สำเร็จเรียบร้อย! (' + verification.signal + ')', 'ok');
          await sleep(4000);
          return { ok: true, posted: true, nextClicks, reachedCaptionPage };
        } else {
          return {
            ok: false,
            reason: verification.error || 'Facebook ไม่ได้ยืนยันการโพสต์ (เก็บแท็บไว้ให้ตรวจสอบ)',
            nextClicks,
            reachedCaptionPage
          };
        }
      }
    } else {
      return { ok: false, reason: 'Caption field not found - stuck in wizard', nextClicks, reachedCaptionPage: false };
    }
  } catch (err) {
    return { ok: false, reason: err.message || 'Unknown error' };
  }
}

async function runFbReelsPost(config) {
  const broadcast = (level, message) => {
    try {
      chrome.runtime.sendMessage({ type: 'PHIMBOT_FB_REELS_PROGRESS', payload: { level, message } });
    } catch (_) {}
  };
  try {
    broadcast('info', '📤 กำลังเตรียมข้อมูลวิดีโอ...');
    // 1. Get media from config or storage
    let mediaFiles = config.mediaFiles;
    if (!mediaFiles || !mediaFiles.length) {
      const res = await chrome.storage.local.get(['phimbot_fb_reels_media']);
      mediaFiles = res.phimbot_fb_reels_media;
    }
    if (!mediaFiles || !mediaFiles.length) {
      return { ok: false, reason: 'No media files found' };
    }

    // 2. Store media in storage (video dataUrl is too large for executeScript args)
    await chrome.storage.local.set({ phimbot_fb_reels_media: mediaFiles });

    // 3. Open Facebook Reels tab
    broadcast('info', '🌐 กำลังเปิดหน้า Facebook Reels (รอ 10 วิ)...');
    const tab = await chrome.tabs.create({ url: 'https://www.facebook.com/reels/create/', active: true });
    const tabId = tab.id;
    await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});

    // 4. Wait for tab to fully load
    await new Promise(r => setTimeout(r, 10000));

    // 5. Build config without large media data (script reads from storage)
    const lightConfig = { ...config };
    delete lightConfig.mediaFiles;
    delete lightConfig.videoDataUrl;
    if (lightConfig.caption) {
      lightConfig.caption = formatReelsCaption({ caption: lightConfig.caption });
    }

    // 6. Inject automation script
    let execResults;
    try {
      execResults = await chrome.scripting.executeScript({
        target: { tabId },
        func: prepareFbReelsUpload,
        args: [lightConfig]
      });
    } catch (scriptErr) {
      console.error('[PhimBot] executeScript threw error:', scriptErr);
      return { ok: false, reason: 'รันสคริปต์ไม่สำเร็จ: ' + (scriptErr.message || String(scriptErr)) };
    }

    const res = execResults?.[0]?.result || { ok: false, reason: 'No result from script' };

    // 7. Cleanup: close tab ONLY if confirmed success and closeTabWhenDone
    if (res.ok && config.closeTabWhenDone && tabId) {
      broadcast('info', '⏳ รอปิดแท็บ 3 วินาที...');
      await new Promise(r => setTimeout(r, 3000));
      try { await chrome.tabs.remove(tabId); } catch (_) {}
    } else if (!res.ok) {
      broadcast('warn', '⚠️ โพสต์ไม่สำเร็จ (' + (res.reason || 'ไม่ทราบสาเหตุ') + ') — เก็บแท็บ Facebook ไว้ให้คุณตรวจสอบ');
    }

    // 8. Cleanup: remove media from storage
    await chrome.storage.local.remove('phimbot_fb_reels_media').catch(() => {});

    return res;
  } catch (err) {
    return { ok: false, reason: err.message || 'runFbReelsPost error' };
  }
}

async function runShopeePost(job) {
  const broadcast = (level, message) => {
    try {
      chrome.runtime.sendMessage({ type: 'PHIMBOT_SHOPEE_VIDEO_PROGRESS', payload: { level, message } });
      chrome.runtime.sendMessage({ type: 'PHIMBOT_QUEUE_PROGRESS', payload: { id: job.id, status: 'processing', message } });
    } catch (_) {}
  };

  try {
    broadcast('info', '📤 เริ่มกระบวนการส่งวิดีโอเข้า Shopee...');

    const videoName = job.filename || job.mediaFiles?.[0]?.name || ('shopee_' + Date.now() + '.mp4');
    const handoffId = job.id || ('phim_shopee_' + Date.now());
    let caption = job.caption || '';
    let hashtags = '';
    if (Array.isArray(job.hashtags)) {
      hashtags = job.hashtags.map(h => h.startsWith('#') ? h : '#' + h).join(' ');
    } else if (typeof job.hashtags === 'string') {
      hashtags = job.hashtags;
    }

    const product = job.product || {};
    let productUrl = job.productUrl || job.aiContext?.affiliateUrl || product.affiliateUrl || product.offerUrl || product.url || '';
    const productTitle = job.productTitle || job.aiContext?.productName || product.title || '';
    const videoDataUrl = job.videoDataUrl || job.mediaFiles?.[0]?.dataUrl || '';

    // Step 0: Input validation
    if (!productUrl) {
      throw new Error('กรุณาเลือกสินค้า Shopee หรือระบุลิงก์สินค้าสำหรับปักตะกร้าก่อนโพสต์');
    }
    if (!videoDataUrl && !videoName) {
      throw new Error('ไม่พบข้อมูลไฟล์วิดีโอสำหรับส่งโพสต์');
    }

    // Ensure productUrl is a valid shortlink (s.shopee.co.th / shope.ee)
    if (!isShopeeAffShortLink(productUrl)) {
      broadcast('info', '⏳ ลิงก์ไม่ใช่ shortlink กำลังแปลงเป็น s.shopee.co.th...');
      try {
        const resolved = await resolveShopeeAffiliateShortLink(productUrl, product);
        if (resolved && isShopeeAffShortLink(resolved)) {
          productUrl = resolved;
          job.productUrl = resolved;
          if (job.product) job.product.affiliateUrl = resolved;
          broadcast('ok', '✅ แปลงเป็น affiliate shortlink สำเร็จ: ' + productUrl);
        }
      } catch (_) {}
    }

    if (!isShopeeAffShortLink(productUrl)) {
      throw new Error('ลิงก์สินค้าไม่ใช่ affiliate shortlink (ต้องเป็น s.shopee.co.th หรือ shope.ee เท่านั้น) — กรุณาล็อกอิน affiliate.shopee.co.th เพื่อแปลงลิงก์ก่อนโพสต์');
    }

    // Clamp caption + hashtags strictly under 140 chars so Shopee never truncates hashtags
    const clamped = clampShopeePost(caption, hashtags);
    caption = clamped.caption;
    hashtags = clamped.hashtags;

    // Step 1: Try Bridge FIRST (USB direct — faster & more reliable than Cloud Sync)
    let bridgeStore = {};
    try {
      bridgeStore = await chrome.storage.local.get(['phimbot_bridge_endpoint', 'phimbot_bridge_token']);
    } catch (_) {}
    const customEndpoint = (bridgeStore.phimbot_bridge_endpoint || 'http://127.0.0.1:17881').replace(/\/+$/, '');
    const bridgeToken = bridgeStore.phimbot_bridge_token || '';

    let phoneBridgeAvailable = false;
    let effectiveBridgeUrl = customEndpoint;
    try {
      const phoneRes = await fetch(`${customEndpoint}/health`, { signal: AbortSignal.timeout(2000) });
      const phoneData = await phoneRes.json();
      if (phoneData?.ok || phoneData?.status === 'ready') {
        phoneBridgeAvailable = true;
        effectiveBridgeUrl = customEndpoint;
      }
    } catch (_) {}
    if (!phoneBridgeAvailable && customEndpoint !== 'http://127.0.0.1:17881') {
      try {
        const dRes = await fetch('http://127.0.0.1:17881/health', { signal: AbortSignal.timeout(2000) });
        const dData = await dRes.json();
        if (dData?.ok || dData?.status === 'ready') {
          phoneBridgeAvailable = true;
          effectiveBridgeUrl = 'http://127.0.0.1:17881';
        }
      } catch (_) {}
    }

    if (phoneBridgeAvailable) {
      broadcast('info', `⚡ กำลังส่งงานตรงเข้า PUP PAP POST Bridge (${effectiveBridgeUrl.replace(/^https?:\/\//, '')})...`);
      const bridgePayload = {
        handoffId,
        videoName,
        productUrl,
        productTitle,
        caption,
        hashtags,
        token: bridgeToken,
        autoStart: true
      };
      if (videoDataUrl && videoDataUrl.length > 50) bridgePayload.videoDataUrl = videoDataUrl;
      const submitRes = await fetch(`${effectiveBridgeUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bridgePayload)
      });
      const submitData = await submitRes.json().catch(() => ({}));
      if (submitRes.ok || submitData?.ok) {
        const targetHandoffId = submitData?.handoffId || handoffId;
        broadcast('ok', `🎉 ส่งคลิปผ่าน Bridge สำเร็จ (${targetHandoffId})! กำลังรอมือถือโพสต์...`);

        // Poll status until phone confirms 'success' or reports 'failed'
        const pollUrl = `${effectiveBridgeUrl}/jobs/${encodeURIComponent(targetHandoffId)}`;
        const startTime = Date.now();
        const maxTimeoutMs = 10 * 60 * 1000;
        let lastStatusMsg = '';

        while (Date.now() - startTime < maxTimeoutMs) {
          if (typeof currentQueueAbort !== 'undefined' && currentQueueAbort?.signal?.aborted) {
            throw new Error('คิวงานถูกยกเลิกโดยผู้ใช้');
          }
          await new Promise(r => setTimeout(r, 2500));
          try {
            const pollRes = await fetch(pollUrl, { signal: AbortSignal.timeout(4000) });
            if (!pollRes.ok) { if (pollRes.status === 404) continue; continue; }
            const pollData = await pollRes.json();
            const status = (pollData?.status || '').toLowerCase();
            const msg = pollData?.message || '';
            if (msg && msg !== lastStatusMsg) { lastStatusMsg = msg; broadcast('info', `📱 [Shopee] ${msg}`); }
            if (status === 'success') {
              broadcast('ok', `🎉 โพสต์วิดีโอลง Shopee สำเร็จ! (${msg || 'เสร็จสมบูรณ์'})`);
              return { ok: true, handoffId: targetHandoffId, method: 'bridge', jobId: pollData.jobId };
            } else if (status === 'failed') {
              broadcast('error', `❌ ล้มเหลว: ${msg || 'error'}`);
              return { ok: false, reason: msg || 'failed' };
            } else if (status === 'permission_required') {
              broadcast('warn', `⚠️ ต้องเปิด Accessibility Service ในมือถือ (${msg})`);
              return { ok: false, reason: msg };
            }
          } catch (pollErr) {
            if (typeof currentQueueAbort !== 'undefined' && currentQueueAbort?.signal?.aborted) throw new Error('คิวงานถูกยกเลิกโดยผู้ใช้');
          }
        }
        broadcast('warn', '⚠️ หมดเวลารอผล (10 นาที) — คลิปอาจยังอยู่ในคิวมือถือ');
        return { ok: true, handoffId: targetHandoffId, method: 'bridge', timedOut: true };
      } else {
        broadcast('warn', `⚠️ Bridge ตอบกลับ error: ${submitData?.error || submitRes.statusText} — กำลังลอง Cloud Sync...`);
      }
    }

    // Step 2: Fallback to Cloud Sync (Wireless)
    let cloudSyncConfigured = false;
    let syncSettings = null;
    try {
      const syncStored = await chrome.storage.local.get('asu-clip-sync-settings');
      syncSettings = syncStored && syncStored['asu-clip-sync-settings'];
      cloudSyncConfigured = !!(syncSettings && (syncSettings.pairCode || (syncSettings.devices && syncSettings.devices.length > 0)));
    } catch (_) {}

    if (!cloudSyncConfigured) {
      syncSettings = {
        enabled: true,
        pairCode: 'RC6N-WPVW-M34P',
        devices: [{ id: 'dev_1', name: 'เครื่องที่ 1 (OPPO)', pairCode: 'RC6N-WPVW-M34P', isDefault: true }],
        autoStart: true,
        supabaseUrl: 'https://guhdweujxgsbflkvgryb.supabase.co',
        supabaseAnonKey: 'sb_publishable_Jk_pcsCymh1jJrmnBMJUhw_H_UqTpTx'
      };
      await chrome.storage.local.set({ 'asu-clip-sync-settings': syncSettings }).catch(() => {});
      cloudSyncConfigured = true;
    }

    if (cloudSyncConfigured) {
      const devices = (syncSettings && Array.isArray(syncSettings.devices) && syncSettings.devices.length > 0)
        ? syncSettings.devices
        : [{ id: 'dev_1', name: 'เครื่องที่ 1 (OPPO)', pairCode: (syncSettings?.pairCode || 'RC6N-WPVW-M34P'), isDefault: true }];

      const targetDevId = job.targetDevice || '';

      if (typeof self.uploadToRelay === 'function' && videoDataUrl) {
        if (targetDevId === 'all' && devices.length > 1) {
          // Broadcast to ALL devices!
          broadcast('info', `☁️ กำลังส่งคลิปผ่าน Cloud Sync กระจายไปทุกเครื่อง (${devices.length} เครื่อง)...`);
          let successCount = 0;
          const errors = [];

          for (let idx = 0; idx < devices.length; idx++) {
            const dev = devices[idx];
            broadcast('info', `📤 [${idx + 1}/${devices.length}] กำลังส่งเข้า "${dev.name}" (Key: ${dev.pairCode})...`);
            try {
              const res = await self.uploadToRelay({
                videoDataUrl,
                videoName,
                productUrl,
                productTitle,
                caption,
                hashtags,
                pairCode: dev.pairCode,
                clientRef: `${handoffId}_${dev.id || idx}`
              });
              if (res && res.ok) {
                successCount++;
                broadcast('ok', `✅ ส่งเข้า "${dev.name}" สำเร็จ!`);
              } else {
                errors.push(`${dev.name}: ${res?.error || 'ล้มเหลว'}`);
                broadcast('warn', `⚠️ ส่งเข้า "${dev.name}" ไม่สำเร็จ: ${res?.error || 'เกิดข้อผิดพลาด'}`);
              }
            } catch (err) {
              errors.push(`${dev.name}: ${err.message || err}`);
              broadcast('warn', `⚠️ ส่งเข้า "${dev.name}" เกิดข้อผิดพลาด: ${err.message || err}`);
            }
          }

          if (successCount > 0) {
            broadcast('ok', `🎉 กระจายส่งคลิปเข้ามือถือสำเร็จ ${successCount}/${devices.length} เครื่อง!`);
            return { ok: true, handoffId, method: 'cloud_sync_broadcast', successCount, totalDevices: devices.length };
          } else {
            throw new Error(`ส่งผ่าน Cloud Sync ไม่สำเร็จทุกเครื่อง: ${errors.join(', ')}`);
          }
        } else {
          // Single device targeting: specific device OR default active device
          let targetDev = devices.find(d => d.id === targetDevId);
          if (!targetDev) {
            targetDev = devices.find(d => d.isDefault) || devices[0];
          }
          const pairCode = targetDev ? targetDev.pairCode : (syncSettings?.pairCode || '');
          const devName = targetDev ? targetDev.name : 'มือถือ';

          broadcast('info', `☁️ กำลังส่งคลิปผ่าน Cloud Sync ไปที่ "${devName}" (Key: ${pairCode})...`);
          const syncRes = await self.uploadToRelay({
            videoDataUrl,
            videoName,
            productUrl,
            productTitle,
            caption,
            hashtags,
            pairCode,
            clientRef: handoffId
          });
          if (syncRes && syncRes.ok) {
            broadcast('ok', `🎉 ส่งขึ้น Cloud Sync เข้า "${devName}" สำเร็จ! มือถือจะดาวน์โหลดและโพสต์ Shopee Video ให้อัตโนมัติ`);
            return { ok: true, handoffId, method: 'cloud_sync', targetDevice: devName };
          } else {
            throw new Error(`ส่งผ่าน Cloud Sync ไม่สำเร็จ: ${syncRes?.error || 'เกิดข้อผิดพลาด'}`);
          }
        }
      }
    }

    throw new Error('ยังไม่ได้เชื่อมต่อกับมือถือ: กรุณาเสียบสาย USB แล้วรัน ADB port forward หรือเปิดแอป PUP PAP POST Bridge');
  } catch (err) {
    broadcast('error', '❌ ข้อผิดพลาด: ' + err.message);
    return { ok: false, reason: err.message };
  }
}

// FB Reels & Shopee Video messages handled in main dispatcher above


/* ═══════════════════════════════════════════════════════════════
   SHOPEE PRODUCT FETCHER
   ═══════════════════════════════════════════════════════════════ */

function parseShopeeUrl(url) {
  // Format: shopee.co.th/product/shopId/itemId or shopee.co.th/xxx-i.shopId.itemId
  let m = url.match(/shopee\.co\.th\/product\/(\d+)\/(\d+)/);
  if (m) return { shopId: m[1], itemId: m[2] };
  m = url.match(/shopee\.co\.th\/[^\s]*-i\.(\d+)\.(\d+)/);
  if (m) return { shopId: m[1], itemId: m[2] };
  // Short link format
  if (/s\.shopee\.co\.th|shp\.ee/.test(url)) return { shortLink: url };
  return null;
}

async function resolveShopeeShortLink(shortUrl) {
  try {
    const tab = await chrome.tabs.create({ url: shortUrl, active: false });
    const tabId = tab.id;
    // Wait for redirect
    await new Promise(r => setTimeout(r, 6000));
    const updatedTab = await chrome.tabs.get(tabId);
    const finalUrl = updatedTab.url || '';
    try { await chrome.tabs.remove(tabId); } catch (_) {}
    const parsed = parseShopeeUrl(finalUrl);
    if (parsed && parsed.shopId) return parsed;
    return null;
  } catch (err) {
    return null;
  }
}

async function fetchShopeeProductApi(shopId, itemId) {
  try {
    // Try Shopee Affiliate GraphQL API
    const gqlBody = JSON.stringify({
      operationName: 'GetProductDetail',
      variables: { shopId: parseInt(shopId), itemId: parseInt(itemId) },
      query: `query GetProductDetail($shopId: Int!, $itemId: Int!) {
        productDetail(shopId: $shopId, itemId: $itemId) {
          name price priceBeforeDiscount historicalSold ratingAverage
          images { url } shopName discount commissionRate
        }
      }`
    });

    const resp = await fetch('https://affiliate.shopee.co.th/api/v3/gql', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'affiliate-program-type': '1'
      },
      body: gqlBody
    });

    if (resp.ok) {
      const json = await resp.json();
      const data = json?.data?.productDetail;
      if (data) return data;
    }
  } catch (err) {
    console.log('[Shopee] GQL API failed:', err.message);
  }
  return null;
}

async function scrapeShopeeProduct(shopId, itemId) {
  const url = 'https://shopee.co.th/product/' + shopId + '/' + itemId;
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    await new Promise(r => setTimeout(r, 8000));

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const getText = (sel) => {
          const el = document.querySelector(sel);
          return el ? el.textContent.trim() : '';
        };

        // Try JSON-LD
        const ldScripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
        let ldData = null;
        for (const s of ldScripts) {
          try {
            const parsed = JSON.parse(s.textContent);
            if (parsed['@type'] === 'Product' || parsed.name) {
              ldData = parsed;
              break;
            }
          } catch (_) {}
        }

        // Get images from gallery
        const images = [...new Set(
          [...document.querySelectorAll('img[src*="susercontent.com"], img[src*="shopecdn.com"]')]
            .map(img => img.src.replace(/_tn\b/, ''))
            .filter(src => !src.includes('icon') && !src.includes('avatar') && src.includes('shopee'))
        )].slice(0, 8);

        // OpenGraph fallback
        const ogTitle = document.querySelector('meta[property="og:title"]')?.content || '';
        const ogImage = document.querySelector('meta[property="og:image"]')?.content || '';
        const ogDesc = document.querySelector('meta[property="og:description"]')?.content || '';

        // Extract price from page
        const priceMatch = document.body.innerText.match(/฿([\d,]+\.?\d*)/);
        const price = priceMatch ? priceMatch[1].replace(/,/g, '') : '';

        // Rating
        const ratingMatch = document.body.innerText.match(/(\d\.\d)\s*(?:จาก|out of)\s*5/);
        const rating = ratingMatch ? ratingMatch[1] : '';

        // Sold
        const soldMatch = document.body.innerText.match(/(\d[\d,.]*[Kk]?)\s*(?:ขายแล้ว|sold)/i);
        const sold = soldMatch ? soldMatch[1] : '';

        return {
          title: ldData?.name || ogTitle || getText('.page-product__item-name') || document.title.split('|')[0]?.trim() || '',
          price: ldData?.offers?.price || price,
          currency: ldData?.offers?.priceCurrency || 'THB',
          description: ldData?.description || ogDesc,
          rating: ldData?.aggregateRating?.ratingValue || rating,
          sold: sold,
          images: images.length ? images : (ogImage ? [ogImage] : []),
          url: window.location.href
        };
      }
    });

    try { await chrome.tabs.remove(tabId); } catch (_) {}
    return results?.[0]?.result || null;
  } catch (err) {
    if (tabId) try { await chrome.tabs.remove(tabId); } catch (_) {}
    return null;
  }
}

async function generateShopeeAffiliateLink(shopId, itemId) {
  const productUrl = 'https://shopee.co.th/product/' + shopId + '/' + itemId;
  try {
    const resp = await fetch('https://affiliate.shopee.co.th/api/v3/gql', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'affiliate-program-type': '1' },
      body: JSON.stringify({
        operationName: 'GenerateShortLink',
        variables: { url: productUrl },
        query: 'mutation GenerateShortLink($url: String!) { generateShortLink(url: $url) { shortLink } }'
      })
    });
    if (resp.ok) {
      const json = await resp.json();
      return json?.data?.generateShortLink?.shortLink || null;
    }
  } catch (_) {}
  return null;
}

async function handleFetchShopee(url) {
  let parsed = parseShopeeUrl(url);
  if (!parsed) return { ok: false, reason: 'URL ไม่ถูกต้อง ต้องเป็น URL สินค้า Shopee' };

  if (parsed.shortLink) {
    parsed = await resolveShopeeShortLink(url);
    if (!parsed) return { ok: false, reason: 'ไม่สามารถ resolve short link ได้' };
  }

  const { shopId, itemId } = parsed;

  // Try API first, then scrape
  let product = await fetchShopeeProductApi(shopId, itemId);
  let source = 'api';

  if (!product) {
    product = await scrapeShopeeProduct(shopId, itemId);
    source = 'scrape';
  }

  if (!product) return { ok: false, reason: 'ไม่สามารถดึงข้อมูลสินค้าได้ ลองล็อกอิน affiliate.shopee.co.th' };

  // Generate affiliate link
  const affLink = await generateShopeeAffiliateLink(shopId, itemId);

  const result = {
    ok: true, source,
    shopId, itemId,
    title: product.title || product.name || '',
    price: product.price || '',
    originalPrice: product.priceBeforeDiscount || product.originalPrice || '',
    discount: product.discount || product.discountPercent || '',
    sold: product.historicalSold || product.sold || '',
    rating: product.ratingAverage || product.rating || '',
    commission: product.commissionRate || '',
    images: product.images || [],
    affiliateUrl: isShopeeAffShortLink(affLink) ? affLink : '',
    productUrl: 'https://shopee.co.th/product/' + shopId + '/' + itemId
  };

  // Save to history (เก็บ full data เพื่อใช้ในโรงงานวิดีโอ)
  try {
    const stored = await chrome.storage.local.get('phimbot_shopee_history');
    const history = stored.phimbot_shopee_history || [];
    // เก็บ full product data (รวม images, affiliate, etc.)
    const historyEntry = {
      title: result.title,
      name: result.title,
      price: result.price,
      originalPrice: result.originalPrice,
      discount: result.discount,
      images: result.images || [],
      affiliateUrl: result.affiliateUrl || '',
      productUrl: result.productUrl,
      url: result.productUrl,
      shopId: result.shopId,
      itemId: result.itemId,
      productId: `shopee_${result.shopId}_${result.itemId}`,
      platform: 'shopee',
      ts: Date.now()
    };
    // ไม่เก็บซ้ำ — ตรวจจาก shopId+itemId
    const existIdx = history.findIndex(h => h.shopId === result.shopId && h.itemId === result.itemId);
    if (existIdx >= 0) history.splice(existIdx, 1);
    history.unshift(historyEntry);
    if (history.length > 50) history.length = 50;
    await chrome.storage.local.set({ phimbot_shopee_history: history });
  } catch (_) {}

  return result;
}

// Shopee messages handled in main dispatcher above

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'shopee-scanner') return;
  port.onMessage.addListener(async (msg) => {
    if (msg.action !== 'start_scan') return;
    try {
      port.postMessage({ type: 'status', step: 'opening_tab' });
      const result = await scanShopeeByKeyword(msg.keyword, msg.options);
      port.postMessage({ type: 'result', ...result });
    } catch (err) {
      port.postMessage({ type: 'result', ok: false, reason: 'error: ' + (err.message || err), items: [] });
    }
  });
});

async function generateShortLinkViaTab(targetUrl) {
  try {
    const tabId = await getReusableShopeeAffiliateTab();
    if (!tabId) return null;
    await waitForShopeeScannerTabComplete(tabId, 15000);
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [targetUrl],
      func: async function(urlArg) {
        try {
          const resp = await fetch('/api/v3/gql', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', 'affiliate-program-type': '1' },
            body: JSON.stringify({
              operationName: 'GenerateShortLink',
              variables: { url: urlArg },
              query: 'mutation GenerateShortLink($url: String!) { generateShortLink(url: $url) { shortLink } }'
            })
          });
          if (resp.ok) {
            const data = await resp.json();
            return data?.data?.generateShortLink?.shortLink || null;
          }
        } catch (_) {}
        return null;
      }
    });
    return results?.[0]?.result || null;
  } catch (_) {
    return null;
  }
}

async function resolveShopeeAffiliateShortLink(urlOrItem, extraItem = {}) {
  const item = (typeof urlOrItem === 'object' && urlOrItem) ? urlOrItem : (extraItem || {});
  const rawUrl = (typeof urlOrItem === 'string' && urlOrItem) ? urlOrItem : (item.productUrl || item.offerUrl || item.url || item.affiliateUrl || '');

  if (isShopeeAffShortLink(rawUrl)) return rawUrl;
  if (isShopeeAffShortLink(item.affiliateUrl)) return item.affiliateUrl;

  if (item.offerId) {
    try {
      const res = await getShopeeOfferAffiliateLink(item);
      if (res && res.ok && isShopeeAffShortLink(res.affiliateUrl)) return res.affiliateUrl;
    } catch (_) {}
  }

  const parsed = parseShopeeUrl(rawUrl);
  if (parsed && parsed.shopId && parsed.itemId) {
    try {
      const gLink = await generateShopeeAffiliateLink(parsed.shopId, parsed.itemId);
      if (gLink && isShopeeAffShortLink(gLink)) return gLink;
    } catch (_) {}
  }

  if (rawUrl) {
    try {
      const tabLink = await generateShortLinkViaTab(rawUrl);
      if (tabLink && isShopeeAffShortLink(tabLink)) return tabLink;
    } catch (_) {}
  }

  return null;
}

/* ═══════════════════════════════════════════════════════════════
   GET SHOPEE AFFILIATE LINK (DOM Automation)
   Opens offer page → clicks "เอาลิงก์" → captures s.shopee.co.th link
   ═══════════════════════════════════════════════════════════════ */
async function getShopeeOfferAffiliateLink(item = {}) {
  const offerId = String(item.offerId || '').trim();
  if (!offerId) return { ok: false, reason: 'no_offerId' };

  const offerUrl = 'https://affiliate.shopee.co.th/offer/product_offer/' + offerId;
  console.log('[PhimBot] getShopeeOfferAffiliateLink:', offerId, offerUrl);

  // Get or create tab directly with offerUrl (like OmniPost)
  const tabId = await getReusableShopeeAffiliateTab(offerUrl);
  if (!tabId) return { ok: false, reason: 'no_tab' };
  
  await waitForShopeeScannerTabComplete(tabId, 60000);
  await new Promise(r => setTimeout(r, 2000));

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [offerId],
      func: async function(offerIdArg) {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const normalize = (v) => String(v || '').replace(/\s+/g, ' ').trim();
        const log = (msg) => console.log('[PhimBot-Inject]', msg);

        const isAffLink = (v) => {
          try {
            const url = new URL(String(v || '').trim());
            return url.protocol === 'https:' && (url.hostname === 's.shopee.co.th' || url.hostname === 'shope.ee');
          } catch (_) { return false; }
        };

        const fireClick = async (el) => {
          if (!el) return false;
          el.scrollIntoView?.({ block: 'center' });
          await sleep(100);
          const rect = el.getBoundingClientRect?.();
          const cx = rect ? rect.left + rect.width/2 : 0;
          const cy = rect ? rect.top + rect.height/2 : 0;
          ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(t =>
            el.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window, clientX:cx, clientY:cy })));
          el.click?.();
          await sleep(200);
          return true;
        };

        log('Page URL: ' + location.href);
        log('Body length: ' + (document.body?.innerText?.length || 0));

        // Wait for page to be ready (up to 20s)
        let pageReady = false;
        for (let w = 0; w < 40; w++) {
          const text = normalize(document.body?.innerText || '');
          if (/\u0e40\u0e2d\u0e32\s*\u0e25\u0e34\u0e07\u0e01\u0e4c|\u0e23\u0e31\u0e1a\s*\u0e25\u0e34\u0e07\u0e01\u0e4c|\u0e04\u0e31\u0e14\u0e25\u0e2d\u0e01\s*\u0e25\u0e34\u0e07\u0e01\u0e4c|get.?link/i.test(text)) {
            pageReady = true;
            log('Page ready at ' + w * 500 + 'ms');
            break;
          }
          await sleep(500);
        }
        if (!pageReady) {
          log('Page NOT ready. Text preview: ' + normalize(document.body?.innerText || '').substring(0, 200));
          // Continue anyway - button might still be there
        }

        // Dismiss any T&C modals
        for (let attempt = 0; attempt < 3; attempt++) {
          const modalBtns = [...document.querySelectorAll('.ant-modal button, [role="dialog"] button, .ant-btn')]
            .filter(b => /agree|\u0e15\u0e01\u0e25\u0e07|\u0e22\u0e2d\u0e21\u0e23\u0e31\u0e1a|\u0e22\u0e37\u0e19\u0e22\u0e31\u0e19|ok|confirm/i.test(normalize(b.innerText||'')))
            .filter(b => { const r = b.getBoundingClientRect?.(); return r && r.width > 20; });
          if (modalBtns.length) {
            log('Dismissing modal');
            await fireClick(modalBtns[0]);
            await sleep(1000);
          } else break;
        }

        // Intercept clipboard
        let capturedClipboard = '';
        try {
          const origWriteText = navigator.clipboard?.writeText?.bind(navigator.clipboard);
          if (origWriteText) {
            navigator.clipboard.writeText = async (text) => {
              capturedClipboard = String(text || '');
              log('Clipboard intercepted: ' + capturedClipboard.substring(0, 80));
              return origWriteText(text);
            };
          }
        } catch (_) {}

        // Find "เอาลิงก์" button - comprehensive search
        const findGetLinkBtn = () => {
          // Specific class selectors
          for (const sel of ['button.get-link-btn', 'button[class*="get-link" i]', 'button.AffiliateItemCard__getlinkBtn', '.get-link-btn']) {
            const el = document.querySelector(sel);
            if (el) {
              const r = el.getBoundingClientRect?.();
              if (r && r.width > 0) return el;
            }
          }
          // Text search: find anything with "เอาลิงก์"
          const allBtns = [...document.querySelectorAll('button, [role="button"], .ant-btn, .ant-btn-primary, span, div, a')];
          const linkBtns = allBtns
            .filter(b => {
              const t = normalize(b.innerText || b.textContent || '');
              return /\u0e40\u0e2d\u0e32\s*\u0e25\u0e34\u0e07\u0e01\u0e4c|\u0e23\u0e31\u0e1a\s*\u0e25\u0e34\u0e07\u0e01\u0e4c|\u0e04\u0e31\u0e14\u0e25\u0e2d\u0e01\s*\u0e25\u0e34\u0e07\u0e01\u0e4c/i.test(t);
            })
            .filter(b => { const r = b.getBoundingClientRect?.(); return r && r.width > 15 && r.height > 10; })
            .sort((a,b) => (a.querySelectorAll?.('*').length||0) - (b.querySelectorAll?.('*').length||0));
          return linkBtns[0] || null;
        };

        const readLinkFromPage = () => {
          // Check modals
          const modal = [...document.querySelectorAll('.ant-modal-wrap, .ant-modal, [role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]')]
            .find(m => {
              const r = m.getBoundingClientRect?.();
              const t = normalize(m.innerText||'');
              return r && r.width > 100 && /\u0e25\u0e34\u0e07\u0e01\u0e4c|\u0e04\u0e31\u0e14\u0e25\u0e2d\u0e01|Sub_id|link|s\.shopee|shope\.ee/i.test(t);
            });
          const scopes = [modal, document].filter(Boolean);
          for (const scope of scopes) {
            // Method 1: input/textarea values
            const inputs = [...scope.querySelectorAll('input, textarea')].map(el => el.value);
            const inputLink = inputs.find(v => isAffLink(v));
            if (inputLink) { log('Found in input: ' + inputLink); return String(inputLink).trim(); }

            // Method 2: href attributes
            const hrefs = [...scope.querySelectorAll('a[href]')].map(el => el.href);
            const hrefLink = hrefs.find(v => isAffLink(v));
            if (hrefLink) { log('Found in href: ' + hrefLink); return String(hrefLink).trim(); }

            // Method 3: innerText words
            const words = String(scope.innerText||'').split(/\s+/);
            const wordLink = words.find(v => isAffLink(v));
            if (wordLink) { log('Found in text: ' + wordLink); return String(wordLink).trim(); }

            // Method 4: Regex extraction from all text content
            const allText = scope.innerText || scope.textContent || '';
            const urlMatch = allText.match(/https?:\/\/s\.shopee\.co\.th\/[A-Za-z0-9_-]+/);
            if (urlMatch) { log('Found via regex: ' + urlMatch[0]); return urlMatch[0]; }
            const urlMatch2 = allText.match(/https?:\/\/shope\.ee\/[A-Za-z0-9_-]+/);
            if (urlMatch2) { log('Found via regex2: ' + urlMatch2[0]); return urlMatch2[0]; }

            // Method 5: Check div/span with specific classes that might hold the link
            const divTexts = [...scope.querySelectorAll('div, span, p, code, pre')].map(el => el.textContent?.trim() || '');
            const divLink = divTexts.find(v => isAffLink(v));
            if (divLink) { log('Found in div: ' + divLink); return String(divLink).trim(); }
          }
          return '';
        };

        const closeAffiliateModal = async () => {
          const closeBtn = document.querySelector('.ant-modal-close, button[aria-label*="Close" i], button[aria-label*="ปิด" i]')
            || [...document.querySelectorAll('button, span, div')].find(c => (c.innerText || c.textContent || '').trim() === '×');
          if (closeBtn) await fireClick(closeBtn);
        };

        // Check if link already exists on page
        const existingLink = readLinkFromPage();
        if (existingLink) {
          log('Found existing link: ' + existingLink);
          await closeAffiliateModal();
          return { ok: true, affiliateUrl: existingLink };
        }

        const btn = findGetLinkBtn();
        log('Get link button: ' + (btn ? ('found [' + normalize(btn.innerText||'').substring(0,30) + ']') : 'NOT FOUND'));
        
        if (!btn) {
          // Debug: list all buttons
          const allBtns = [...document.querySelectorAll('button, .ant-btn')].map(b => normalize(b.innerText||'').substring(0,30)).filter(Boolean);
          log('All buttons: ' + allBtns.join(' | '));
          return { ok: false, reason: 'get_link_button_not_found', debug: { url: location.href, buttons: allBtns.slice(0,10) } };
        }

        // Click the button
        await fireClick(btn);
        log('Clicked get link button');

        // Wait for the link to appear (up to 30s, 3 attempts)
        for (let attempt = 0; attempt < 3; attempt++) {
          log('Attempt ' + (attempt+1));
          for (let w = 0; w < 60; w++) {
            if (isAffLink(capturedClipboard)) {
              log('Got link from clipboard: ' + capturedClipboard);
              await closeAffiliateModal();
              return { ok: true, affiliateUrl: capturedClipboard };
            }
            const linkFromPage = readLinkFromPage();
            if (linkFromPage) {
              log('Got link from page: ' + linkFromPage);
              await closeAffiliateModal();
              return { ok: true, affiliateUrl: linkFromPage };
            }
            await sleep(300);
          }
          // Retry: close modal, click again
          const closeBtn = document.querySelector('.ant-modal-close, button[aria-label*="Close" i], button[aria-label*="\u0e1b\u0e34\u0e14" i]');
          if (closeBtn) { await fireClick(closeBtn); await sleep(500); }
          const retryBtn = findGetLinkBtn();
          if (retryBtn) { await fireClick(retryBtn); await sleep(500); }
        }

        return { ok: false, reason: 'link_not_generated_after_3_attempts' };
      }
    });

    const payload = result?.[0]?.result;
    console.log('[PhimBot] getLink result:', JSON.stringify(payload)?.substring(0, 300));
    if (payload?.ok && payload?.affiliateUrl) return payload;
    return { ok: false, reason: payload?.reason || 'extraction_failed', debug: payload?.debug };
  } catch (err) {
    console.error('[PhimBot] getLink error:', err);
    return { ok: false, reason: 'script_error: ' + (err.message || err) };
  }
}

/* ═══════════════════════════════════════════════════════════════
   SHOPEE KEYWORD SCANNER (Affiliate Portal DOM Automation)
   v3 - Complete rewrite based on OmniPost v1.1.8
   ═══════════════════════════════════════════════════════════════ */

let shopeeAffiliateReusableTabId = null;
const SHOPEE_AFFILIATE_OFFER_URL = 'https://affiliate.shopee.co.th/offer/product_offer';

// OmniPost-style tab complete wait using chrome.tabs.onUpdated event
async function waitForShopeeScannerTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(value);
    };
    const listener = (updatedId, info) => {
      if (updatedId === tabId && info.status === 'complete') finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab?.status === 'complete') finish(true);
    }).catch(() => finish(false));
  });
}

function isShopeeAffiliateOfferUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.hostname === 'affiliate.shopee.co.th'
      && url.pathname.replace(/\/+$/, '') === '/offer/product_offer';
  } catch (_) { return false; }
}

async function getReusableShopeeAffiliateTab(startUrl = SHOPEE_AFFILIATE_OFFER_URL) {
  const isAffiliateTab = (tab) => /^https:\/\/affiliate\.shopee\.co\.th\//i.test(String(tab?.url || ''));
  // Try reuse existing tab
  if (shopeeAffiliateReusableTabId) {
    const current = await chrome.tabs.get(shopeeAffiliateReusableTabId).catch(() => null);
    if (current?.id && isAffiliateTab(current)) {
      if (String(current.url || '') !== String(startUrl || '')) {
        await chrome.tabs.update(current.id, { url: startUrl, active: false });
        await waitForShopeeScannerTabComplete(current.id, 30000);
      }
      return current.id;
    }
    shopeeAffiliateReusableTabId = null;
  }
  // Find any existing affiliate tab
  const tabs = await chrome.tabs.query({ url: ['https://affiliate.shopee.co.th/*'] }).catch(() => []);
  const existing = tabs.find(isAffiliateTab);
  if (existing?.id) {
    shopeeAffiliateReusableTabId = existing.id;
    if (String(existing.url || '') !== String(startUrl || '')) {
      await chrome.tabs.update(existing.id, { url: startUrl, active: false });
      await waitForShopeeScannerTabComplete(existing.id, 30000);
    }
    return existing.id;
  }
  // Create new tab
  const created = await chrome.tabs.create({ url: startUrl, active: false }).catch(() => null);
  shopeeAffiliateReusableTabId = created?.id || null;
  if (shopeeAffiliateReusableTabId) await waitForShopeeScannerTabComplete(shopeeAffiliateReusableTabId, 30000);
  return shopeeAffiliateReusableTabId;
}

// Store scan progress for sidepanel polling
function updateScanStatus(data) {
  chrome.storage.local.set({ phimbot_shopee_scan: { ...data, ts: Date.now() } });
}

async function scanShopeeByKeyword(keyword, options = {}) {
  const query = String(keyword || '').trim();
  if (!query) return { ok: false, reason: 'empty_keyword', items: [] };

  const pages = Math.max(1, Math.min(10, Number(options.pages) || 1));
  const shopFilters = {
    mall: Boolean(options.filters?.mall),
    extraComm: Boolean(options.filters?.extraComm),
    preferred: Boolean(options.filters?.preferred),
    affiliateSort: String(options.sort || 'relevance'),
  };

  updateScanStatus({ status: 'scanning', step: 'opening_tab', keyword: query });

  const tabId = await getReusableShopeeAffiliateTab();
  if (!tabId) return { ok: false, reason: 'ไม่สามารถเปิด Shopee Affiliate กรุณาล็อกอินก่อน', items: [] };

  await waitForShopeeScannerTabComplete(tabId, 30000);
  // Wait for SPA to fully render
  await new Promise(r => setTimeout(r, 2000));
  updateScanStatus({ status: 'scanning', step: 'waiting_for_page', keyword: query });

  let result;
  try {
    result = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [query, pages, shopFilters],
      func: async function(keywordArg, advancePageCount, shopFiltersArg) {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const normalize = (v) => String(v || '').replace(/\s+/g, ' ').trim();
        const getBodyText = () => normalize(document.body?.innerText || '').toLowerCase();

        const fireClick = async (el) => {
          if (!el) return false;
          el.scrollIntoView?.({ block: 'center' });
          await sleep(120);
          const rect = el.getBoundingClientRect?.();
          const cx = rect ? rect.left + rect.width/2 : 0;
          const cy = rect ? rect.top + rect.height/2 : 0;
          const opts = { bubbles:true, cancelable:true, view:window, clientX:cx, clientY:cy };
          ['pointerover','mouseover','mouseenter'].forEach(t => el.dispatchEvent(new MouseEvent(t, opts)));
          await sleep(80);
          ['pointerdown','mousedown','pointerup','mouseup'].forEach(t => el.dispatchEvent(new MouseEvent(t, opts)));
          if (typeof el.click === 'function') el.click();
          else el.dispatchEvent(new MouseEvent('click', opts));
          await sleep(350);
          return true;
        };

        // ─── STEP 0: Dismiss any T&C / confirmation modals ───
        const dismissModals = async () => {
          for (let attempt = 0; attempt < 5; attempt++) {
            // Look for modal overlays with agree/confirm/ok buttons
            const modalBtns = [...document.querySelectorAll('.ant-modal button, .ant-modal-wrap button, [class*="modal"] button, [class*="Modal"] button, [class*="dialog"] button, [role="dialog"] button, .ant-btn')]
              .filter(btn => {
                const text = normalize(btn.innerText || btn.textContent || '').toLowerCase();
                return /agree|ตกลง|ยอมรับ|ยืนยัน|ok|confirm|accept|got it|เข้าใจแล้ว/i.test(text);
              })
              .filter(btn => { const r = btn.getBoundingClientRect?.(); return r && r.width > 20 && r.height > 15; });
            if (modalBtns.length) {
              await fireClick(modalBtns[0]);
              await sleep(1000);
              continue; // Check for more modals
            }
            // Also try clicking any primary button in a modal
            const primaryInModal = document.querySelector('.ant-modal .ant-btn-primary, [class*="modal"] .ant-btn-primary, [role="dialog"] .ant-btn-primary');
            if (primaryInModal) {
              const r = primaryInModal.getBoundingClientRect?.();
              if (r && r.width > 20) { await fireClick(primaryInModal); await sleep(1000); continue; }
            }
            break; // No more modals
          }
        };
        await dismissModals();
        await sleep(500);

        // ─── STEP 1: Wait for search input (up to 60s) ───
        const findSearchInput = () =>
          document.querySelector('input[placeholder*="ค้นหาสินค้าช้อปปี้"]')
          || document.querySelector('input[placeholder*="ค้นหาสินค้า"]')
          || document.querySelector('input[placeholder*="ค้นหา"]')
          || [...document.querySelectorAll('input[type="text"], input:not([type])')].find(i => {
            const ph = String(i.placeholder || '');
            return /ค้นหา|search|สินค้า/i.test(ph);
          });

        let searchInput = null;
        for (let wait = 0; wait < 120; wait++) {
          searchInput = findSearchInput();
          if (searchInput) break;
          // Try dismissing modals every 5 seconds
          if (wait > 0 && wait % 10 === 0) await dismissModals();
          if (/เข้าสู่ระบบ|ลงชื่อเข้าใช้|login|sign.?in/i.test(getBodyText())) {
            return { ok: false, reason: 'login_required', items: [] };
          }
          await sleep(500);
        }
        if (!searchInput) {
          return { ok: false, reason: 'search_input_not_found', items: [],
            debug: { bodyLen: (document.body?.innerText||'').length, url: location.href, title: document.title }
          };
        }

        // ─── STEP 2: Type keyword and search ───
        const setInputValue = (input, value) => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(input, value);
          else input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        };

        setInputValue(searchInput, keywordArg);
        await sleep(300);

        // Find and click search button
        const searchScope = searchInput.closest('form') || searchInput.parentElement?.parentElement || document;
        const searchBtn = [...searchScope.querySelectorAll('button, [role="button"], .ant-btn')]
          .find(b => /ค้นหา/i.test(normalize(b.innerText || '')))
          || searchScope.querySelector('button[type="submit"], .ant-input-search-button')
          || (() => {
            const rect = searchInput.getBoundingClientRect?.();
            if (!rect) return null;
            const pt = document.elementFromPoint(rect.right + 42, rect.top + rect.height/2);
            return pt?.closest?.('button, [role="button"], .ant-btn') || pt;
          })();

        if (searchBtn) await fireClick(searchBtn);
        // Also press Enter
        const enterInit = { bubbles:true, cancelable:true, key:'Enter', code:'Enter', keyCode:13, which:13 };
        searchInput.dispatchEvent(new KeyboardEvent('keydown', enterInit));
        searchInput.dispatchEvent(new KeyboardEvent('keypress', enterInit));
        searchInput.dispatchEvent(new KeyboardEvent('keyup', enterInit));
        searchInput.form?.dispatchEvent(new Event('submit', { bubbles:true, cancelable:true }));
        try { searchInput.form?.requestSubmit?.(); } catch(_) {}
        await sleep(1000);

        // ─── STEP 3: Wait for results to load (up to 60s) ───
        const getOfferLinks = () => [...document.querySelectorAll('a[href*="/offer/product_offer/"]')]
          .filter(l => /\/offer\/product_offer\/\d+/.test(l.href || ''));

        const hasProducts = () => {
          if (getOfferLinks().length > 0) return true;
          const btns = [...document.querySelectorAll('button, [role="button"]')]
            .filter(b => /เอาลิงก์|รับลิงก์|Get Link/i.test(normalize(b.innerText || '')));
          if (btns.length > 0) return true;
          const imgs = [...document.querySelectorAll('img')]
            .filter(img => {
              const src = (img.src || img.getAttribute('data-src') || '').toLowerCase();
              const r = img.getBoundingClientRect?.();
              return (src.includes('susercontent') || src.includes('shopee') || src.includes('cf.shopee'))
                && r && r.width >= 50 && r.height >= 50;
            });
          return imgs.length >= 3 && /฿/.test(document.body?.innerText || '');
        };

        let productsFound = false;
        for (let wait = 0; wait < 120; wait++) {
          if (hasProducts()) { productsFound = true; break; }
          await sleep(500);
        }
        if (!productsFound) {
          return { ok: false, reason: 'products_not_loaded', items: [],
            debug: { links: getOfferLinks().length, bodyLen: (document.body?.innerText||'').length, hasPrice: /฿/.test(document.body?.innerText||'') }
          };
        }

        // ─── STEP 4: Apply filters ───
        const clickByText = async (label, scope) => {
          const root = scope || document;
          const els = [...root.querySelectorAll('button, [role="button"], .ant-btn, div, span, a, label')]
            .filter(el => {
              const t = normalize(el.innerText || el.textContent || '');
              return (t === label || (t.includes(label) && t.length < label.length + 20));
            })
            .filter(el => { const r = el.getBoundingClientRect?.(); return r && r.width > 10 && r.height > 10; })
            .sort((a,b) => {
              const ae = normalize(a.innerText||'') === label ? 0 : 1;
              const be = normalize(b.innerText||'') === label ? 0 : 1;
              if (ae !== be) return ae - be;
              return (a.querySelectorAll?.('*').length||0) - (b.querySelectorAll?.('*').length||0);
            });
          if (els.length) { await fireClick(els[0]); return true; }
          return false;
        };

        const isDropdownVisible = () => {
          const dd = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
          if (!dd) return false;
          const r = dd.getBoundingClientRect?.();
          return r && r.width > 0 && r.height > 0;
        };
        const ensureDropdownOpen = async () => {
          for (let att = 0; att < 5; att++) {
            if (isDropdownVisible()) return true;
            const allEls = [...document.querySelectorAll('span, div, label')];
            const shopTypeLabel = allEls.find(el => /ประเภทร้านค้า/i.test(normalize(el.innerText || '')));
            let target = null;
            if (shopTypeLabel) {
              let sib = shopTypeLabel.nextElementSibling;
              for (let d=0; sib && d<5; d++, sib=sib.nextElementSibling) {
                if (sib.matches?.('.ant-select')) { target = sib; break; }
                const inner = sib.querySelector?.('.ant-select');
                if (inner) { target = inner; break; }
              }
              if (!target) target = shopTypeLabel.parentElement?.querySelector('.ant-select') || shopTypeLabel.parentElement?.parentElement?.querySelector('.ant-select');
            }
            if (!target) target = [...document.querySelectorAll('.ant-select')].find(s => { let c=s.parentElement; for(let d=0;c&&d<3;d++,c=c.parentElement) if(/ประเภทร้าน/i.test(normalize(c.innerText||''))) return true; return false; });
            if (!target) { await sleep(500); continue; }
            const sel = target.querySelector('.ant-select-selector') || target;
            await fireClick(sel); await sleep(700);
            if (isDropdownVisible()) return true;
            const inp = target.querySelector('input');
            if (inp) { await fireClick(inp); await sleep(700); if (isDropdownVisible()) return true; }
          }
          return false;
        };
        const ensureDropdownClosed = async () => {
          if (!isDropdownVisible()) return;
          document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles:true, key:'Escape' }));
          await sleep(400);
          if (isDropdownVisible()) { (document.querySelector('.ant-layout-content')||document.body).click(); await sleep(400); }
        };
        const selectDropdownOpt = async (label) => {
          for (let att=0; att<3; att++) {
            const opt = [...document.querySelectorAll('.ant-select-item-option, [role="option"]')]
              .filter(el => { const t = normalize(el.innerText||''); return t === label || t.includes(label); })
              .sort((a,b) => (a.querySelectorAll?.('*').length||0) - (b.querySelectorAll?.('*').length||0))[0];
            if (opt) { await fireClick(opt); await sleep(500); return true; }
            if (!isDropdownVisible()) { await ensureDropdownOpen(); await sleep(500); }
            else await sleep(400);
          }
          return false;
        };

        // Sort
        const sort = shopFiltersArg.affiliateSort || 'relevance';
        if (sort === 'commission') { await clickByText('คอมมิชชั่น(%)'); await sleep(800); }
        else if (sort === 'sold') { await clickByText('ขายดี'); await sleep(800); }
        else if (sort === 'price_asc' || sort === 'price_desc') {
          await clickByText('ราคา'); await sleep(800);
          const sub = sort === 'price_asc' ? 'ราคา: ต่ำไปสูง' : 'ราคา: สูงไปต่ำ';
          const candidates = [...document.querySelectorAll('li, div, span, [role="menuitem"], [role="option"]')]
            .filter(el => { const t = normalize(el.innerText||'').replace(/\s+/g,''); return t.includes(sub.replace(/\s+/g,'')); })
            .filter(el => { const r = el.getBoundingClientRect?.(); return r && r.width > 0; });
          if (candidates.length) await fireClick(candidates[0]);
          await sleep(800);
        }
        // Extra Comm filter
        if (shopFiltersArg.extraComm) { await clickByText('ค่าคอมพิเศษ'); await sleep(600); }
        // Mall / Preferred
        if (shopFiltersArg.mall || shopFiltersArg.preferred) {
          await ensureDropdownClosed(); await sleep(400);
          await ensureDropdownOpen(); await sleep(500);
          if (shopFiltersArg.mall) { await selectDropdownOpt('Shopee Mall'); await sleep(400); }
          if (shopFiltersArg.preferred) {
            if (!isDropdownVisible()) { await ensureDropdownOpen(); await sleep(500); }
            await selectDropdownOpt('ร้านแนะนำ'); await sleep(400);
          }
          await ensureDropdownClosed();
        }

        // Wait for filter results
        await sleep(2000);
        // Wait again for products after filter
        for (let w = 0; w < 20; w++) { if (hasProducts()) break; await sleep(500); }

        // ─── STEP 5: Collect products ───
        const findOfferCard = (el) => {
          let node = el;
          for (let d = 0; node && d < 10; d++, node = node.parentElement) {
            const text = normalize(node.innerText || '');
            if (node.querySelector?.('img') && (/เอาลิงก์|฿|ค่าคอมมิชชั่น|ขายได้/.test(text))) return node;
          }
          return el.closest?.('div') || el;
        };

        const collectItems = () => {
          const items = [];
          const seen = new Set();
          let idCounter = 0;

          // Strategy A: By offer links
          const links = getOfferLinks();
          for (const link of links) {
            const href = link.href || '';
            const offerId = href.match(/\/offer\/product_offer\/(\d+)/)?.[1] || '';
            if (!offerId || seen.has(offerId)) continue;
            seen.add(offerId);
            const card = findOfferCard(link);
            if (!card) continue;
            const lines = String(card.innerText || '').split('\n').map(normalize).filter(Boolean);
            const priceText = lines.find(l => /^฿/.test(l)) || '';
            const soldText = lines.find(l => /ขายได้/.test(l)) || '';
            const commText = lines.find(l => /ค่าคอมมิชชั่น/.test(l)) || '';
            const title = lines.find(l => l !== priceText && l !== soldText && l !== commText
              && !/^เอา\s*ลิงก์$/.test(l)
              && !/^\d+(\.\d+)?%$/.test(l) && l !== 'ลด') || '';
            const img = card.querySelector('img');
            const imgSrc = img?.currentSrc || img?.src || img?.getAttribute('data-src') || '';
            const allText = (card.innerText || '') + ' ' + [...card.querySelectorAll('[alt],[title],[class]')].map(e => [e.getAttribute?.('alt'),e.getAttribute?.('title'),e.getAttribute?.('class')].filter(Boolean).join(' ')).join(' ');
            const badgeEls = [...card.querySelectorAll('span, div, label, [class*="badge"], [class*="tag"], [class*="label"]')].map(e => normalize(e.innerText||'') + ' ' + (e.className||'')).join(' ');
            items.push({ offerId, title, imageUrl: imgSrc, priceText, soldText, commissionText: commText, offerUrl: href,
              isMall: /\bmall\b|shopee\s*mall|ShopMallBrand/i.test(allText + ' ' + badgeEls),
              isExtraComm: true,
              isPreferred: /ร้านแนะนำ|preferred|PreferredSeller/i.test(allText + ' ' + badgeEls) });
          }
          if (items.length > 0) return items;

          // Strategy B: By "เอาลิงก์" buttons
          const btns = [...document.querySelectorAll('button, [role="button"], a')]
            .filter(b => /เอา\s*ลิงก์|รับลิงก์|Get Link/i.test(normalize(b.innerText || '')));
          for (const btn of btns) {
            let card = btn;
            for (let d = 0; card && d < 12; d++, card = card.parentElement) {
              if (card.querySelector?.('img') && /฿/.test(card.innerText || '')) break;
            }
            if (!card || !card.querySelector?.('img')) continue;
            const lines = String(card.innerText || '').split('\n').map(normalize).filter(Boolean);
            const priceText = lines.find(l => /฿/.test(l)) || '';
            const soldText = lines.find(l => /ขายได้|sold/i.test(l)) || '';
            const commText = lines.find(l => /คอมมิชชั่น|commission|%/i.test(l)) || '';
            const title = lines.find(l => l.length > 8 && !/฿/.test(l) && !/เอา.*ลิงก์|รับลิงก์/i.test(l) && !/ขายได้/i.test(l) && !/คอมมิชชั่น/i.test(l)) || '';
            if (!title) continue;
            const img = card.querySelector('img');
            const imgSrc = img?.currentSrc || img?.src || '';
            const offerLink = card.querySelector('a[href*="product_offer"]')?.href || card.querySelector('a[href*="shopee"]')?.href || '';
            const offerId = offerLink.match(/(\d{5,})/)?.[1] || String(++idCounter);
            if (seen.has(offerId)) continue;
            seen.add(offerId);
            items.push({ offerId, title, imageUrl: imgSrc, priceText, soldText, commissionText: commText, offerUrl: offerLink,
              isMall: /\bmall\b|shopee\s*mall|ShopMallBrand/i.test(card.innerText||''),
              isExtraComm: true,
              isPreferred: /ร้านแนะนำ|preferred/i.test(card.innerText||'') });
          }
          return items;
        };

        // Scroll and collect
        const collectPage = async () => {
          window.scrollTo(0, 0); await sleep(550);
          for (let pass = 0; pass < 9; pass++) {
            const before = window.scrollY;
            window.scrollBy(0, Math.max(420, Math.floor(window.innerHeight * 0.72)));
            await sleep(650);
            if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 260 || Math.abs(window.scrollY-before) < 8) {
              if (pass > 1) break;
            }
          }
          window.scrollTo(0, document.body.scrollHeight); await sleep(500);
          return collectItems();
        };

        // Pagination helpers
        const getCardFingerprint = () => getOfferLinks().slice(0,5).map(l => l.getAttribute('href')||'').join('|');
        const findNextBtn = () => [...document.querySelectorAll('.PaginationNoTotal__wrap .page-next, .page-item.page-next, .ant-pagination-next button, .ant-pagination-next, [class*="page-next"]')]
          .filter(el => { const r = el.getBoundingClientRect?.(); return r && r.width > 0 && !/disabled/i.test(el.className||''); })[0] || null;
        const findPageBtn = (n) => [...document.querySelectorAll('.PaginationNoTotal__wrap .page-item, .page-item, .ant-pagination-item, button, a, span')]
          .filter(el => { const t = normalize(el.innerText||''); const r = el.getBoundingClientRect?.(); return t === String(n) && r && r.width > 0 && !/disabled/i.test(el.className||''); })
          .sort((a,b) => (a.querySelectorAll?.('*').length||0) - (b.querySelectorAll?.('*').length||0))[0] || null;

        // Main collection loop
        const allSeen = new Set();
        const allItems = [];
        for (let pageIdx = 0; pageIdx < advancePageCount; pageIdx++) {
          if (pageIdx > 0) {
            const prevFP = getCardFingerprint();
            const btn = findPageBtn(pageIdx+1) || findNextBtn();
            if (!btn) break;
            window.scrollTo(0, document.body.scrollHeight); await sleep(200);
            await fireClick(btn); await sleep(1500);
            let changed = false;
            for (let w = 0; w < 30; w++) {
              if (getCardFingerprint() !== prevFP) { changed = true; break; }
              await sleep(500);
            }
            if (!changed) break;
            await sleep(1000);
          }
          const pageItems = await collectPage();
          for (const item of pageItems) {
            if (!item.offerId || allSeen.has(item.offerId)) continue;
            allSeen.add(item.offerId);
            allItems.push(item);
          }
          // If first page found nothing, try collecting again after more wait
          if (pageIdx === 0 && allItems.length === 0) {
            await sleep(3000);
            const retry = await collectPage();
            for (const item of retry) {
              if (!item.offerId || allSeen.has(item.offerId)) continue;
              allSeen.add(item.offerId);
              allItems.push(item);
            }
          }
        }

        return {
          ok: allItems.length > 0,
          reason: allItems.length ? '' : 'no_items_extracted',
          items: allItems,
          debug: {
            offerLinks: getOfferLinks().length,
            getLinkBtns: [...document.querySelectorAll('button')].filter(b => /เอา\s*ลิงก์/i.test(b.innerText||'')).length,
            hasPrice: /฿/.test(document.body?.innerText||''),
            url: location.href?.substring(0,80) || '',
          }
        };
      }
    });
  } catch (err) {
    return { ok: false, reason: 'script_error: ' + (err.message || err).substring(0, 200), items: [] };
  }

  const payload = result?.[0]?.result;
  if (!payload) return { ok: false, reason: 'no_script_result', items: [] };
  if (!payload.ok) {
    const debugStr = payload.debug ? ' [' + Object.entries(payload.debug).map(([k,v])=>k+':'+v).join(', ') + ']' : '';
    return { ok: false, reason: (payload.reason || 'extraction_failed') + debugStr, items: [] };
  }

  // Normalize items
  const parsePrice = (v) => { const m = String(v||'').replace(/,/g,'').match(/฿\s*([0-9]+(?:\.[0-9]+)?)/); return m ? Number(m[1]) : 0; };
  const parseSold = (v) => {
    const t = String(v||'').replace(/,/g,'');
    const m = t.match(/ขายได้\s*([0-9]+(?:\.[0-9]+)?)(k|m|พัน|หมื่น)?/i);
    if (!m) return 0;
    const base = Number(m[1])||0;
    const unit = (m[2]||'').toLowerCase();
    if (unit === 'm') return Math.round(base*1000000);
    if (unit === 'k' || unit === 'พัน') return Math.round(base*1000);
    if (unit === 'หมื่น') return Math.round(base*10000);
    return Math.round(base);
  };
  const parseComm = (v) => { const m = String(v||'').match(/(\d+(?:\.\d+)?)\s*%/); return m ? parseFloat(m[1]) : 0; };

  const items = payload.items.map(item => {
    const price = parsePrice(item.priceText);
    const sold = parseSold(item.soldText);
    const comm = parseComm(item.commissionText);
    // Trend Score
    const c = Math.min(35, comm * 2.2);
    const m = Math.min(30, Math.log10((sold||0)+1) * 9);
    const pv = price||0;
    const p = pv <= 299 ? 15 : pv <= 599 ? 12 : pv <= 999 ? 9 : pv <= 1999 ? 6 : 4;
    const badges = (item.isExtraComm?4:0) + (item.isMall?3:0) + (item.isPreferred?3:0);
    return {
      offerId: item.offerId, title: item.title, imageUrl: item.imageUrl,
      price, sold, commissionRate: comm,
      estimatedCommission: Math.round(price * comm / 100),
      revenue: Math.round(sold * price),
      isMall: item.isMall||false, isExtraComm: item.isExtraComm||false, isPreferred: item.isPreferred||false,
      offerUrl: item.offerUrl, commissionText: item.commissionText||'',
      trendScore: Math.round(Math.min(100, c + m + p + badges)),
    };
  });

  // Deduplicate
  const unique = [...new Map(items.map(i => [i.offerId, i])).values()];

  if (!unique.length) return { ok: false, reason: 'no_items_after_normalize', items: [], debug: payload.debug };
  return { ok: true, items: unique, total: unique.length, pages };
}

/* ═══════════════════════════════════════════════════════════════
   ANTIGRAVITY LIVE BRIDGE (127.0.0.1:19888)
   Allows Antigravity AI to inspect, extract code from, and update
   Google Flow Tools (Ai SALER PRO) and sync with PUP PAP AI 100%
   ═══════════════════════════════════════════════════════════════ */
const ANTIGRAVITY_BRIDGE_URL = 'http://127.0.0.1:19888';
let _agBridgePolling = false;

async function findGoogleFlowTabId(preferredTabId) {
  if (preferredTabId) return preferredTabId;
  const tabs = await chrome.tabs.query({});
  const flowTab = tabs.find(t => t.url && (t.url.includes('flow.google.com') || t.url.includes('labs.google/fx/tools/flow')));
  return flowTab ? flowTab.id : null;
}

async function executeAntigravityCommand(cmdObj) {
  const { id, cmd, args = {} } = cmdObj;
  try {
    if (cmd === 'PING') {
      return { ok: true, version: chrome.runtime.getManifest().version, ts: Date.now() };
    }

    if (cmd === 'LIST_TABS') {
      const tabs = await chrome.tabs.query({});
      return {
        ok: true,
        tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }))
      };
    }

    if (cmd === 'FLOW_INSPECT') {
      const tabId = await findGoogleFlowTabId(args.tabId);
      if (!tabId) throw new Error('ไม่พบแท็บ Google Flow ที่เปิดอยู่');
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        func: () => {
          const isMain = window === window.top;
          const btns = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"]'))
            .filter(b => b.offsetWidth > 0)
            .map(b => ({
              tag: b.tagName,
              id: b.id || '',
              role: b.getAttribute('role') || '',
              text: (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)
            }));
          const inputs = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"]'))
            .filter(el => el.offsetWidth > 0)
            .map(el => ({
              tag: el.tagName,
              id: el.id || '',
              placeholder: el.getAttribute('placeholder') || '',
              value: String(el.value ?? el.innerText ?? '').slice(0, 80)
            }));
          const hasMonaco = Boolean(window.monaco && window.monaco.editor);
          const monacoModels = hasMonaco
            ? window.monaco.editor.getModels().map(m => ({ uri: m.uri?.toString(), lines: m.getLineCount() }))
            : [];
          return {
            href: location.href.slice(0, 140),
            isMain,
            title: document.title,
            buttonCount: btns.length,
            buttons: btns.slice(0, 60),
            inputs: inputs.slice(0, 30),
            hasMonaco,
            monacoModels,
            bodyState: document.body?.getAttribute('data-state') || ''
          };
        }
      });
      return { ok: true, tabId, frames: results.map(r => r.result).filter(Boolean) };
    }

    if (cmd === 'FLOW_EXTRACT_CODE') {
      const tabId = await findGoogleFlowTabId(args.tabId);
      if (!tabId) throw new Error('ไม่พบแท็บ Google Flow ที่เปิดอยู่');
      const [res] = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        world: 'MAIN',
        func: async () => {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

          // 1. Switch to Edit mode if needed
          const allBtns = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"]')).filter(b => b.offsetWidth > 0);
          const editBtn = allBtns.find(b => /^(Edit|แก้ไข)$/i.test(norm(b.innerText || b.textContent)));
          if (editBtn) {
            editBtn.click();
            await sleep(1000);
          }

          // 2. Click Code tab
          const tabsNow = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], div[class*="tab"]')).filter(b => b.offsetWidth > 0);
          const codeTab = tabsNow.find(b => /^(Code|รหัส)$/i.test(norm(b.innerText || b.textContent)));
          if (codeTab) {
            codeTab.click();
            await sleep(1500);
          }

          const files = {};
          const debugLog = [];

          // Strategy A: Check Monaco models directly
          if (window.monaco?.editor?.getModels) {
            const models = window.monaco.editor.getModels();
            debugLog.push(`Monaco models found: ${models.length}`);
            for (const m of models) {
              const uri = m.uri?.path || m.uri?.toString() || `model_${Object.keys(files).length}.tsx`;
              const val = m.getValue();
              if (val && val.trim().length > 0) {
                files[uri.replace(/^\/+/, '')] = val;
              }
            }
          }

          // Strategy B: Inspect React Fiber / Props across the Code view for full file map
          const extractFromReactFiber = (rootEl) => {
            const visited = new Set();
            const foundFiles = {};
            const walkFiber = (fiber, depth = 0) => {
              if (!fiber || depth > 45 || visited.has(fiber)) return;
              visited.add(fiber);
              const inspectObj = (obj) => {
                if (!obj || typeof obj !== 'object') return;
                for (const [k, v] of Object.entries(obj)) {
                  if (typeof v === 'string' && /\.(tsx|ts|js|css|json)$/i.test(k) && v.length > 10) {
                    foundFiles[k] = v;
                  } else if (v && typeof v === 'object' && !Array.isArray(v)) {
                    // Check if v is a map of filenames -> code or { content / code }
                    for (const [fk, fv] of Object.entries(v)) {
                      if (/\.(tsx|ts|js|css|json)$/i.test(fk)) {
                        if (typeof fv === 'string' && fv.length > 10) foundFiles[fk] = fv;
                        else if (fv && typeof fv === 'object' && typeof (fv.content || fv.code || fv.value) === 'string') {
                          foundFiles[fk] = fv.content || fv.code || fv.value;
                        }
                      }
                    }
                  } else if (Array.isArray(v)) {
                    for (const item of v) {
                      if (item && typeof item === 'object') {
                        const name = item.name || item.path || item.filename || item.fileName;
                        const code = item.content ?? item.code ?? item.value ?? item.source;
                        if (typeof name === 'string' && /\.(tsx|ts|js|css|json)$/i.test(name) && typeof code === 'string') {
                          foundFiles[name] = code;
                        }
                      }
                    }
                  }
                }
              };
              try {
                inspectObj(fiber.memoizedProps);
                inspectObj(fiber.pendingProps);
                let st = fiber.memoizedState;
                let sDepth = 0;
                while (st && sDepth < 20) {
                  inspectObj(st.memoizedState);
                  inspectObj(st);
                  st = st.next;
                  sDepth++;
                }
              } catch (_) {}
              walkFiber(fiber.return, depth + 1);
              walkFiber(fiber.child, depth + 1);
              walkFiber(fiber.sibling, depth + 1);
            };

            const els = rootEl ? [rootEl, ...rootEl.querySelectorAll('*')] : Array.from(document.querySelectorAll('*'));
            for (const el of els.slice(0, 600)) {
              const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
              if (fiberKey && el[fiberKey]) {
                walkFiber(el[fiberKey], 0);
              }
            }
            return foundFiles;
          };

          const fiberFiles = extractFromReactFiber(document.body);
          if (Object.keys(fiberFiles).length > 0) {
            debugLog.push(`Fiber extracted ${Object.keys(fiberFiles).length} files: ${Object.keys(fiberFiles).join(', ')}`);
            Object.assign(files, fiberFiles);
          }

          // Strategy C: Click each file in the file tree and extract from Editor / CodeMirror / DOM Scroll
          const findFileTreeNodes = () => {
            const candidates = Array.from(document.querySelectorAll('div, span, button, li, [role="treeitem"]'))
              .filter(el => el.offsetWidth > 0 && el.children.length <= 3);
            const matched = [];
            const seenNames = new Set();
            for (const el of candidates) {
              const txt = norm(el.innerText || el.textContent).replace(/^code\s*/i, '').replace(/^<>\s*/, '').trim();
              if (/^[A-Za-z0-9_\/.-]+\.(tsx|ts|js|css|json|html)$/i.test(txt) && !seenNames.has(txt)) {
                seenNames.add(txt);
                matched.push({ name: txt, el });
              }
            }
            return matched;
          };

          const readCurrentEditorText = async () => {
            // 1. Check CodeMirror 6 view
            const cmEl = document.querySelector('.cm-content, .cm-editor');
            if (cmEl) {
              let cur = cmEl;
              while (cur) {
                if (cur.cmView?.view?.state?.doc) {
                  return cur.cmView.view.state.doc.toString();
                }
                cur = cur.parentElement;
              }
            }
            // 2. Check Monaco active model
            if (window.monaco?.editor?.getEditors) {
              const eds = window.monaco.editor.getEditors();
              if (eds.length > 0 && eds[0].getModel()) {
                return eds[0].getModel().getValue();
              }
            }
            // 3. Check Fiber on current editor
            const editorEl = document.querySelector('.monaco-editor, .cm-editor, pre, code, [class*="editor"]');
            if (editorEl) {
              const ff = extractFromReactFiber(editorEl);
              const vals = Object.values(ff);
              if (vals.length === 1) return vals[0];
            }
            // 4. Scroll-and-stitch virtualized lines or read full pre/code
            const viewLines = document.querySelector('.view-lines, .cm-content, pre');
            if (!viewLines) return '';
            const scroller = viewLines.closest('.monaco-scrollable-element, .cm-scroller, [ style*="overflow" ]') || viewLines.parentElement;
            if (scroller && scroller.scrollHeight > scroller.clientHeight + 50 && document.querySelector('.view-lines')) {
              const lineMap = new Map();
              scroller.scrollTop = 0;
              await sleep(150);
              const maxScroll = scroller.scrollHeight;
              const step = Math.max(200, Math.floor(scroller.clientHeight * 0.7));
              for (let pos = 0; pos <= maxScroll + step; pos += step) {
                scroller.scrollTop = pos;
                await sleep(120);
                const lineNums = Array.from(document.querySelectorAll('.line-numbers'));
                const vLines = Array.from(document.querySelectorAll('.view-line'));
                if (lineNums.length === vLines.length && lineNums.length > 0) {
                  for (let idx = 0; idx < lineNums.length; idx++) {
                    const num = parseInt(lineNums[idx].textContent.trim(), 10);
                    if (!isNaN(num)) lineMap.set(num, vLines[idx].innerText || vLines[idx].textContent || '');
                  }
                }
              }
              if (lineMap.size > 0) {
                const maxLine = Math.max(...lineMap.keys());
                const out = [];
                for (let ln = 1; ln <= maxLine; ln++) {
                  out.push((lineMap.get(ln) || '').replace(/\u00a0/g, ' '));
                }
                return out.join('\n');
              }
            }
            return (viewLines.innerText || viewLines.textContent || '').replace(/\u00a0/g, ' ');
          };

          const treeNodes = findFileTreeNodes();
          debugLog.push(`Tree nodes found: ${treeNodes.map(t => t.name).join(', ')}`);

          for (const node of treeNodes) {
            if (files[node.name] && files[node.name].length > 100) continue;
            node.el.click();
            await sleep(600);
            // Re-check Fiber after clicking file
            const postClickFiber = extractFromReactFiber(document.body);
            Object.assign(files, postClickFiber);
            if (!files[node.name]) {
              const text = await readCurrentEditorText();
              if (text && text.trim().length > 0) {
                files[node.name] = text;
              }
            }
          }

          return {
            ok: true,
            fileCount: Object.keys(files).length,
            fileNames: Object.keys(files),
            files,
            debugLog
          };
        }
      });
      return res?.result || { ok: false, error: 'Empty script result' };
    }

    if (cmd === 'FLOW_SEND_BUILDER_PROMPT') {
      const tabId = await findGoogleFlowTabId(args.tabId);
      if (!tabId) throw new Error('ไม่พบแท็บ Google Flow ที่เปิดอยู่');
      const [res] = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        world: 'MAIN',
        args: [args.prompt || ''],
        func: async (promptText) => {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

          // Ensure Edit mode is open so Tool Builder is visible
          const allBtns = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"]')).filter(b => b.offsetWidth > 0);
          const editBtn = allBtns.find(b => /^(Edit|แก้ไข)$/i.test(norm(b.innerText || b.textContent)));
          if (editBtn) {
            editBtn.click();
            await sleep(800);
          }

          // Find Tool Builder textarea/input ("What do you want to create?" / "คุณต้องการสร้างอะไร")
          const inputs = Array.from(document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]')).filter(el => el.offsetWidth > 0);
          const builderInput = inputs.find(el => {
            const ph = (el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').toLowerCase();
            return ph.includes('what do you want to create') || ph.includes('ต้องการสร้างอะไร') || ph.includes('create') || ph.includes('สร้าง');
          }) || inputs[inputs.length - 1];

          if (!builderInput) {
            return { ok: false, error: 'ไม่พบช่องพิมพ์ Tool Builder' };
          }

          builderInput.focus();
          if (builderInput.tagName === 'TEXTAREA' || builderInput.tagName === 'INPUT') {
            const proto = builderInput.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(builderInput, promptText);
            else builderInput.value = promptText;
            builderInput.dispatchEvent(new Event('input', { bubbles: true }));
            builderInput.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, promptText);
            builderInput.dispatchEvent(new Event('input', { bubbles: true }));
          }
          await sleep(400);

          // Find send button near builderInput
          const container = builderInput.closest('form') || builderInput.parentElement?.parentElement || document;
          const sendBtn = Array.from(container.querySelectorAll('button, [role="button"]'))
            .filter(b => b.offsetWidth > 0 && !b.disabled)
            .find(b => /arrow_forward|send|ส่ง|submit/i.test((b.innerText || b.textContent || b.getAttribute('aria-label') || '')));

          if (sendBtn) {
            sendBtn.click();
            return { ok: true, method: 'button_click' };
          }

          // Fallback: Enter key
          builderInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          return { ok: true, method: 'enter_key' };
        }
      });
      return res?.result || { ok: false, error: 'Failed to send builder prompt' };
    }

    if (cmd === 'FLOW_UPDATE_CODE_DIRECT') {
      const tabId = await findGoogleFlowTabId(args.tabId);
      if (!tabId) throw new Error('ไม่พบแท็บ Google Flow ที่เปิดอยู่');
      const [res] = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        world: 'MAIN',
        args: [args.fileName || 'App.tsx', args.code || ''],
        func: async (targetFile, newCode) => {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

          // Switch to Edit -> Code
          const allBtns = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"]')).filter(b => b.offsetWidth > 0);
          const editBtn = allBtns.find(b => /^(Edit|แก้ไข)$/i.test(norm(b.innerText || b.textContent)));
          if (editBtn) { editBtn.click(); await sleep(800); }
          const codeTab = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"]')).filter(b => b.offsetWidth > 0)
            .find(b => /^(Code|รหัส)$/i.test(norm(b.innerText || b.textContent)));
          if (codeTab) { codeTab.click(); await sleep(1000); }

          // Click target file in tree
          const candidates = Array.from(document.querySelectorAll('div, span, button, li, [role="treeitem"]'))
            .filter(el => el.offsetWidth > 0 && el.children.length <= 3);
          const fileEl = candidates.find(el => {
            const txt = norm(el.innerText || el.textContent).replace(/^code\s*/i, '').replace(/^<>\s*/, '').trim();
            return txt.toLowerCase() === targetFile.toLowerCase() || txt.toLowerCase().endsWith(targetFile.toLowerCase());
          });
          if (fileEl) {
            fileEl.click();
            await sleep(700);
          }

          // 1. Try Monaco Model setValue
          if (window.monaco?.editor?.getEditors) {
            const eds = window.monaco.editor.getEditors();
            if (eds.length > 0 && eds[0].getModel()) {
              eds[0].getModel().setValue(newCode);
              return { ok: true, method: 'monaco_setValue', file: targetFile };
            }
          }

          // 2. Try CodeMirror 6 view dispatch
          const cmEl = document.querySelector('.cm-content, .cm-editor');
          if (cmEl) {
            let cur = cmEl;
            while (cur) {
              if (cur.cmView?.view) {
                const view = cur.cmView.view;
                view.dispatch({
                  changes: { from: 0, to: view.state.doc.length, insert: newCode }
                });
                return { ok: true, method: 'codemirror_dispatch', file: targetFile };
              }
              cur = cur.parentElement;
            }
          }

          // 3. Fallback: contenteditable / input selectAll + insertText
          const editable = document.querySelector('.cm-content[contenteditable="true"], .monaco-editor textarea, [contenteditable="true"]');
          if (editable) {
            editable.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, newCode);
            editable.dispatchEvent(new Event('input', { bubbles: true }));
            return { ok: true, method: 'execCommand_insertText', file: targetFile };
          }

          return { ok: false, error: 'ไม่พบ Editor ที่รองรับการเขียนโค้ดโดยตรง' };
        }
      });
      return res?.result || { ok: false, error: 'Failed to update code' };
    }

    if (cmd === 'GET_FULL_DIAGNOSTIC') {
      const tabs = await chrome.tabs.query({});
      const store = await storageGet([
        'phimbot_products',
        'phimbot_media_vault',
        'phimbot_queue',
        'phimbot_history',
        'phimbot_factory_settings',
        'ag_e2e_dry_run',
        'openrouter_api_key',
        'phimbot_gemini_key',
        'openrouter_model',
      ]);
      const prods = Array.isArray(store.phimbot_products) ? store.phimbot_products : [];
      const vault = Array.isArray(store.phimbot_media_vault) ? store.phimbot_media_vault : [];
      const queue = Array.isArray(store.phimbot_queue) ? store.phimbot_queue : [];
      const history = Array.isArray(store.phimbot_history) ? store.phimbot_history : [];

      let sidepanelStatus = null;
      try {
        sidepanelStatus = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout_or_closed' }), 800);
          chrome.runtime.sendMessage({ type: 'AG_SIDEPANEL_PING' }, (resp) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              resolve({ ok: false, reason: chrome.runtime.lastError.message });
            } else {
              resolve(resp || { ok: false, reason: 'no_response' });
            }
          });
        });
      } catch (e) {
        sidepanelStatus = { ok: false, reason: e.message };
      }

      return {
        ok: true,
        version: chrome.runtime.getManifest().version,
        isQueueRunning,
        isQueuePaused,
        dryRunMode: Boolean(store.ag_e2e_dry_run),
        hasOpenRouterKey: Boolean(store.openrouter_api_key),
        hasGeminiKey: Boolean(store.phimbot_gemini_key),
        openrouterModel: store.openrouter_model || '',
        factorySettings: store.phimbot_factory_settings || null,
        counts: {
          products: prods.length,
          vault: vault.length,
          queue: queue.length,
          history: history.length,
        },
        productsSample: prods.slice(0, 10).map(p => ({
          id: p.id,
          productId: p.productId || p.tiktokProductId || '',
          name: p.name || p.title || '',
          imagesCount: Array.isArray(p.images) ? p.images.length : (p.imageUrl || p.image ? 1 : 0),
          affiliateUrl: p.affiliateUrl || p.productUrl || '',
          platform: p.platform || '',
        })),
        vaultSample: vault.slice(0, 10).map(v => ({
          id: v.id,
          productId: v.productId || '',
          productName: v.productName || '',
          productUrl: v.productUrl || '',
          platform: v.platform || '',
          videoStorageKey: v.videoStorageKey || v.videoKey || '',
          videoBase64Size: v.videoBase64Size || (v.videoBase64 ? v.videoBase64.length : 0),
          hasInlineBase64: Boolean(v.videoBase64),
          posted: v.posted || {},
          createdAt: v.createdAt || '',
        })),
        queueSample: queue.slice(0, 10).map(q => ({
          id: q.id,
          platform: q.platform || 'tiktok',
          productId: q.productId || '',
          status: q.status || '',
          publishMode: q.publishMode || '',
          scheduledAt: q.scheduledAt || null,
          error: q.error || null,
        })),
        sidepanelStatus,
        tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active })),
      };
    }

    if (cmd === 'STORAGE_GET') {
      const keys = args.keys || null;
      const data = await chrome.storage.local.get(keys);
      return { ok: true, data };
    }

    if (cmd === 'STORAGE_SET') {
      await chrome.storage.local.set(args.items || {});
      return { ok: true };
    }

    if (cmd === 'SET_DRY_RUN') {
      const enabled = Boolean(args.enabled);
      await chrome.storage.local.set({ ag_e2e_dry_run: enabled });
      return { ok: true, dryRunMode: enabled };
    }

    if (cmd === 'ENSURE_SIDEPANEL_UI') {
      const pingOnce = () => new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 700);
        chrome.runtime.sendMessage({ type: 'AG_SIDEPANEL_PING' }, (resp) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) resolve(null);
          else resolve(resp);
        });
      });

      let status = !args.forceReload ? await pingOnce() : null;
      if (status?.ok) {
        return { ok: true, alreadyOpen: true, status };
      }

      // Open sidepanel.html in a tab if not open so all Sidepanel + Factory + Vault scripts run live
      const spUrl = chrome.runtime.getURL('sidepanel.html');
      const existingTabs = await chrome.tabs.query({});
      let spTab = existingTabs.find(t => t.url && t.url.startsWith(spUrl));
      if (spTab) {
        await chrome.tabs.reload(spTab.id);
      } else {
        spTab = await chrome.tabs.create({ url: spUrl, active: Boolean(args.active) });
      }

      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 400));
        status = await pingOnce();
        if (status?.ok) {
          return { ok: true, alreadyOpen: false, tabId: spTab.id, status };
        }
      }
      return { ok: false, error: 'Sidepanel UI did not respond after opening tab', tabId: spTab?.id };
    }

    if (cmd === 'SIDEPANEL_CMD') {
      const resp = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, error: 'AG_SIDEPANEL_CMD timeout (45s)' }), 45000);
        chrome.runtime.sendMessage({
          type: 'AG_SIDEPANEL_CMD',
          ...args,
        }, (r) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(r || { ok: false, error: 'Empty response from sidepanel' });
          }
        });
      });
      return resp;
    }

    if (cmd === 'DETECT_GENDER') {
      const gRes = await detectCharacterGenderFromBase64(args.dataUrl);
      if (gRes?.ok && gRes.gender && args.syncFlow !== false) {
        const flowSync = await setFlowToolGenderInBrowser(gRes.gender);
        return { ...gRes, flowSync };
      }
      return gRes;
    }

    if (cmd === 'TEST_TIKTOK_POST_DRY_RUN') {
      // Load video from vault item if vaultId is provided
      let job = args.job ? { ...args.job } : null;
      if (!job && args.vaultId) {
        const st = await chrome.storage.local.get(['phimbot_media_vault', 'phimbot_products']);
        const vault = st.phimbot_media_vault || [];
        const prods = st.phimbot_products || [];
        const vItem = vault.find(v => v.id === args.vaultId) || vault[0];
        if (!vItem) throw new Error('ไม่พบคลิปในคลังวีดีโอสำหรับทดสอบโพสต์');

        let videoDataUrl = vItem.videoBase64 || '';
        const storageKey = vItem.videoStorageKey || vItem.videoKey || '';
        if (!videoDataUrl && storageKey && storageKey !== 'storage_failed') {
          const kv = await chrome.storage.local.get([storageKey]);
          videoDataUrl = kv[storageKey] || '';
        }
        if (!videoDataUrl) throw new Error(`ไม่พบข้อมูลไฟล์วีดีโอสำหรับ ${vItem.id} (key: ${storageKey || 'none'})`);

        let rawPid = String(vItem.productId || '').trim().replace(/^(PID_)?UNKNOWN$/i, '').replace(/^PID_/i, '').trim();
        let matchedProd = prods.find(p => {
          const cPid = String(p.productId || p.tiktokProductId || p.id || '').trim().replace(/^PID_/i, '');
          return (rawPid && cPid === rawPid) || (vItem.productName && (p.name === vItem.productName || p.title === vItem.productName));
        }) || prods[0] || {};

        const finalPid = rawPid || String(matchedProd.productId || matchedProd.tiktokProductId || '').replace(/^PID_/i, '').trim();
        const finalName = vItem.productName || matchedProd.name || matchedProd.title || 'สินค้าแนะนำ';

        job = {
          id: `ag_dryrun_${Date.now()}`,
          videoDataUrl,
          caption: vItem.caption || `🔥 แนะนำเลย! ${finalName} ใช้ดีจริง พิกัดในตะกร้าเลยจ้า ✨`,
          hashtags: Array.isArray(vItem.hashtags) && vItem.hashtags.length ? vItem.hashtags : ['#รีวิวของดี', '#ป้ายยา', '#TikTokShop'],
          productId: finalPid,
          publishMode: args.publishMode || 'now',
          scheduledAt: args.scheduledAt || null,
          dryRunVerifyOnly: true,
          keepTabOpen: Boolean(args.keepTabOpen),
          aiContext: {
            productName: finalName,
          },
        };
      }
      if (!job) throw new Error('ต้องระบุ job หรือ vaultId');
      job.dryRunVerifyOnly = true;
      await chrome.storage.local.set({ ag_e2e_dry_run: true });
      const postResult = await postSingleVideo(job);
      return {
        ok: Boolean(postResult?.ok),
        jobSummary: {
          id: job.id,
          productId: job.productId,
          productName: job.aiContext?.productName || '',
          publishMode: job.publishMode,
          videoSizeMB: job.videoDataUrl ? +(job.videoDataUrl.length / 1024 / 1024).toFixed(2) : 0,
        },
        postResult,
      };
    }

    if (cmd === 'START_QUEUE') {
      processQueue();
      return { ok: true, isQueueRunning: true };
    }

    if (cmd === 'STOP_QUEUE') {
      isQueuePaused = true;
      isQueueRunning = false;
      if (currentQueueAbort) currentQueueAbort.abort();
      return { ok: true, isQueueRunning: false };
    }

    if (cmd === 'RELOAD_EXTENSION') {
      setTimeout(() => {
        try { chrome.runtime.reload(); } catch (_) {}
      }, 400);
      return { ok: true, reloading: true };
    }

    throw new Error(`Unknown command: ${cmd}`);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function pollAntigravityBridgeOnce(src = 'bg') {
  if (_agBridgePolling) return;
  _agBridgePolling = true;
  try {
    const ver = chrome.runtime.getManifest().version;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${ANTIGRAVITY_BRIDGE_URL}/poll?v=${encodeURIComponent(ver)}&src=${encodeURIComponent(src)}`, {
      signal: ctrl.signal
    });
    clearTimeout(t);
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.command) {
      const cmdObj = data.command;
      console.log('[Antigravity Bridge] Executing command:', cmdObj.cmd, cmdObj.id);
      const outcome = await executeAntigravityCommand(cmdObj);
      await fetch(`${ANTIGRAVITY_BRIDGE_URL}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: cmdObj.id,
          ok: Boolean(outcome?.ok),
          result: outcome,
          error: outcome?.error || null
        })
      });
    }
  } catch (_) {
    // Silent when bridge server is not running
  } finally {
    _agBridgePolling = false;
  }
}

setInterval(() => pollAntigravityBridgeOnce('bg'), 2000);
pollAntigravityBridgeOnce('bg_init');

async function setFlowToolGenderInBrowser(gender) {
  const targetGender = gender === 'male' ? 'male' : 'female';
  const tabs = await chrome.tabs.query({});
  const flowTabs = tabs.filter(t => t.url && (t.url.includes('flow.google.com') || t.url.includes('labs.google')));
  let clickedCount = 0;

  for (const tab of flowTabs) {
    try {
      const results = await Promise.race([
        chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          world: 'MAIN',
          args: [targetGender],
          func: (g) => {
            let clicked = false;
            const matchText = g === 'male' ? /ชาย\s*\(ครับ\)|^ชาย$/i : /หญิง\s*\(ค่ะ\)|^หญิง$/i;
            const clickInDoc = (doc) => {
              if (!doc) return;
              const btns = Array.from(doc.querySelectorAll('button, [role="button"], [role="tab"]'));
              for (const b of btns) {
                const txt = (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim();
                if (matchText.test(txt)) {
                  b.click();
                  clicked = true;
                }
              }
            };
            clickInDoc(document);
            document.querySelectorAll('iframe').forEach(f => {
              try { clickInDoc(f.contentDocument); } catch (_) {}
            });
            return clicked;
          }
        }),
        new Promise(r => setTimeout(() => r([]), 4000))
      ]);
      if (Array.isArray(results) && results.some(r => r?.result)) {
        clickedCount++;
      }
    } catch (_) {}
  }
  return { ok: true, gender: targetGender, clickedCount };
}

async function detectCharacterGenderFromBase64(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return { ok: false, error: 'Invalid image dataUrl' };
  }
  const parts = dataUrl.split(';base64,');
  const mimeType = (parts[0] || 'data:image/jpeg').replace('data:', '');
  const base64Raw = parts[1] || '';

  const parseGenderAnswer = (txt) => {
    const clean = String(txt || '').toLowerCase().trim();
    if (/\bmale\b|ผู้ชาย|ชาย|หนุ่ม|นายแบบ/.test(clean) && !/\bfemale\b|ผู้หญิง|หญิง/.test(clean)) return 'male';
    if (/\bfemale\b|ผู้หญิง|หญิง|สาว|นางแบบ/.test(clean)) return 'female';
    return null;
  };

  try {
    const config = await storageGet(['openrouter_api_key', 'phimbot_gemini_key', 'openrouter_model', 'phimbot_api_provider']);

    // 1. Try Gemini API directly if key exists
    if (config.phimbot_gemini_key) {
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${config.phimbot_gemini_key}`;
        const resp = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [
                { text: 'Look at the person in this image. Are they male or female? Reply with ONLY one word: male or female.' },
                { inlineData: { mimeType, data: base64Raw } }
              ]
            }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 10 }
          })
        });
        if (resp.ok) {
          const data = await resp.json();
          const ans = parseGenderAnswer(data?.candidates?.[0]?.content?.parts?.[0]?.text);
          if (ans) return { ok: true, gender: ans, source: 'gemini' };
        }
      } catch (_) {}
    }

    // 2. Try OpenRouter Vision API if key exists
    if (config.openrouter_api_key) {
      try {
        const model = config.openrouter_model || 'google/gemini-2.5-flash';
        const resp = await fetch(OPENROUTER_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.openrouter_api_key}`,
            'HTTP-Referer': chrome.runtime.getURL('/'),
            'X-Title': 'PhimBot'
          },
          body: JSON.stringify({
            model,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: 'Look at the person in this image. Are they male or female? Reply with ONLY one word: male or female.' },
                { type: 'image_url', image_url: { url: dataUrl } }
              ]
            }],
            max_tokens: 10,
            temperature: 0.1
          })
        });
        if (resp.ok) {
          const data = await resp.json();
          const ans = parseGenderAnswer(data?.choices?.[0]?.message?.content);
          if (ans) return { ok: true, gender: ans, source: 'openrouter' };
        }
      } catch (_) {}
    }

    // 3. Fallback: Ask Google Flow SDK inside open Google Flow tab if available
    const flowTabId = await findGoogleFlowTabId();
    if (flowTabId) {
      const results = await Promise.race([
        chrome.scripting.executeScript({
          target: { tabId: flowTabId, allFrames: true },
          world: 'MAIN',
          args: [base64Raw, mimeType],
          func: async (b64, mime) => {
            try {
              const flowSdk = window.Flow || window.flow;
              if (flowSdk?.generate?.text) {
                const res = await flowSdk.generate.text(
                  'Look at the person in this image. Reply with ONLY one word: male or female.',
                  { images: [{ base64: b64, mimeType: mime }] }
                );
                return res?.text || '';
              }
            } catch (_) {}
            return '';
          }
        }),
        new Promise(r => setTimeout(() => r([]), 8000))
      ]);
      if (Array.isArray(results)) {
        for (const r of results) {
          const ans = parseGenderAnswer(r?.result);
          if (ans) return { ok: true, gender: ans, source: 'flow_sdk' };
        }
      }
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }

  return { ok: false, error: 'Could not auto-detect gender' };
}




