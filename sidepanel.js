/**
 * PhimBot — Side Panel UI Logic (v3 — OmniPost-style)
 * Toggle switches, Product modal, Custom dropdown, Batch queue
 */
(async function () {
  'use strict';
  await window.PhimI18n.init();
  window.PhimI18n.applyToDOM();

  // ── Bridge Config: ตั้ง endpoint + token สำหรับ PUP PAP POST Bridge (USB) ──
  try {
    const _bs = await chrome.storage.local.get(['phimbot_bridge_endpoint','phimbot_bridge_token']);
    if (!_bs.phimbot_bridge_token) {
      await chrome.storage.local.set({
        phimbot_bridge_endpoint: 'http://127.0.0.1:17881',
        phimbot_bridge_token: 'SHOPEE-S8W66-QJTM7-BY55D-PUDKR'
      });
      console.log('[PhimBot] Bridge config set: endpoint=http://127.0.0.1:17881 token=SHOPEE-S8W66-QJTM7-BY55D-PUDKR');
    }
  } catch (_bridgeErr) { console.warn('[PhimBot] Bridge config error:', _bridgeErr); }

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  const t = (key, ...a) => window.PhimI18n.t(key, ...a);
  const toast = $('#toast');

  function showToast(msg, dur = 3000) { toast.textContent = msg; toast.classList.remove('hidden'); setTimeout(() => toast.classList.add('hidden'), dur); }
  function sendMsg(type, payload) { return new Promise((r) => chrome.runtime.sendMessage({ type, payload }, (res) => r(res || {}))); }
  function formatSize(b) { if (b < 1024) return `${b} B`; if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`; return `${(b / 1048576).toFixed(1)} MB`; }

  // ── PUP PAP AI Theme Management: ครีมกระดาษมือถือ (Default) ↔ ดำสนิท ──
  try {
    const _th = await chrome.storage.local.get('puppap_theme');
    if (_th.puppap_theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  } catch (_) {}

  const btnThemeToggle = $('#btnThemeToggle');
  btnThemeToggle?.addEventListener('click', async () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const nextTheme = isDark ? 'cream' : 'dark';
    if (nextTheme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      btnThemeToggle.title = 'สลับธีม: กำลังใช้ธีมมืด (คลิกเพื่อเปลี่ยนเป็นธีมครีมมือถือ)';
      showToast('🌙 สลับเป็นธีมดำสนิท (Dark Mode)');
    } else {
      document.documentElement.removeAttribute('data-theme');
      btnThemeToggle.title = 'สลับธีม: กำลังใช้ธีมครีมมือถือ (คลิกเพื่อเปลี่ยนเป็นธีมมืด)';
      showToast('🎨 สลับเป็นธีมครีมมือถือ (Cream Paper)');
    }
    await chrome.storage.local.set({ puppap_theme: nextTheme }).catch(() => {});
  });

  /* ═══ Tab Switching ═══ */
  $$('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach((b) => b.classList.remove('active'));
      $$('.tab-content').forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      $(`#tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'queue') refreshQueue();
      if (btn.dataset.tab === 'products') refreshProducts();
      if (btn.dataset.tab === 'shopee-video' && typeof updateShopeeTargetDeviceOptions === 'function') {
        updateShopeeTargetDeviceOptions();
        checkShopeeDeviceConnection();
      }
    });
  });

  /* ═══════════════════════════════════════════════════════════════
     ① TOGGLE SWITCHES
     ═══════════════════════════════════════════════════════════════ */
  const masterToggle = $('#masterToggle');
  const toggleBasket = $('#toggleBasket');
  const toggleSkipAI = $('#toggleSkipAI');
  const toggleDisclose = $('#toggleDisclose');
  const toggleAutoHashtags = $('#toggleAutoHashtags');

  const subToggles = [toggleBasket, toggleSkipAI, toggleDisclose, toggleAutoHashtags];

  masterToggle?.addEventListener('change', () => {
    const on = masterToggle.checked;
    subToggles.forEach((t) => { if (t) t.disabled = !on; });
    if (!on) {
      subToggles.forEach((t) => { if (t) t.checked = false; });
    }
  });

  /* ═══════════════════════════════════════════════════════════════
     ② PRODUCT PICKER + MODAL
     ═══════════════════════════════════════════════════════════════ */
  const selectedProductCard = $('#selectedProductCard');
  const selectedProductImg = $('#selectedProductImg');
  const selectedProductName = $('#selectedProductName');
  const selectedProductMeta = $('#selectedProductMeta');
  const clearSelectedProduct = $('#clearSelectedProduct');
  const productPickerCard = $('#productPickerCard');
  const noProductHint = $('#noProductHint');
  const basketCta = $('#basketCta');

  let selectedProduct = null;
  let selectedProducts = []; // for multi-select modal
  let pickerProducts = [];

  async function loadPickerProducts() {
    const res = await sendMsg('PHIMBOT_GET_PRODUCTS');
    pickerProducts = res.products || [];
  }
  loadPickerProducts(); // Load on startup

  function selectProduct(product) {
    selectedProduct = product;
    window.__phimbotSelectedProduct = product;
    selectedProductImg.src = product.imageUrl || '';
    selectedProductName.textContent = product.name;
    selectedProductMeta.textContent = `ID: ${product.productId} | ฿${(product.price || 0).toLocaleString()} | ${product.statusLabel || product.status || ''}`;
    selectedProductCard.classList.remove('hidden');
    productPickerCard.classList.add('hidden');
    noProductHint?.classList.add('hidden');

    // Auto-fill AI fields
    const aiName = $('#aiProductName');
    const aiPrice = $('#aiProductPrice');
    if (aiName) aiName.value = product.name;
    if (aiPrice) aiPrice.value = product.price ? `฿${product.price}` : '';
  }

  function selectMultipleProducts(products) {
    selectedProducts = products;
    window.__phimbotSelectedProducts = products;
    if (products.length === 1) {
      selectProduct(products[0]);
    } else if (products.length > 1) {
      selectedProduct = products[0]; // primary product
      window.__phimbotSelectedProduct = products[0];
      selectedProductImg.src = products[0].imageUrl || '';
      selectedProductName.textContent = `${products.length} สินค้าที่เลือก`;
      selectedProductMeta.textContent = products.map((p) => p.name).join(', ');
      selectedProductCard.classList.remove('hidden');
      productPickerCard.classList.add('hidden');
      noProductHint?.classList.add('hidden');

      const aiName = $('#aiProductName');
      if (aiName) aiName.value = products.map((p) => p.name).join(' / ');
    }
  }

  clearSelectedProduct?.addEventListener('click', () => {
    selectedProduct = null;
    selectedProducts = [];
    window.__phimbotSelectedProduct = null;
    window.__phimbotSelectedProducts = [];
    selectedProductCard.classList.add('hidden');
    productPickerCard.classList.remove('hidden');
    noProductHint?.classList.remove('hidden');
  });

  // Open modal on card click
  productPickerCard?.addEventListener('click', () => openProductModal());

  // Listen for product selection from Products/Shopee tabs (via CustomEvent)
  window.addEventListener('phimbot-select-product', (e) => {
    if (e.detail) selectProduct(e.detail);
    loadPickerProducts(); // Refresh modal product list
  });

  // Also open modal on selected product click (to change)
  selectedProductCard?.addEventListener('click', (e) => {
    if (e.target.closest('.btn-icon')) return; // don't open on X button
    openProductModal();
  });

  /* ─── Product Modal Logic ───────────────────────────────── */
  const productModal = $('#productModal');
  const modalProductSearch = $('#modalProductSearch');
  const modalProductGrid = $('#modalProductGrid');
  const modalSelectedCount = $('#modalSelectedCount');
  const modalSelectAll = $('#modalSelectAll');
  const modalClearAll = $('#modalClearAll');
  const modalCancel = $('#modalCancel');
  const modalConfirm = $('#modalConfirm');

  let modalSelected = new Set(); // set of productId

  function openProductModal() {
    if (!pickerProducts.length) {
      showToast('กรุณาสแกนสินค้าจากแท็บ "สินค้า" ก่อน');
      return;
    }
    // Pre-select current product(s)
    modalSelected = new Set();
    if (selectedProducts.length) {
      selectedProducts.forEach((p) => modalSelected.add(p.productId));
    } else if (selectedProduct) {
      modalSelected.add(selectedProduct.productId);
    }
    modalProductSearch.value = '';
    renderModalGrid(pickerProducts);
    productModal.classList.remove('hidden');
  }

  function closeProductModal() {
    productModal.classList.add('hidden');
  }

  function renderModalGrid(products) {
    const total = pickerProducts.length;
    modalSelectedCount.textContent = `เลือก ${modalSelected.size} / ${total}`;

    if (!products.length) {
      modalProductGrid.innerHTML = '<div class="modal-empty">ไม่พบสินค้า</div>';
      return;
    }

    modalProductGrid.innerHTML = products.map((p) => {
      const safeName = String(p.name || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      return `
      <div class="grid-product${modalSelected.has(p.productId) ? ' selected' : ''}" data-id="${p.productId}" style="min-height: 100px; display: flex; flex-direction: column;">
        <img class="grid-product-img" src="${p.imageUrl || ''}" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2264%22 height=%2264%22%3E%3Crect fill=%22%23333%22 width=%2264%22 height=%2264%22/%3E%3Ctext x=%2232%22 y=%2236%22 text-anchor=%22middle%22 fill=%22%23666%22 font-size=%2216%22%3E📦%3C/text%3E%3C/svg%3E'" style="width: 100%; aspect-ratio: 1; object-fit: cover; background: #2a2a2a; flex-shrink: 0;">
        <div class="grid-product-name" title="${safeName}" style="padding: 6px; font-size: 11px; line-height: 1.3; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; color: #fff;">${safeName}</div>
      </div>
      `;
    }).join('');

    modalProductGrid.querySelectorAll('.grid-product').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        if (modalSelected.has(id)) {
          modalSelected.delete(id);
          el.classList.remove('selected');
        } else {
          modalSelected.add(id);
          el.classList.add('selected');
        }
        modalSelectedCount.textContent = `เลือก ${modalSelected.size} / ${total}`;
      });
    });
  }

  // Search
  modalProductSearch?.addEventListener('input', () => {
    const q = modalProductSearch.value.trim().toLowerCase();
    const filtered = q ? pickerProducts.filter((p) => p.name.toLowerCase().includes(q) || p.productId.includes(q)) : pickerProducts;
    renderModalGrid(filtered);
  });

  // Select all / Clear
  modalSelectAll?.addEventListener('click', () => {
    pickerProducts.forEach((p) => modalSelected.add(p.productId));
    renderModalGrid(pickerProducts);
  });

  modalClearAll?.addEventListener('click', () => {
    modalSelected.clear();
    renderModalGrid(pickerProducts);
  });

  // Filter chips
  $$('input[name="modalFilter"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const val = radio.value;
      const q = modalProductSearch?.value?.trim().toLowerCase() || '';
      let filtered = pickerProducts;
      if (q) filtered = filtered.filter((p) => p.name.toLowerCase().includes(q) || p.productId.includes(q));
      // For now, filter placeholders (posted tracking not yet implemented)
      renderModalGrid(filtered);
    });
  });

  // Cancel
  modalCancel?.addEventListener('click', closeProductModal);

  // Click outside modal box to close
  productModal?.addEventListener('click', (e) => {
    if (e.target === productModal) closeProductModal();
  });

  // Confirm
  modalConfirm?.addEventListener('click', () => {
    if (modalSelected.size === 0) {
      showToast('กรุณาเลือกสินค้าอย่างน้อย 1 รายการ');
      return;
    }
    const products = pickerProducts.filter((p) => modalSelected.has(p.productId));
    selectMultipleProducts(products);
    closeProductModal();
    showToast(`✅ เลือก ${products.length} สินค้า`);
  });

  /* ═══════════════════════════════════════════════════════════════
     ③ CUSTOM DROPDOWN (Publish Mode)
     ═══════════════════════════════════════════════════════════════ */
  const publishTrigger = $('#publishTrigger');
  const publishMenu = $('#publishMenu');
  const publishText = $('#publishText');
  const scheduleSettings = $('#scheduleSettings');
  let selectedPublishMode = 'now';

  publishTrigger?.addEventListener('click', () => {
    const isOpen = !publishMenu.classList.contains('hidden');
    publishMenu.classList.toggle('hidden');
    publishTrigger.classList.toggle('open', !isOpen);
  });

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#publishDropdown')) {
      publishMenu?.classList.add('hidden');
      publishTrigger?.classList.remove('open');
    }
  });

  $$('#publishMenu .dropdown-option').forEach((opt) => {
    opt.addEventListener('click', () => {
      const value = opt.dataset.value;
      selectedPublishMode = value;
      publishText.textContent = opt.textContent;
      $$('#publishMenu .dropdown-option').forEach((o) => o.classList.remove('active'));
      opt.classList.add('active');
      publishMenu.classList.add('hidden');
      publishTrigger.classList.remove('open');

      // Show/hide schedule fields
      scheduleSettings?.classList.toggle('hidden', value !== 'scheduled');
    });
  });

  /* ═══════════════════════════════════════════════════════════════
     ④ MULTI-VIDEO UPLOAD
     ═══════════════════════════════════════════════════════════════ */
  const dropZone = $('#dropZone');
  const videoInput = $('#videoInput');
  const videoList = $('#videoList');
  const uploadEmpty = $('#uploadEmpty');
  const clearAllVideos = $('#clearAllVideos');
  const btnUploadClip = $('#btnUploadClip');
  const btnFromTasks = $('#btnFromTasks');

  let videoFiles = []; // { file, dataUrl, name, size }

  function isVideoFile(f) {
    return f.type.startsWith('video/') || /\.(mp4|mov|avi|mkv|webm|flv|wmv|m4v)$/i.test(f.name);
  }

  function ensureVideoDataUrl(entry) {
    if (entry.dataUrl) return Promise.resolve(entry.dataUrl);
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => { entry.dataUrl = reader.result; resolve(entry.dataUrl); };
      reader.onerror = (e) => reject(e);
      reader.readAsDataURL(entry.file);
    });
  }

  function updateVideoUI() {
    const hasFiles = videoFiles.length > 0;
    uploadEmpty.classList.toggle('hidden', hasFiles);
    clearAllVideos.classList.toggle('hidden', !hasFiles);

    const batchCount = $('#batchQueueCount');
    if (batchCount) batchCount.textContent = hasFiles ? `(${videoFiles.length} คลิป)` : '';

    if (!hasFiles) {
      videoList.innerHTML = '';
      return;
    }

    videoList.innerHTML = videoFiles.map((v, idx) => `
      <div class="video-item" data-idx="${idx}">
        <span class="video-item-num">${idx + 1}</span>
        <span class="video-item-name" title="${v.name}">${v.name}</span>
        <span class="video-item-size">${formatSize(v.size)}</span>
        <button class="btn-icon video-remove" data-idx="${idx}" title="ลบ">✕</button>
      </div>
    `).join('');

    videoList.querySelectorAll('.video-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        videoFiles.splice(parseInt(btn.dataset.idx), 1);
        updateVideoUI();
      });
    });
  }

  function addVideoFiles(files) {
    const list = Array.from(files).filter(isVideoFile);
    if (!list.length) {
      showToast('กรุณาเลือกไฟล์วิดีโอ (.mp4, .mov ฯลฯ)');
      return;
    }
    list.forEach((file) => {
      const entry = { file, dataUrl: null, name: file.name, size: file.size };
      videoFiles.push(entry);
      ensureVideoDataUrl(entry).catch((err) => console.error('[PhimBot] FileReader error:', err));
    });
    updateVideoUI();
  }

  btnUploadClip?.addEventListener('click', (e) => { e.stopPropagation(); videoInput.click(); });
  btnFromTasks?.addEventListener('click', (e) => { e.stopPropagation(); showToast('⏳ ฟีเจอร์นี้กำลังพัฒนา...'); });

  dropZone?.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone?.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); if (e.dataTransfer?.files?.length) addVideoFiles(e.dataTransfer.files); });
  videoInput?.addEventListener('change', () => { if (videoInput.files?.length) addVideoFiles(videoInput.files); videoInput.value = ''; });
  clearAllVideos?.addEventListener('click', (e) => { e.stopPropagation(); videoFiles = []; updateVideoUI(); });

  /* ═══ Toggle sections ═══ */
  const soundEnabled = $('#soundEnabled');
  const soundSettings = $('#soundSettings');
  soundEnabled?.addEventListener('change', () => soundSettings?.classList.toggle('hidden', !soundEnabled.checked));

  /* ═══════════════════════════════════════════════════════════════
     ⑤ BUILD JOB + BATCH QUEUE
     ═══════════════════════════════════════════════════════════════ */
  const captionInput = $('#captionInput');
  const hashtagsInput = $('#hashtagsInput');
  const progressSection = $('#progressSection');
  const progressLog = $('#progressLog');
  const btnBatchQueue = $('#btnBatchQueue');
  const btnPostNow = $('#btnPostNow');

  function buildJobTemplate() {
    const hashtags = (hashtagsInput?.value || '').trim().split(/\s+/).filter(Boolean).slice(0, 5);

    // Map toggle states to job settings
    const basketDisabled = toggleBasket?.checked || false;
    const skipAI = toggleSkipAI?.checked || false;
    const disclose = toggleDisclose?.checked || false;
    const autoHashtags = toggleAutoHashtags?.checked ?? true;

    // Map dropdown to postAction + publishMode
    let postAction = 'post';
    let publishMode = 'now';
    if (selectedPublishMode === 'draft') { postAction = 'draft'; publishMode = 'now'; }
    else if (selectedPublishMode === 'scheduled') { postAction = 'post'; publishMode = 'scheduled'; }
    else if (selectedPublishMode === 'private') { postAction = 'post'; publishMode = 'private'; }
    else { postAction = 'post'; publishMode = 'now'; }

    const hasProduct = !basketDisabled && !!selectedProduct;

    const job = {
      caption: captionInput?.value?.trim() || '',
      hashtags,
      postAction,
      publishMode,
      aiContentEnabled: !skipAI,
      attachProduct: hasProduct,
      productId: hasProduct ? selectedProduct.productId : '',
      basketCta: basketCta?.value?.trim() || '',
      discloseContent: disclose,
      autoHashtags,
      tiktokSettings: {
        soundEnabled: soundEnabled?.checked || false,
        soundTab: $('#soundTab')?.value || 'foryou',
        soundIndex: parseInt($('#soundIndex')?.value) || 1,
        soundSearchMode: 'sequential',
        soundRandomRange: 5,
        originalVolume: parseInt($('#originalVolume')?.value) || 50,
        addedVolume: parseInt($('#addedVolume')?.value) || 50,
      },
    };
    if (publishMode === 'scheduled') {
      const d = $('#scheduleDate')?.value;
      const tm = $('#scheduleTime')?.value;
      if (d && tm) {
        job.scheduledAtBase = new Date(`${d}T${tm}`).getTime();
        job.scheduleInterval = parseInt($('#scheduleInterval')?.value) || 15;
        job.scheduleVariation = parseInt($('#scheduleVariation')?.value) || 0;
      }
    }
    return job;
  }

  function timeStamp() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
  }

  function addProgressItem(level, msg) {
    const div = document.createElement('div');
    div.className = `progress-item ${level}`;
    div.innerHTML = `<span class="step-icon"></span><span class="step-time">[${timeStamp()}]</span> <span>${msg}</span>`;
    progressLog?.appendChild(div);
    if (progressLog) progressLog.scrollTop = progressLog.scrollHeight;
  }

  // Pool of dynamic CTA texts for TikTok basket (<= 30 chars)
  const DYNAMIC_CTA_LIST = [
    'กดตะกร้าเลย', 'พิกัดในตะกร้าเหลือง', 'จิ้มตะกร้าซ้ายล่างเลย',
    'พิกัดของแท้ในตะกร้า', 'ของดีบอกต่อในตะกร้า', 'กดสั่งในตะกร้าได้เลย',
    'พิกัดสินค้าในตะกร้า', 'จิ้มดูในตะกร้าได้เลย', 'รีบกดก่อนหมดในตะกร้า',
    'พิกัดร้านตรงนี้เลย', 'สั่งซื้อจิ้มตะกร้าเลย', 'ของมันต้องมีในตะกร้า',
    'สนใจจิ้มตะกร้าได้เลย', 'พิกัดตัวนี้ในตะกร้า', 'กดตะกร้าเลยจ้า',
    'ดูสินค้าในตะกร้าได้เลย', 'ปักหมุดในตะกร้าแล้ว', 'ชี้เป้าในตะกร้าเลย',
    'กดดูในตะกร้าได้น้า', 'พิกัดของดีในตะกร้า'
  ];

  /* ─── Batch Queue ───────────────────────────────────────── */
  btnBatchQueue?.addEventListener('click', async () => {
    if (!videoFiles.length) { showToast('กรุณาเลือกคลิปก่อน'); return; }

    btnBatchQueue.disabled = true;
    btnBatchQueue.innerHTML = `<span class="spinner"></span> กำลังเตรียมไฟล์วิดีโอ...`;

    // Show progress log
    progressSection?.classList.remove('hidden');
    if (progressLog) progressLog.innerHTML = '';
    addProgressItem('info', `เริ่มเตรียมคิว ${videoFiles.length} คลิป...`);

    // Ensure all video dataURLs are loaded
    try {
      await Promise.all(videoFiles.map(ensureVideoDataUrl));
      addProgressItem('ok', `อ่านไฟล์วิดีโอสำเร็จ ${videoFiles.length} ไฟล์`);
    } catch (err) {
      console.error('[PhimBot] Read video failed:', err);
      addProgressItem('error', 'อ่านไฟล์วิดีโอบางไฟล์ไม่สำเร็จ');
      showToast('❌ อ่านไฟล์วิดีโอบางไฟล์ไม่สำเร็จ');
      btnBatchQueue.disabled = false;
      btnBatchQueue.innerHTML = '📋 ลงคิวทั้งหมด <span id="batchQueueCount"></span>';
      return;
    }

    const template = buildJobTemplate();
    const userCaption = captionInput?.value?.trim() || '';
    const userBasketCta = basketCta?.value?.trim() || '';

    // Determine product(s) for each video
    const productsToUse = selectedProducts.length > 0 ? selectedProducts : (selectedProduct ? [selectedProduct] : []);

    // Get current queue directly from storage
    const storageData = await chrome.storage.local.get('phimbot_queue');
    const queue = storageData.phimbot_queue || [];
    let addedCount = 0;

    for (let i = 0; i < videoFiles.length; i++) {
      const v = videoFiles[i];
      btnBatchQueue.innerHTML = `<span class="spinner"></span> ${i + 1}/${videoFiles.length} กำลังเตรียมคิว...`;
      addProgressItem('info', `📝 คลิป ${i + 1}/${videoFiles.length}: ${v.name}`);

      // Assign product (round-robin if multiple products)
      const productForVideo = productsToUse.length > 0 ? productsToUse[i % productsToUse.length] : null;
      const productName = productForVideo?.name || $('#aiProductName')?.value || '';
      const productDesc = $('#aiProductDesc')?.value || '';

      const videoCta = userBasketCta || DYNAMIC_CTA_LIST[i % DYNAMIC_CTA_LIST.length];
      const basketDisabled = toggleBasket?.checked || false;

      // Staggered schedule with variation (OmniPost v1.2.7 style)
      let scheduledAt;
      if (template.scheduledAtBase) {
        const baseMs = template.scheduledAtBase + (i * (template.scheduleInterval || 15) * 60000);
        const variation = template.scheduleVariation || 0;
        let variationMs = 0;
        if (variation > 0 && i > 0) {
          const seed = (i * 2654435761) >>> 0;
          const normalized = (seed % (2 * variation * 10 + 1)) / 10 - variation;
          variationMs = normalized * 60000;
        }
        const target = new Date(baseMs + variationMs);
        target.setMinutes(Math.round(target.getMinutes() / 5) * 5);
        target.setSeconds(0, 0);
        if (target.getTime() < Date.now() + 15 * 60000) {
          target.setTime(Date.now() + 16 * 60000);
          target.setMinutes(Math.round(target.getMinutes() / 5) * 5);
        }
        scheduledAt = target.toISOString();
      }

      const job = {
        ...template,
        caption: userCaption || '',
        hashtags: template.hashtags || [],
        basketCta: videoCta,
        videoDataUrl: v.dataUrl,
        filename: v.name,
        attachProduct: !basketDisabled && !!productForVideo,
        productId: productForVideo?.productId || '',
        productImage: productForVideo?.imageUrl || (productForVideo?.images && (typeof productForVideo.images[0] === 'string' ? productForVideo.images[0] : productForVideo.images[0]?.url)) || productForVideo?.image || '',
        thumbnail: v.thumbnail || '',
        id: `phim_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${i}`,
        status: 'pending',
        createdAt: new Date().toISOString(),
        error: null,
        // ★ Lazy AI: generate caption per-row in background.js (saves tokens!)
        needsAiCaption: !userCaption,
        aiContext: {
          productName,
          productDesc,
          videoIndex: i,
          totalVideos: videoFiles.length,
        },
      };
      if (scheduledAt) job.scheduledAt = scheduledAt;

      queue.push(job);
      addedCount++;
      addProgressItem('ok', `📋 คลิป ${i + 1} ลงคิวแล้ว (AI จะคิดแคปชั่นตอนเริ่มโพสต์)`);
    }

    // Save directly to chrome.storage.local
    await chrome.storage.local.set({ phimbot_queue: queue });

    const pName = productsToUse.length > 1 ? `${productsToUse.length} สินค้า` : (productsToUse[0]?.name || 'ไม่ระบุ');
    addProgressItem('ok', `🎉 ลงคิวเสร็จ! ${addedCount} คลิป (${pName})`);
    showToast(`✅ ลงคิวแล้ว ${addedCount} คลิป (${pName})`);
    videoFiles = [];
    updateVideoUI();

    // Switch to queue tab
    $$('.tab-btn').forEach((b) => b.classList.remove('active'));
    $$('.tab-content').forEach((c) => c.classList.remove('active'));
    $('[data-tab="queue"]').classList.add('active');
    $('#tab-queue').classList.add('active');
    await refreshQueue();

    // Auto-start queue removed as requested so the user can review before starting
    

    btnBatchQueue.disabled = false;
    btnBatchQueue.innerHTML = '📋 ลงคิวทั้งหมด <span id="batchQueueCount"></span>';
  });

  /* ─── Post Now ──────────────────────────────────────────── */
  btnPostNow?.addEventListener('click', async () => {
    if (!videoFiles.length) { showToast('กรุณาเลือกคลิปก่อน'); return; }
    const first = videoFiles[0];
    if (!first.dataUrl) {
      btnPostNow.disabled = true;
      btnPostNow.innerHTML = `<span class="spinner"></span> กำลังอ่านไฟล์วิดีโอ...`;
      await ensureVideoDataUrl(first);
    }

    btnPostNow.disabled = true;
    btnPostNow.innerHTML = `<span class="spinner"></span> กำลังโพสต์...`;
    progressSection?.classList.remove('hidden');
    if (progressLog) progressLog.innerHTML = '';
    addProgressItem('info', 'เริ่มโพสต์...');

    const template = buildJobTemplate();
    const userBasketCta = basketCta?.value?.trim() || '';
    const videoCta = userBasketCta || DYNAMIC_CTA_LIST[Math.floor(Math.random() * DYNAMIC_CTA_LIST.length)];
    const job = {
      ...template,
      basketCta: videoCta,
      videoDataUrl: first.dataUrl,
      filename: first.name,
      id: `phim_${Date.now()}`
    };
    // ─── Add scheduledAt if publish mode is scheduled ───
    if (template.publishMode === 'scheduled') {
      const d = $('#scheduleDate')?.value;
      const tm = $('#scheduleTime')?.value;
      if (d && tm) {
        const target = new Date(`${d}T${tm}`);
        if (target.getTime() > Date.now() + 15 * 60000) {
          target.setSeconds(0, 0);
          job.scheduledAt = target.toISOString();
        } else {
          showToast('❌ เวลาต้องห่างจากตอนนี้อย่างน้อย 15 นาที');
          btnPostNow.disabled = false;
          btnPostNow.innerHTML = '▶ โพสต์เลย (ตัวแรก)';
          return;
        }
      } else {
        showToast('❌ กรุณาเลือกวันที่และเวลาก่อน');
        btnPostNow.disabled = false;
        btnPostNow.innerHTML = '▶ โพสต์เลย (ตัวแรก)';
        return;
      }
    }
    const result = await sendMsg('PHIMBOT_POST_NOW', job);

    if (result.ok) { addProgressItem('ok', 'โพสต์สำเร็จ!'); showToast('✅ โพสต์สำเร็จ!'); }
    else { addProgressItem('error', `ผิดพลาด: ${result.reason || 'Unknown'}`); showToast('❌ โพสต์ไม่สำเร็จ'); }

    btnPostNow.disabled = false;
    btnPostNow.innerHTML = '▶ โพสต์เลย (ตัวแรก)';
  });

  // Listen for progress + countdown
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'PHIMBOT_TIKTOK_POST_PROGRESS') addProgressItem(msg.payload?.level || 'info', `[${msg.payload?.step}] ${msg.payload?.message}`);
    if (msg?.type === 'PHIMBOT_QUEUE_PROGRESS') {
      refreshQueue();
      if (msg.payload?.message) {
        const labelEl = document.querySelector('#statTotal');
        if (labelEl) labelEl.parentElement.querySelector('.stat-label').textContent = msg.payload.message;
      }
    }
    if (msg?.type === 'PHIMBOT_COUNTDOWN') {
      const sec = msg.payload?.remaining || 0;
      const total = msg.payload?.total || 0;
      const countdownEl = document.querySelector('#queueCountdown');
      if (sec > 0) {
        const mins = Math.floor(sec / 60);
        const secs = sec % 60;
        const timeStr = mins > 0 ? `${mins}:${String(secs).padStart(2, '0')}` : `${secs}`;
        if (countdownEl) { countdownEl.classList.remove('hidden'); countdownEl.innerHTML = `⏱ แถวถัดไปใน <strong>${timeStr}</strong> วินาที (สุ่ม ${total} วินาที)`; }
      } else {
        if (countdownEl) { countdownEl.classList.add('hidden'); countdownEl.innerHTML = ''; }
      }
    }
  });

  /* ═══ AI Buttons ═══ */
  const btnAiCaption = $('#btnAiCaption');
  const btnAiImprove = $('#btnAiImprove');
  const btnAiHashtags = $('#btnAiHashtags');

  btnAiCaption?.addEventListener('click', async () => {
    const name = $('#aiProductName')?.value || selectedProduct?.name || '';
    const desc = $('#aiProductDesc')?.value || '';
    const price = $('#aiProductPrice')?.value || '';
    if (!name && !desc) { showToast('กรุณากรอกชื่อหรือคำอธิบายสินค้าก่อน'); return; }
    btnAiCaption.disabled = true; btnAiCaption.innerHTML = `<span class="spinner"></span> AI กำลังทำงาน...`;
    const prompt = [name ? `ชื่อสินค้า: ${name}` : '', desc ? `คำอธิบาย: ${desc}` : '', price ? `ราคา: ${price}` : ''].filter(Boolean).join('\n');
    const r = await sendMsg('PHIMBOT_AI_GENERATE', { action: 'generate_caption', prompt: `สร้างแคปชั่น TikTok:\n${prompt}` });
    if (r.success) { captionInput.value = r.text; showToast('✅ สร้างแคปชั่นสำเร็จ!'); } else showToast(`❌ ${r.error}`);
    btnAiCaption.disabled = false; btnAiCaption.innerHTML = '🤖 สร้างแคปชั่น AI';
  });

  btnAiImprove?.addEventListener('click', async () => {
    if (!captionInput?.value?.trim()) { showToast('กรุณากรอกแคปชั่นก่อน'); return; }
    btnAiImprove.disabled = true; btnAiImprove.innerHTML = `<span class="spinner"></span> AI กำลังทำงาน...`;
    const style = $('#aiStyle')?.value || 'engaging';
    const r = await sendMsg('PHIMBOT_AI_GENERATE', { action: 'improve_content', prompt: `ปรับปรุงข้อความนี้แบบ ${style}:\n\n${captionInput.value}` });
    if (r.success) { captionInput.value = r.text; showToast('✅ ปรับปรุงสำเร็จ!'); } else showToast(`❌ ${r.error}`);
    btnAiImprove.disabled = false; btnAiImprove.innerHTML = '✨ ปรับปรุง';
  });

  btnAiHashtags?.addEventListener('click', async () => {
    if (!captionInput?.value?.trim()) { showToast('กรุณากรอกแคปชั่นก่อน'); return; }
    btnAiHashtags.disabled = true; btnAiHashtags.innerHTML = `<span class="spinner"></span> AI กำลังทำงาน...`;
    const r = await sendMsg('PHIMBOT_AI_GENERATE', { action: 'suggest_hashtags', prompt: `แนะนำ 5 แฮชแท็ก TikTok:\n\n${captionInput.value}` });
    if (r.success) { hashtagsInput.value = r.text.split('\n').map((t) => t.replace(/^[#\-\d.\s]+/, '').trim()).filter(Boolean).slice(0, 5).join(' '); showToast('✅ แนะนำแฮชแท็กสำเร็จ!'); } else showToast(`❌ ${r.error}`);
    btnAiHashtags.disabled = false; btnAiHashtags.innerHTML = '🏷️ แนะนำ AI';
  });

  /* ═══ QUEUE TAB ═══ */
  const queueCount = $('#queueCount');
  const queueList = $('#queueList');
  const queueDelayMin = $('#queueDelayMin');
  const queueDelayMax = $('#queueDelayMax');
  const toggleRandomDelay = $('#toggleRandomDelay');

  async function refreshQueue() {
    const storageData = await chrome.storage.local.get(['phimbot_queue', 'phimbot_products', 'phimbot_saved_catalog', 'phimbot_media_vault']);
    const queue = storageData.phimbot_queue || [];
    if (queueCount) queueCount.textContent = queue.length;

    // Update stats
    const total = queue.length;
    const success = queue.filter(q => q.status === 'done').length;
    const failed = queue.filter(q => q.status === 'error').length;
    const statTotal = $('#statTotal'); if (statTotal) statTotal.textContent = total;
    const statSuccess = $('#statSuccess'); if (statSuccess) statSuccess.textContent = success;
    const statFailed = $('#statFailed'); if (statFailed) statFailed.textContent = failed;

    const btnRetryFailedQueue = $('#btnRetryFailedQueue');
    const failedQueueCount = $('#failedQueueCount');
    if (btnRetryFailedQueue) {
      if (failed > 0) {
        btnRetryFailedQueue.classList.remove('hidden');
        if (failedQueueCount) failedQueueCount.textContent = failed;
      } else {
        btnRetryFailedQueue.classList.add('hidden');
      }
    }

    if (!queue.length) { queueList.innerHTML = `<tr><td colspan="5" class="queue-empty">ยังไม่มีรายการในคิว</td></tr>`; return; }

    const allProducts = [
      ...(storageData.phimbot_products || []),
      ...(storageData.phimbot_saved_catalog || []),
      ...(window.__phimbotFactoryProducts || [])
    ];
    const vaultItems = storageData.phimbot_media_vault || [];

    let queueUpdated = false;

    queueList.innerHTML = queue.map((item, idx) => {
      // 1. Resolve Product Image (if missing)
      let prodImage = item.productImage || '';
      if (!prodImage && (item.productId || item.caption)) {
        const pMatch = allProducts.find(p =>
          (item.productId && (p.productId === item.productId || p.id === item.productId || p.offerId === item.productId))
          || (item.caption && ((p.name && item.caption.includes(p.name)) || (p.title && item.caption.includes(p.title))))
        );
        if (pMatch) {
          prodImage = pMatch.imageUrl || (pMatch.images && (typeof pMatch.images[0] === 'string' ? pMatch.images[0] : pMatch.images[0]?.url)) || pMatch.image || '';
        }
        if (!prodImage && vaultItems.length > 0) {
          const vMatch = vaultItems.find(v =>
            (item.productId && v.productId === item.productId)
            || (item.caption && v.productName && item.caption.includes(v.productName))
          );
          if (vMatch) prodImage = vMatch.productImage || '';
        }
        if (prodImage) {
          item.productImage = prodImage;
          queueUpdated = true;
        }
      }

      // 2. Resolve Clip Thumbnail
      let clipThumb = '';
      if (item.thumbnail) {
        clipThumb = `<img class="q-thumb" src="${item.thumbnail}" alt="" style="object-fit:cover;">`;
      } else if (item.videoDataUrl) {
        clipThumb = `<video class="q-thumb" src="${item.videoDataUrl}#t=0.1" muted playsinline preload="metadata" style="object-fit:cover;pointer-events:none;"></video>`;
      } else {
        const vMatch = vaultItems.find(v => (item.productId && v.productId === item.productId) || (item.caption && v.productName && item.caption.includes(v.productName)));
        if (vMatch && vMatch.thumbnail) {
          clipThumb = `<img class="q-thumb" src="${vMatch.thumbnail}" alt="" style="object-fit:cover;">`;
        } else {
          clipThumb = `<div class="q-thumb" style="display:flex;align-items:center;justify-content:center;font-size:14px;">🎬</div>`;
        }
      }

      const prodThumb = prodImage
        ? `<img class="q-thumb" src="${prodImage}" alt="" style="object-fit:cover;">`
        : (item.productId ? `<div class="q-thumb" style="display:flex;align-items:center;justify-content:center;font-size:14px;">📦</div>` : '–');
      const platformBadge = item.platform === 'shopee'
        ? `<span style="background:#ee4d2d; color:#fff; font-size:9px; padding:1px 5px; border-radius:3px; margin-right:4px; font-weight:bold;">Shopee</span>`
        : (item.platform === 'fb-reels'
          ? `<span style="background:#1877f2; color:#fff; font-size:9px; padding:1px 5px; border-radius:3px; margin-right:4px; font-weight:bold;">Reels</span>`
          : `<span style="background:#ff0050; color:#fff; font-size:9px; padding:1px 5px; border-radius:3px; margin-right:4px; font-weight:bold;">TikTok</span>`);
      const captionText = item.caption ? item.caption.slice(0, 80) : (item.filename || 'Video');
      const caption = platformBadge + captionText;
      const statusClass = item.status || 'pending';
      const statusText = statusLabel(item.status, item.error);
      const isFailed = item.status === 'error';
      const retryBtn = isFailed
        ? `<button class="btn-icon queue-retry" data-id="${item.id}" title="ลองโพสต์แถวนี้ใหม่" style="font-size:15px; color:#15803d; margin-right:6px; cursor:pointer;">🔄</button>`
        : '';
      const statusBadge = isFailed
        ? `<span class="q-status ${statusClass} queue-retry-badge" data-id="${item.id}" style="cursor:pointer;" title="คลิกเพื่อลองโพสต์แถวนี้ใหม่">${statusText} 🔄</span>`
        : `<span class="q-status ${statusClass}">${statusText}</span>`;

      return `<tr>
        <td style="color:#666;">${idx + 1}</td>
        <td>${clipThumb}</td>
        <td>${prodThumb}</td>
        <td><div class="q-caption">${caption}</div>${statusBadge}</td>
        <td style="white-space:nowrap;">${retryBtn}<button class="btn-icon queue-remove" data-id="${item.id}" title="ลบ" style="font-size:14px;">✕</button></td>
      </tr>`;
    }).join('');

    if (queueUpdated) {
      chrome.storage.local.set({ phimbot_queue: queue }).catch(() => {});
    }

    // Remove item
    queueList.querySelectorAll('.queue-remove').forEach((btn) => btn.addEventListener('click', async () => {
      const qData = await chrome.storage.local.get('phimbot_queue');
      const filtered = (qData.phimbot_queue || []).filter((it) => it.id !== btn.dataset.id);
      await chrome.storage.local.set({ phimbot_queue: filtered });
      refreshQueue();
    }));

    // Retry single failed item
    queueList.querySelectorAll('.queue-retry, .queue-retry-badge').forEach((btn) => btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (!id) return;
      btn.style.opacity = '0.5';
      const r = await sendMsg('PHIMBOT_RETRY_QUEUE_ITEM', { id });
      if (r?.success) {
        showToast('🔄 รีเซ็ตแถวกลับเข้าคิวแล้ว! กด ▶ Run เพื่อเริ่มโพสต์');
      } else {
        showToast(`❌ ${r?.error || 'ไม่สามารถรีเซ็ตได้'}`);
      }
      refreshQueue();
    }));

    const st = await sendMsg('PHIMBOT_GET_QUEUE_STATUS');
    const startBtn = $('#btnStartQueue'); const pauseBtn = $('#btnPauseQueue');
    const isRunning = Boolean(st?.isRunning && !st?.isPaused);
    if (startBtn) startBtn.disabled = isRunning;
    if (pauseBtn) pauseBtn.disabled = !isRunning;
  }

  function statusLabel(status, error) {
    switch (status) { case 'pending': return '⏳ รอ'; case 'processing': return '🔄 กำลังโพสต์'; case 'done': return '✅ สำเร็จ'; case 'error': return `❌ ${error || 'ผิดพลาด'}`; default: return status || '⏳ รอ'; }
  }

  // Run button → open delay modal
  $('#btnStartQueue')?.addEventListener('click', () => {
    const modal = $('#delayModal');
    if (modal) modal.classList.remove('hidden');
  });

  // Confirm run inside modal → save delay + start queue + close modal
  $('#btnConfirmRun')?.addEventListener('click', async () => {
    const useDelay = toggleRandomDelay?.checked;
    if (useDelay) {
      await sendMsg('PHIMBOT_SAVE_QUEUE_DELAY', { delayMin: parseInt(queueDelayMin?.value) || 100, delayMax: parseInt(queueDelayMax?.value) || 200 });
    } else {
      await sendMsg('PHIMBOT_SAVE_QUEUE_DELAY', { delayMin: 0, delayMax: 0 });
    }
    const r = await sendMsg('PHIMBOT_START_QUEUE');
    if (r.success) showToast('🚀 เริ่มรันคิวแล้ว!');
    const modal = $('#delayModal');
    if (modal) modal.classList.add('hidden');
    refreshQueue();
  });

  // Cancel button → close modal
  $('#btnCancelRun')?.addEventListener('click', () => {
    const modal = $('#delayModal');
    if (modal) modal.classList.add('hidden');
  });
  $('#delayModal')?.addEventListener('click', (e) => {
    if (e.target === $('#delayModal')) $('#delayModal').classList.add('hidden');
  });

  $('#btnPauseQueue')?.addEventListener('click', async () => {
    const pauseBtn = $('#btnPauseQueue');
    if (pauseBtn) { pauseBtn.disabled = true; pauseBtn.innerHTML = '⏳ กำลังหยุด...'; }
    const r = await sendMsg('PHIMBOT_PAUSE_QUEUE');
    showToast(r.success ? '⏸️ หยุดคิวและปิดแท็บโพสต์แล้ว' : (r.error || 'หยุดคิวไม่สำเร็จ'));
    if (pauseBtn) { pauseBtn.disabled = false; pauseBtn.innerHTML = '⏸ Pause'; }
    refreshQueue();
  });
  $('#btnClearQueue')?.addEventListener('click', async () => { if (!confirm('ต้องการล้างคิวทั้งหมด?')) return; await sendMsg('PHIMBOT_CLEAR_QUEUE'); refreshQueue(); showToast('🗑️ ล้างคิวแล้ว'); });

  $('#btnRetryFailedQueue')?.addEventListener('click', async () => {
    const btn = $('#btnRetryFailedQueue');
    if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
    const r = await sendMsg('PHIMBOT_RETRY_ALL_FAILED');
    if (r?.success) {
      showToast(`🔄 รีเซ็ตแถวที่พลาด ${r.count || 0} รายการกลับเข้าคิวแล้ว!`);
    } else {
      showToast(`❌ ${r?.error || 'ไม่สามารถรีเซ็ตได้'}`);
    }
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
    refreshQueue();
  });

  $('#statFailedBox')?.addEventListener('click', async () => {
    const qData = await chrome.storage.local.get('phimbot_queue');
    const failedList = (qData.phimbot_queue || []).filter(i => i.status === 'error');
    if (failedList.length === 0) return;
    if (confirm(`ต้องการรีเซ็ตแถวที่ไม่สำเร็จทั้งหมด (${failedList.length} รายการ) กลับเข้าคิวเพื่อลองโพสต์ใหม่หรือไม่?`)) {
      const r = await sendMsg('PHIMBOT_RETRY_ALL_FAILED');
      if (r?.success) {
        showToast(`🔄 รีเซ็ต ${r.count} รายการกลับเข้าคิวแล้ว!`);
        refreshQueue();
      }
    }
  });

  // Toggle delay visibility
  toggleRandomDelay?.addEventListener('change', () => {
    const delaySection = $('#delaySettings');
    if (delaySection) delaySection.style.display = toggleRandomDelay.checked ? 'flex' : 'none';
  });


  /* ═══ FB REELS TAB ═══ */
  const fbReelsFileInput = $('#fbReelsFileInput');
  const fbReelsUploadZone = $('#fbReelsUploadZone');
  const fbReelsFileList = $('#fbReelsFileList');
  const fbReelsCaption = $('#fbReelsCaption');
  const fbReelsHashtags = $('#fbReelsHashtags');
  const fbReelsScheduleMode = $('#fbReelsScheduleMode');
  const fbReelsScheduleFields = $('#fbReelsScheduleFields');
  const fbReelsProgress = $('#fbReelsProgress');
  const fbReelsProgressLog = $('#fbReelsProgressLog');
  let fbReelsFiles = [];

  function addFbProgressItem(type, text) {
    if (!fbReelsProgressLog) return;
    const div = document.createElement('div');
    div.className = 'progress-item ' + type;
    div.textContent = text;
    fbReelsProgressLog.appendChild(div);
    fbReelsProgressLog.scrollTop = fbReelsProgressLog.scrollHeight;
  }

  fbReelsUploadZone?.addEventListener('click', () => fbReelsFileInput?.click());
  fbReelsUploadZone?.addEventListener('dragover', (e) => { e.preventDefault(); fbReelsUploadZone.classList.add('drag-over'); });
  fbReelsUploadZone?.addEventListener('dragleave', () => fbReelsUploadZone.classList.remove('drag-over'));
  fbReelsUploadZone?.addEventListener('drop', (e) => {
    e.preventDefault(); fbReelsUploadZone.classList.remove('drag-over');
    handleFbFiles(Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('video/')));
  });
  fbReelsFileInput?.addEventListener('change', () => handleFbFiles(Array.from(fbReelsFileInput.files)));

  function generateVideoThumb(file) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      const url = URL.createObjectURL(file);
      video.src = url;
      video.onloadeddata = () => {
        video.currentTime = Math.min(1, video.duration / 2);
      };
      video.onseeked = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 120; canvas.height = 68;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const thumb = canvas.toDataURL('image/jpeg', 0.6);
        const dur = Math.floor(video.duration);
        const durStr = Math.floor(dur / 60) + ':' + String(dur % 60).padStart(2, '0');
        URL.revokeObjectURL(url);
        resolve({ thumb, duration: durStr });
      };
      video.onerror = () => { URL.revokeObjectURL(url); resolve({ thumb: '', duration: '?' }); };
    });
  }

  async function handleFbFiles(files) {
    fbReelsFiles = files;
    if (!fbReelsFileList) return;
    fbReelsFileList.innerHTML = files.map((f, i) => '<div class="file-item"><span class="spinner" style="width:14px;height:14px;"></span> ' + f.name + '</div>').join('');
    // Generate thumbnails async
    const items = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const { thumb, duration } = await generateVideoThumb(f);
      items.push('<div class="file-item-thumb"><div class="file-thumb-wrap">' +
        (thumb ? '<img src="' + thumb + '" class="file-thumb-img">' : '<div class="file-thumb-placeholder">🎬</div>') +
        '<span class="file-thumb-dur">' + duration + '</span></div>' +
        '<div class="file-thumb-info"><div class="file-thumb-name">' + (i + 1) + '. ' + f.name + '</div>' +
        '<div class="file-thumb-size">' + (f.size / 1048576).toFixed(1) + ' MB</div></div></div>');
    }
    fbReelsFileList.innerHTML = items.join('');
  }

  fbReelsScheduleMode?.addEventListener('change', () => {
    const isSched = fbReelsScheduleMode.value === 'scheduled';
    if (fbReelsScheduleFields) fbReelsScheduleFields.classList.toggle('hidden', !isSched);
    if (isSched) {
      const fbDate = $('#fbReelsDate'); const fbTime = $('#fbReelsTime');
      const now = new Date();
      now.setMinutes(now.getMinutes() + 30);
      if (fbDate) fbDate.value = now.toISOString().split('T')[0];
      if (fbTime) fbTime.value = now.toTimeString().slice(0, 5);
    }
  });

  // Batch interval (+/- 5 min)
  let fbBatchIntervalMin = 30;
  const fbIntervalValue = $('#fbIntervalValue');
  function updateIntervalDisplay() {
    if (fbIntervalValue) fbIntervalValue.textContent = fbBatchIntervalMin + ' นาที';
  }
  $('#fbIntervalMinus')?.addEventListener('click', () => {
    fbBatchIntervalMin = Math.max(5, fbBatchIntervalMin - 5);
    updateIntervalDisplay();
  });
  $('#fbIntervalPlus')?.addEventListener('click', () => {
    fbBatchIntervalMin = Math.min(1440, fbBatchIntervalMin + 5);
    updateIntervalDisplay();
  });

  $('#btnFbAiCaption')?.addEventListener('click', async () => {
    const btn = $('#btnFbAiCaption');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> AI...';
    let prodContext = '';
    if (typeof fbReelsSelectedProduct !== 'undefined' && fbReelsSelectedProduct) {
      prodContext = ` เกี่ยวกับสินค้า: ${fbReelsSelectedProduct.title || ''} ราคา: ${fbReelsSelectedProduct.price || ''}`;
    }
    const prompt = 'สร้างแคปชั่น Facebook Reels สั้นๆ ดึงดูดคนดู 1-3 ประโยค ใส่อิโมจิ ห้ามใส่ # ห้ามพูดถึงราคา' + prodContext;
    const r = await sendMsg('PHIMBOT_AI_GENERATE', { action: 'generate_caption', prompt });
    if (r.success && fbReelsCaption) fbReelsCaption.value = r.text || r.caption || '';
    else showToast('❌ ' + (r.error || 'AI ไม่ตอบ'));
    btn.disabled = false; btn.innerHTML = '🤖 AI คิดแคปชั่น';
  });

  $('#btnFbAiHashtags')?.addEventListener('click', async () => {
    const btn = $('#btnFbAiHashtags');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> AI...';
    const context = fbReelsCaption?.value || 'วิดีโอ Facebook Reels';
    const r = await sendMsg('PHIMBOT_AI_GENERATE', { action: 'suggest_hashtags', prompt: 'แนะนำ 5 แฮชแท็ก Facebook สำหรับ:\n' + context });
    if (r.success && fbReelsHashtags) {
      const tags = (r.text || '').split('\n').map(t => t.replace(/^[\-\d.\s]+/, '').trim()).filter(Boolean).slice(0, 5).map(t => t.startsWith('#') ? t : '#' + t);
      fbReelsHashtags.value = tags.join(' ');
    } else showToast('❌ ' + (r.error || 'AI ไม่ตอบ'));
    btn.disabled = false; btn.innerHTML = '🏷️ AI แฮชแท็ก';
  });

  async function readFbVideoDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const detectedType = file.type || (/\.mp4$/i.test(file.name) ? 'video/mp4' : 'video/mp4');
      reader.onload = () => resolve({ name: file.name, type: detectedType, dataUrl: reader.result });
      reader.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ: ' + file.name));
      reader.readAsDataURL(file);
    });
  }

  
function formatReelsCaption({ caption = '', affiliateUrl = '', hashtags = '' } = {}) {
  let rawCaption = String(caption || '').trim();
  let rawHashtags = String(hashtags || '').trim();

  // 1. Extract existing URL from caption
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

  // 4. Build 3 distinct clean sections with blank lines
  const sections = [];
  if (body) sections.push(body);
  if (finalUrl) sections.push('🛒 พิกัดสินค้า: ' + finalUrl);
  if (allHashtags.length) sections.push(allHashtags.join(' '));

  return sections.join('\n\n');
}

  $('#btnFbReelsPost')?.addEventListener('click', async () => {
    if (!fbReelsFiles.length) { showToast('กรุณาเลือกคลิปก่อน'); return; }
    const btn = $('#btnFbReelsPost');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> กำลังโพสต์...';
    fbReelsProgress?.classList.remove('hidden');
    if (fbReelsProgressLog) fbReelsProgressLog.innerHTML = '';
    addFbProgressItem('info', '📤 กำลังอ่านไฟล์วิดีโอ...');
    try {
      const media = await readFbVideoDataUrl(fbReelsFiles[0]);
      addFbProgressItem('ok', '✅ อ่านไฟล์สำเร็จ: ' + media.name);
      let caption = fbReelsCaption?.value?.trim() || '';
      let hashtags = fbReelsHashtags?.value?.trim() || '';
      let affLink = (typeof fbReelsSelectedProduct !== 'undefined' && fbReelsSelectedProduct) ? (fbReelsSelectedProduct.affiliateUrl || '') : '';
      if ((!affLink || affLink.includes('affiliate.shopee.co.th')) && fbReelsSelectedProduct?.offerId) {
        addFbProgressItem('info', '⏳ กำลังดึงลิงก์ย่อ Shopee (s.shopee.co.th)...');
        try {
          const lr = await sendMsg('PHIMBOT_GET_AFFILIATE_LINK', {
            item: {
              offerId: fbReelsSelectedProduct.offerId,
              title: fbReelsSelectedProduct.title,
              offerUrl: fbReelsSelectedProduct.offerUrl
            }
          });
          if (lr?.ok && lr?.affiliateUrl) {
            affLink = lr.affiliateUrl;
            fbReelsSelectedProduct.affiliateUrl = affLink;
            addFbProgressItem('ok', '✅ ได้ลิงก์ Shopee: ' + affLink);
          }
        } catch (e) {
          console.warn('Auto fetch link failed:', e);
        }
      }

      // ─── Auto AI Caption if blank (เว้นว่างให้ AI คิดให้) ───
      if (!caption) {
        addFbProgressItem('info', '🤖 กำลังให้ AI ช่วยคิดแคปชั่นดึงดูดคนดู...');
        let prodContext = '';
        if (typeof fbReelsSelectedProduct !== 'undefined' && fbReelsSelectedProduct) {
          prodContext = ` เกี่ยวกับสินค้า: ${fbReelsSelectedProduct.title || ''} ราคา: ${fbReelsSelectedProduct.price || ''}`;
        }
        const prompt = 'สร้างแคปชั่น Facebook Reels สั้นๆ ดึงดูดคนดู 1-3 ประโยค ใส่อิโมจิ ห้ามใส่ # ห้ามพูดถึงราคา' + prodContext;
        try {
          const r = await sendMsg('PHIMBOT_AI_GENERATE', { action: 'generate_caption', prompt });
          if (r.success && (r.text || r.caption)) {
            caption = (r.text || r.caption).trim();
            if (fbReelsCaption) fbReelsCaption.value = caption;
            addFbProgressItem('ok', '✅ AI คิดแคปชั่น: "' + caption.slice(0, 35) + '..."');
          }
        } catch (e) {
          console.warn('Auto AI caption error:', e);
        }
        if (!caption && fbReelsSelectedProduct?.title) {
          caption = `🔥 แนะนำ ${fbReelsSelectedProduct.title}\nสินค้าคุณภาพดี คุ้มค่าคุ้มราคา สายช้อปห้ามพลาด! ✨`;
          if (fbReelsCaption) fbReelsCaption.value = caption;
          addFbProgressItem('ok', '✅ ตั้งแคปชั่นจากชื่อสินค้าเรียบร้อย');
        }
      }

      // ─── Auto AI Hashtags if blank (เว้นว่างให้ AI แนะนำ) ───
      if (!hashtags) {
        addFbProgressItem('info', '🏷️ กำลังสร้างแฮชแท็กที่เหมาะสม...');
        const context = caption || (fbReelsSelectedProduct?.title) || 'วิดีโอ Facebook Reels';
        try {
          const r = await sendMsg('PHIMBOT_AI_GENERATE', { action: 'suggest_hashtags', prompt: 'แนะนำ 5 แฮชแท็ก Facebook สำหรับ:\n' + context });
          if (r.success && r.text) {
            const tags = r.text.split('\n').map(t => t.replace(/^[\-\d.\s]+/, '').trim()).filter(Boolean).slice(0, 5).map(t => t.startsWith('#') ? t : '#' + t);
            hashtags = tags.join(' ');
            if (fbReelsHashtags) fbReelsHashtags.value = hashtags;
          }
        } catch (e) {
          console.warn('Auto AI hashtags error:', e);
        }
        if (!hashtags) {
          hashtags = '#reels #reelsfb #ของดีบอกต่อ #ช้อปปี้ถูกชัวร์ #รีวิว';
          if (fbReelsHashtags) fbReelsHashtags.value = hashtags;
        }
      }

      // Formats into 3 clean, well-spaced sections: Story -> Link -> Hashtags
      const fullCaption = formatReelsCaption({ caption, affiliateUrl: affLink, hashtags });

      const isScheduled = fbReelsScheduleMode?.value === 'scheduled';
      let schedDate = $('#fbReelsDate')?.value || '';
      let schedTime = $('#fbReelsTime')?.value || '';

      if (isScheduled) {
        if (!schedDate || !schedTime) {
          showToast('⚠️ กรุณาระบุวันที่และเวลาที่ต้องการกำหนดเวลา');
          btn.disabled = false; btn.innerHTML = '🚀 โพสต์ Reels';
          return;
        }
        const targetDateTime = new Date(`${schedDate}T${schedTime}`);
        const now = new Date();
        const diffMin = Math.round((targetDateTime.getTime() - now.getTime()) / 60000);

        if (diffMin < 20) {
          const adjusted = new Date(now.getTime() + 25 * 60000);
          schedDate = adjusted.toISOString().split('T')[0];
          schedTime = adjusted.toTimeString().slice(0, 5);
          if ($('#fbReelsDate')) $('#fbReelsDate').value = schedDate;
          if ($('#fbReelsTime')) $('#fbReelsTime').value = schedTime;
          showToast(`⚠️ FB ต้องตั้งเวลาล่วงหน้า 20 นาทีขึ้นไป — ปรับเป็น ${schedTime} ให้แล้ว`);
          addFbProgressItem('info', `⚠️ เวลาเดิมกระชั้นเกินไป (< 20 นาที) ปรับเป็น ${schedDate} ${schedTime} ให้อัตโนมัติ`);
        }
      }

      const config = {
        mediaFiles: [media],
        caption: fullCaption,
        aiLabelEnabled: $('#fbReelsAiLabel')?.checked ?? true,
        scheduleMode: isScheduled ? 'scheduled' : 'now',
        scheduleDate: schedDate,
        scheduleTime: schedTime,
        closeTabWhenDone: $('#fbReelsCloseTab')?.checked ?? true,
      };
      addFbProgressItem('info', '🚀 กำลังส่งไปยัง Facebook Reels...');
      const result = await sendMsg('PHIMBOT_POST_FB_REELS', config);
      if (result.ok) {
        const successMsg = isScheduled ? '🎉 กำหนดเวลา Reels สำเร็จเรียบร้อย!' : '🎉 โพสต์ Reels สำเร็จ!';
        addFbProgressItem('ok', successMsg);
        showToast(isScheduled ? '✅ กำหนดเวลา FB Reels สำเร็จ!' : '✅ โพสต์ FB Reels สำเร็จ!');
      } else {
        const failReason = result.reason || 'ผิดพลาด';
        addFbProgressItem('error', '❌ โพสต์ไม่สำเร็จ: ' + failReason);
        showToast('❌ โพสต์ไม่สำเร็จ: ' + failReason, true);
      }
    } catch (e) {
      addFbProgressItem('error', '❌ ' + e.message);
    }
    btn.disabled = false; btn.innerHTML = '🚀 โพสต์ Reels';
  });

  $('#btnFbReelsBatchQueue')?.addEventListener('click', async () => {
    if (!fbReelsFiles.length) { showToast('กรุณาเลือกคลิปก่อน'); return; }
    const btn = $('#btnFbReelsBatchQueue');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> กำลังเตรียม...';
    fbReelsProgress?.classList.remove('hidden');
    if (fbReelsProgressLog) fbReelsProgressLog.innerHTML = '';
    try {
      const storageData = await chrome.storage.local.get('phimbot_queue');
      const queue = storageData.phimbot_queue || [];
      let addedCount = 0;
      const isScheduled = fbReelsScheduleMode?.value === 'scheduled';
      let baseDate = $('#fbReelsDate')?.value || '';
      let baseTime = $('#fbReelsTime')?.value || '';

      if (isScheduled) {
        if (!baseDate || !baseTime) {
          showToast('⚠️ กรุณาระบุวันที่และเวลาเริ่มต้นกำหนดเวลา');
          btn.disabled = false; btn.innerHTML = '📋 ลงคิวทั้งหมด';
          return;
        }
        let base = new Date(`${baseDate}T${baseTime}`);
        const now = new Date();
        if ((base.getTime() - now.getTime()) < 20 * 60000) {
          base = new Date(now.getTime() + 25 * 60000);
          baseDate = base.toISOString().split('T')[0];
          baseTime = base.toTimeString().slice(0, 5);
          if ($('#fbReelsDate')) $('#fbReelsDate').value = baseDate;
          if ($('#fbReelsTime')) $('#fbReelsTime').value = baseTime;
          addFbProgressItem('info', `⚠️ ปรับเวลาเริ่มต้นคิวเป็น ${baseDate} ${baseTime} เพื่อให้ล่วงหน้าอย่างน้อย 20 นาที`);
        }
      }

      for (let i = 0; i < fbReelsFiles.length; i++) {
        const media = await readFbVideoDataUrl(fbReelsFiles[i]);
        const caption = fbReelsCaption?.value?.trim() || '';
        const hashtags = fbReelsHashtags?.value?.trim() || '';

        // Calculate schedule time for this clip
        let jobDate = baseDate;
        let jobTime = baseTime;
        if (isScheduled && baseDate && baseTime && i > 0) {
          const base = new Date(baseDate + 'T' + baseTime);
          const offset = new Date(base.getTime() + (i * fbBatchIntervalMin * 60000));
          jobDate = offset.getFullYear() + '-' + String(offset.getMonth() + 1).padStart(2, '0') + '-' + String(offset.getDate()).padStart(2, '0');
          jobTime = String(offset.getHours()).padStart(2, '0') + ':' + String(offset.getMinutes()).padStart(2, '0');
        }

        let affLinkBatch = (typeof fbReelsSelectedProduct !== 'undefined' && fbReelsSelectedProduct) ? (fbReelsSelectedProduct.affiliateUrl || '') : '';
        const wantUniqueAi = $('#fbReelsUniqueAiCaption')?.checked !== false;
        const batchFullCaption = formatReelsCaption({ caption, affiliateUrl: affLinkBatch, hashtags });
        const job = {
          platform: 'fb-reels',
          caption: wantUniqueAi ? '' : batchFullCaption,
          hashtags: hashtags ? hashtags.split(/\s+/).filter(Boolean) : [],
          videoDataUrl: media.dataUrl, filename: media.name,
          aiLabelEnabled: $('#fbReelsAiLabel')?.checked ?? true,
          scheduleMode: isScheduled ? 'scheduled' : 'now',
          scheduleDate: jobDate, scheduleTime: jobTime,
          closeTabWhenDone: $('#fbReelsCloseTab')?.checked ?? true,
          needsAiCaption: wantUniqueAi || !caption,
          productImage: (typeof fbReelsSelectedProduct !== 'undefined' && fbReelsSelectedProduct) ? (fbReelsSelectedProduct.imageUrl || fbReelsSelectedProduct.images?.[0]?.url || fbReelsSelectedProduct.images?.[0] || '') : '',
          productId: (typeof fbReelsSelectedProduct !== 'undefined' && fbReelsSelectedProduct) ? (fbReelsSelectedProduct.offerId || '') : '',
          aiContext: {
            productName: (typeof fbReelsSelectedProduct !== 'undefined' && fbReelsSelectedProduct?.title) || '',
            productDesc: (typeof fbReelsSelectedProduct !== 'undefined' && fbReelsSelectedProduct) ? ('ราคา ฿' + (fbReelsSelectedProduct.price||'') + (fbReelsSelectedProduct.commissionRate ? ' คอมฯ ' + fbReelsSelectedProduct.commissionRate + '%' : '')) : '',
            affiliateUrl: (typeof fbReelsSelectedProduct !== 'undefined' && fbReelsSelectedProduct?.affiliateUrl && !fbReelsSelectedProduct.affiliateUrl.includes('affiliate.shopee.co.th')) ? fbReelsSelectedProduct.affiliateUrl : '',
            videoIndex: i, totalVideos: fbReelsFiles.length,
            userCaption: caption
          },
          id: 'phim_fb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '_' + i,
          status: 'pending', createdAt: new Date().toISOString(), error: null,
        };
        queue.push(job);
        addedCount++;
        const timeLabel = isScheduled ? ' ⏰ ' + jobDate + ' ' + jobTime : '';
        addFbProgressItem('ok', '📋 คลิป ' + (i + 1) + ' ลงคิวแล้ว' + timeLabel);
      }
      await chrome.storage.local.set({ phimbot_queue: queue });
      addFbProgressItem('ok', '🎉 ลงคิวเสร็จ! ' + addedCount + ' คลิป FB Reels');
      showToast('✅ ลงคิวแล้ว ' + addedCount + ' คลิป FB Reels');
      refreshQueue();
    } catch (e) { addFbProgressItem('error', '❌ ' + e.message); }
    btn.disabled = false; btn.innerHTML = '📋 ลงคิวทั้งหมด';
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'PHIMBOT_FB_REELS_PROGRESS') addFbProgressItem(msg.payload?.level || 'info', msg.payload?.message || '');
  });

  /* ═══ SHOPEE VIDEO TAB ═══ */
  const shopeeVideoFileInput = $('#shopeeVideoFileInput');
  const shopeeVideoUploadZone = $('#shopeeVideoUploadZone');
  const shopeeVideoFileList = $('#shopeeVideoFileList');
  const shopeeVideoCaption = $('#shopeeVideoCaption');
  const shopeeVideoHashtags = $('#shopeeVideoHashtags');
  const shopeeVideoScheduleMode = $('#shopeeVideoScheduleMode');
  const shopeeVideoScheduleFields = $('#shopeeVideoScheduleFields');
  const shopeeVideoProgress = $('#shopeeVideoProgress');
  const shopeeVideoProgressLog = $('#shopeeVideoProgressLog');
  let shopeeVideoFiles = [];

  function addShopeeProgressItem(type, text) {
    if (!shopeeVideoProgressLog) return;
    const div = document.createElement('div');
    div.className = 'progress-item ' + type;
    div.textContent = text;
    shopeeVideoProgressLog.appendChild(div);
    shopeeVideoProgressLog.scrollTop = shopeeVideoProgressLog.scrollHeight;
  }

  shopeeVideoUploadZone?.addEventListener('click', () => shopeeVideoFileInput?.click());
  shopeeVideoUploadZone?.addEventListener('dragover', (e) => { e.preventDefault(); shopeeVideoUploadZone.classList.add('drag-over'); });
  shopeeVideoUploadZone?.addEventListener('dragleave', () => shopeeVideoUploadZone.classList.remove('drag-over'));
  shopeeVideoUploadZone?.addEventListener('drop', (e) => {
    e.preventDefault(); shopeeVideoUploadZone.classList.remove('drag-over');
    handleShopeeFiles(Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('video/')));
  });
  shopeeVideoFileInput?.addEventListener('change', () => handleShopeeFiles(Array.from(shopeeVideoFileInput.files)));

  async function handleShopeeFiles(files) {
    shopeeVideoFiles = files;
    if (!shopeeVideoFileList) return;
    shopeeVideoFileList.innerHTML = files.map((f, i) => '<div class="file-item"><span class="spinner" style="width:14px;height:14px;"></span> ' + f.name + '</div>').join('');
    const items = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const { thumb, duration } = await generateVideoThumb(f);
      items.push('<div class="file-item-thumb"><div class="file-thumb-wrap">' +
        (thumb ? '<img src="' + thumb + '" class="file-thumb-img">' : '<div class="file-thumb-placeholder">🎬</div>') +
        '<span class="file-thumb-dur">' + duration + '</span></div>' +
        '<div class="file-thumb-info"><div class="file-thumb-name">' + (i + 1) + '. ' + f.name + '</div>' +
        '<div class="file-thumb-size">' + (f.size / 1048576).toFixed(1) + ' MB</div></div></div>');
    }
    shopeeVideoFileList.innerHTML = items.join('');
  }

  shopeeVideoScheduleMode?.addEventListener('change', () => {
    const isSched = shopeeVideoScheduleMode.value === 'scheduled';
    if (shopeeVideoScheduleFields) shopeeVideoScheduleFields.classList.toggle('hidden', !isSched);
    if (isSched) {
      const spDate = $('#shopeeVideoDate'); const spTime = $('#shopeeVideoTime');
      const now = new Date();
      now.setMinutes(now.getMinutes() + 15);
      if (spDate) spDate.value = now.toISOString().split('T')[0];
      if (spTime) spTime.value = now.toTimeString().slice(0, 5);
    }
  });

  // Batch interval (+/- 5 min)
  let shopeeBatchIntervalMin = 15;
  const shopeeIntervalValue = $('#shopeeIntervalValue');
  function updateShopeeIntervalDisplay() {
    if (shopeeIntervalValue) shopeeIntervalValue.textContent = shopeeBatchIntervalMin + ' นาที';
  }
  $('#shopeeIntervalMinus')?.addEventListener('click', () => {
    shopeeBatchIntervalMin = Math.max(5, shopeeBatchIntervalMin - 5);
    updateShopeeIntervalDisplay();
  });
  $('#shopeeIntervalPlus')?.addEventListener('click', () => {
    shopeeBatchIntervalMin = Math.min(1440, shopeeBatchIntervalMin + 5);
    updateShopeeIntervalDisplay();
  });

  // Device check & Target device selector
  async function updateShopeeTargetDeviceOptions() {
    const select = $('#shopeeVideoTargetDevice');
    const badge = $('#shopeeDeviceBadge');
    if (!select) return;

    let devices = [];
    let activeDeviceId = '';
    try {
      const stored = await chrome.storage.local.get('asu-clip-sync-settings');
      const s = stored && stored['asu-clip-sync-settings'];
      if (s && Array.isArray(s.devices) && s.devices.length > 0) {
        devices = s.devices;
        activeDeviceId = s.activeDeviceId || devices[0]?.id;
      } else if (s && s.pairCode) {
        devices = [{ id: 'dev_1', name: 'เครื่องที่ 1 (OPPO)', pairCode: s.pairCode, isDefault: true }];
        activeDeviceId = 'dev_1';
      } else {
        devices = [{ id: 'dev_1', name: 'เครื่องที่ 1 (OPPO)', pairCode: 'RC6N-WPVW-M34P', isDefault: true }];
        activeDeviceId = 'dev_1';
      }
    } catch (_) {
      devices = [{ id: 'dev_1', name: 'เครื่องที่ 1 (OPPO)', pairCode: 'RC6N-WPVW-M34P', isDefault: true }];
      activeDeviceId = 'dev_1';
    }

    if (badge) {
      badge.textContent = devices.length > 0 ? `${devices.length} เครื่อง` : '0 เครื่อง';
    }

    if (!devices.length) {
      select.innerHTML = '<option value="">(ยังไม่มีเครื่อง — ไปเพิ่มเครื่องในแท็บตั้งค่า)</option>';
      return;
    }

    const prevVal = select.value;
    let html = '';
    if (devices.length > 1) {
      html += '<option value="all">📢 ส่งทุกเครื่องพร้อมกัน (Broadcast All)</option>';
    }
    devices.forEach((dev) => {
      const isDef = dev.isDefault || dev.id === activeDeviceId;
      html += `<option value="${dev.id}" ${isDef ? 'selected' : ''}>📱 ${dev.name} (${dev.pairCode})</option>`;
    });

    select.innerHTML = html;
    if (prevVal && Array.from(select.options).some(o => o.value === prevVal)) {
      select.value = prevVal;
    }
  }

  async function checkShopeeDeviceConnection() {
    const dot = $('#shopeeDeviceDot');
    const txt = $('#shopeeDeviceText');
    if (txt) txt.textContent = 'มือถือ: กำลังตรวจสอบการเชื่อมต่อ...';

    await updateShopeeTargetDeviceOptions();

    // 1. Check PUP PAP POST Bridge (Port 17881 / USB ADB Forward / Local Endpoint)
    try {
      const storedBridge = await chrome.storage.local.get(['phimbot_bridge_endpoint']);
      const ep = (storedBridge.phimbot_bridge_endpoint || 'http://127.0.0.1:17881').replace(/\/+$/, '');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`${ep}/health`, { signal: controller.signal });
      clearTimeout(timer);
      const data = await res.json();
      if (data && (data.ok || data.status === 'ready')) {
        if (dot) dot.style.background = '#22c55e';
        if (txt) txt.textContent = `⚡ PUP PAP POST Bridge: ออนไลน์ (${ep.replace(/^https?:\/\//, '')}) พร้อมรับคลิป ✓`;
        return true;
      }
    } catch (_) {}

    // 2. Check Cloud Sync (ไร้สาย ไม่ต้องเสียบสาย - ค่าเริ่มต้นหลัก)
    try {
      const stored = await chrome.storage.local.get('asu-clip-sync-settings');
      const s = stored && stored['asu-clip-sync-settings'];
      const devices = (s && Array.isArray(s.devices) && s.devices.length > 0)
        ? s.devices
        : [{ id: 'dev_1', name: 'เครื่องที่ 1 (OPPO)', pairCode: (s?.pairCode || 'RC6N-WPVW-M34P'), isDefault: true }];
      if (devices.length > 0) {
        if (dot) dot.style.background = '#22c55e';
        if (txt) {
          if (devices.length === 1) {
            txt.textContent = `☁️ โหมดไร้สาย (Cloud Sync): พร้อมใช้งาน • ${devices[0].name || 'เครื่อง 1'} (${devices[0].pairCode})`;
          } else {
            txt.textContent = `☁️ โหมดไร้สาย: มี ${devices.length} เครื่องพร้อมส่ง (เลือกเครื่องด้านล่างได้)`;
          }
        }
        return true;
      }
    } catch (_) {}

    // 3. Check PC Bridge USB (Port 17882)
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch('http://127.0.0.1:17882/health', { signal: controller.signal });
      clearTimeout(timer);
      const data = await res.json();
      if (data && data.ok && data.adbDeviceConnected) {
        if (dot) dot.style.background = '#22c55e';
        if (txt) txt.textContent = '🔌 โหมดสาย USB (PC Bridge): เชื่อมต่อแล้ว พร้อมโพสต์ ✓';
        return true;
      }
    } catch (_) {}

    if (dot) dot.style.background = '#f59e0b';
    if (txt) txt.textContent = 'มือถือ: กรุณาเปิดแอป หรือใส่ Bridge Token / รหัสไร้สาย ในแท็บ "ตั้งค่า"';
    return false;
  }

  $('#btnCheckShopeeDevice')?.addEventListener('click', checkShopeeDeviceConnection);
  checkShopeeDeviceConnection();

  window.addEventListener('asu-devices-changed', () => {
    updateShopeeTargetDeviceOptions();
    checkShopeeDeviceConnection();
  });

  function isShopeeAffShortLink(url) {
    if (!url || typeof url !== 'string') return false;
    const clean = url.trim();
    return /^https:\/\/(s\.shopee\.co\.th|shope\.ee)\//i.test(clean) && !clean.includes('affiliate.shopee.co.th');
  }

  function clampShopeeCaption(caption, hashtags) {
    let tagStr = '';
    if (Array.isArray(hashtags)) {
      tagStr = hashtags.map(h => h.startsWith('#') ? h : '#' + h).join(' ');
    } else if (typeof hashtags === 'string') {
      tagStr = hashtags.trim();
    }
    if (!tagStr) tagStr = '#ShopeeTH #รีวิว #ของดีบอกต่อ';

    // Shopee maximum allowed is 150 characters total. Keep <= 140 for absolute safety.
    const maxCapLen = Math.max(15, 140 - tagStr.length - 1);
    let cap = (caption || '').trim();
    if (cap.length > maxCapLen) {
      cap = cap.slice(0, Math.max(0, maxCapLen - 3)).trim() + '...';
    }
    return { caption: cap, hashtags: tagStr };
  }

  // AI Caption for Shopee Video
  $('#btnShopeeAiCaption')?.addEventListener('click', async () => {
    const btn = $('#btnShopeeAiCaption');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> AI...';
    let prodContext = '';
    if (typeof shopeeVideoSelectedProduct !== 'undefined' && shopeeVideoSelectedProduct) {
      prodContext = ` เกี่ยวกับสินค้า Shopee: ${shopeeVideoSelectedProduct.title || ''} ราคา: ${shopeeVideoSelectedProduct.price || ''}`;
    }
    const prompt = 'สร้างแคปชั่น Shopee Video สั้นๆ ป้ายยา ดึงดูดคนกดซื้อในตะกร้า 1 ประโยคสั้นๆ ความยาวไม่เกิน 65 ตัวอักษร ใส่อิโมจิ ห้ามใส่ # ห้ามใส่ลิงก์' + prodContext;
    const r = await sendMsg('PHIMBOT_AI_GENERATE', { action: 'generate_caption', prompt });
    if (r.success && shopeeVideoCaption) {
      let cap = (r.text || r.caption || '').replace(/#\S+/g, '').trim();
      if (cap.length > 70) cap = cap.slice(0, 67) + '...';
      shopeeVideoCaption.value = cap;
    }
    else showToast('❌ ' + (r.error || 'AI ไม่ตอบ'));
    btn.disabled = false; btn.innerHTML = '🤖 AI คิดแคปชั่น';
  });

  // AI Hashtags for Shopee Video
  $('#btnShopeeAiHashtags')?.addEventListener('click', async () => {
    const btn = $('#btnShopeeAiHashtags');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> AI...';
    const context = shopeeVideoCaption?.value || (shopeeVideoSelectedProduct?.title) || 'วิดีโอ Shopee Video ป้ายยา';
    const r = await sendMsg('PHIMBOT_AI_GENERATE', { action: 'suggest_hashtags', prompt: 'แนะนำ 2-3 แฮชแท็ก Shopee สั้นๆ สำหรับ:\n' + context });
    if (r.success && shopeeVideoHashtags) {
      const tags = (r.text || '').split('\n').map(t => t.replace(/^[\-\d.\s]+/, '').trim()).filter(Boolean).slice(0, 3).map(t => t.startsWith('#') ? t : '#' + t);
      shopeeVideoHashtags.value = tags.join(' ');
    } else showToast('❌ ' + (r.error || 'AI ไม่ตอบ'));
    btn.disabled = false; btn.innerHTML = '🏷️ AI แฮชแท็ก';
  });

  // Helper to read video file as dataUrl
  async function readShopeeVideoDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, type: file.type, dataUrl: reader.result });
      reader.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ: ' + file.name));
      reader.readAsDataURL(file);
    });
  }

  // Direct Post Button (Shopee Video)
  $('#btnShopeeVideoPost')?.addEventListener('click', async () => {
    if (!shopeeVideoFiles.length) { showToast('กรุณาเลือกคลิปก่อน'); return; }
    const btn = $('#btnShopeeVideoPost');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> กำลังส่ง...';
    shopeeVideoProgress?.classList.remove('hidden');
    if (shopeeVideoProgressLog) shopeeVideoProgressLog.innerHTML = '';
    addShopeeProgressItem('info', '📤 กำลังอ่านไฟล์วิดีโอ Shopee...');
    try {
      const media = await readShopeeVideoDataUrl(shopeeVideoFiles[0]);
      addShopeeProgressItem('ok', '✅ อ่านไฟล์สำเร็จ: ' + media.name);
      let caption = shopeeVideoCaption?.value?.trim() || '';
      let hashtags = shopeeVideoHashtags?.value?.trim() || '';

      const product = (typeof shopeeVideoSelectedProduct !== 'undefined' && shopeeVideoSelectedProduct) ? shopeeVideoSelectedProduct : null;
      if (!product) {
        showToast('⚠️ กรุณาเลือกสินค้า Shopee ก่อนโพสต์ (จำเป็นสำหรับการปักตะกร้า)', true);
        addShopeeProgressItem('error', '⚠️ ยังไม่ได้เลือกสินค้า Shopee สำหรับปักตะกร้า — กรุณาคลิก "เลือกสินค้าจากคลัง"');
        btn.disabled = false; btn.innerHTML = '🚀 ส่งโพสต์ Shopee';
        return;
      }

      // Ensure affiliate shortlink (s.shopee.co.th)
      let affUrl = product.affiliateUrl || '';
      if (!isShopeeAffShortLink(affUrl)) {
        addShopeeProgressItem('info', '⏳ กำลังดึง affiliate shortlink (s.shopee.co.th)...');
        try {
          const linkRes = await sendMsg('PHIMBOT_GET_AFFILIATE_LINK', {
            item: product,
            url: product.offerUrl || product.productUrl || product.url || ''
          });
          if (linkRes && linkRes.ok && isShopeeAffShortLink(linkRes.affiliateUrl)) {
            affUrl = linkRes.affiliateUrl;
            product.affiliateUrl = affUrl;
            shopeeVideoSelectedProduct.affiliateUrl = affUrl;
            if (window.phimbotSaveToCatalog) window.phimbotSaveToCatalog(product);
            addShopeeProgressItem('ok', '✅ ได้ affiliate link: ' + affUrl);
          }
        } catch (_) {}
      }

      if (!isShopeeAffShortLink(affUrl)) {
        showToast('⚠️ ลิงก์สินค้ายังไม่ใช่ affiliate shortlink (s.shopee.co.th) กรุณาล็อกอิน affiliate.shopee.co.th', true);
        addShopeeProgressItem('error', '❌ ลิงก์สินค้ายังไม่ใช่ shortlink (ต้องเป็น https://s.shopee.co.th/...) กรุณาล็อกอิน affiliate.shopee.co.th ก่อนโพสต์');
        btn.disabled = false; btn.innerHTML = '🚀 ส่งโพสต์ Shopee';
        return;
      }

      if (!caption && product?.title) {
        const shortTitle = product.title.length > 25 ? product.title.slice(0, 22) + '...' : product.title;
        caption = `🔥 ป้ายยา ${shortTitle} คุ้มค่าเกินราคา กดสั่งในตะกร้าได้เลยจ้า! ✨`;
      }
      if (!hashtags) {
        hashtags = '#ShopeeTH #รีวิว #ของดีบอกต่อ';
      }

      // Enforce strict character limit (<= 140 characters total so Shopee never truncates hashtags)
      const clamped = clampShopeeCaption(caption, hashtags);
      caption = clamped.caption;
      hashtags = clamped.hashtags;

      const targetDevice = $('#shopeeVideoTargetDevice')?.value || '';
      addShopeeProgressItem('info', `🚀 กำลังส่งเข้าแอปมือถือ (แคปชั่น+แท็ก ${caption.length + 1 + hashtags.length} ตัวอักษร)...`);
      const result = await sendMsg('PHIMBOT_POST_SHOPEE_VIDEO', {
        mediaFiles: [media],
        caption: caption,
        hashtags: hashtags,
        product: { ...product, affiliateUrl: affUrl },
        productUrl: affUrl,
        autoStart: true,
        targetDevice: targetDevice
      });

      if (result && result.ok) {
        addShopeeProgressItem('ok', '🎉 ส่งเข้าคิวโพสต์บนมือถือสำเร็จเรียบร้อย!');
        showToast('✅ ส่งโพสต์ Shopee สำเร็จ!');
      } else {
        const failReason = result?.reason || result?.error || 'ผิดพลาด';
        addShopeeProgressItem('error', '❌ ส่งไม่สำเร็จ: ' + failReason);
        showToast('❌ ส่งไม่สำเร็จ: ' + failReason, true);
      }
    } catch (e) {
      addShopeeProgressItem('error', '❌ ' + e.message);
    }
    btn.disabled = false; btn.innerHTML = '🚀 ส่งโพสต์ Shopee';
  });

  // Batch Queue Button (Shopee Video)
  $('#btnShopeeVideoBatchQueue')?.addEventListener('click', async () => {
    if (!shopeeVideoFiles.length) { showToast('กรุณาเลือกคลิปก่อน'); return; }
    const btn = $('#btnShopeeVideoBatchQueue');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> กำลังเตรียม...';
    shopeeVideoProgress?.classList.remove('hidden');
    if (shopeeVideoProgressLog) shopeeVideoProgressLog.innerHTML = '';
    try {
      const storageData = await chrome.storage.local.get('phimbot_queue');
      const queue = storageData.phimbot_queue || [];
      let addedCount = 0;
      const isScheduled = shopeeVideoScheduleMode?.value === 'scheduled';
      let baseDate = $('#shopeeVideoDate')?.value || '';
      let baseTime = $('#shopeeVideoTime')?.value || '';

      if (isScheduled && (!baseDate || !baseTime)) {
        showToast('⚠️ กรุณาระบุวันที่และเวลาเริ่มต้นกำหนดเวลา');
        btn.disabled = false; btn.innerHTML = '📋 ลงคิวทั้งหมด';
        return;
      }

      const product = (typeof shopeeVideoSelectedProduct !== 'undefined' && shopeeVideoSelectedProduct) ? shopeeVideoSelectedProduct : null;
      if (!product) {
        showToast('⚠️ กรุณาเลือกสินค้า Shopee ก่อนลงคิว (จำเป็นสำหรับการปักตะกร้า)', true);
        addShopeeProgressItem('error', '⚠️ ยังไม่ได้เลือกสินค้า Shopee สำหรับปักตะกร้า — กรุณาคลิก "เลือกสินค้าจากคลัง"');
        btn.disabled = false; btn.innerHTML = '📋 ลงคิวทั้งหมด';
        return;
      }

      // Ensure affiliate shortlink before queueing
      let affUrl = product.affiliateUrl || '';
      if (!isShopeeAffShortLink(affUrl)) {
        addShopeeProgressItem('info', '⏳ กำลังดึง affiliate shortlink (s.shopee.co.th)...');
        try {
          const linkRes = await sendMsg('PHIMBOT_GET_AFFILIATE_LINK', {
            item: product,
            url: product.offerUrl || product.productUrl || product.url || ''
          });
          if (linkRes && linkRes.ok && isShopeeAffShortLink(linkRes.affiliateUrl)) {
            affUrl = linkRes.affiliateUrl;
            product.affiliateUrl = affUrl;
            shopeeVideoSelectedProduct.affiliateUrl = affUrl;
            if (window.phimbotSaveToCatalog) window.phimbotSaveToCatalog(product);
            addShopeeProgressItem('ok', '✅ ได้ affiliate link: ' + affUrl);
          }
        } catch (_) {}
      }

      if (!isShopeeAffShortLink(affUrl)) {
        showToast('⚠️ ลิงก์สินค้ายังไม่ใช่ affiliate shortlink (s.shopee.co.th) กรุณาล็อกอิน affiliate.shopee.co.th', true);
        addShopeeProgressItem('error', '❌ ลิงก์สินค้ายังไม่ใช่ shortlink (ต้องเป็น https://s.shopee.co.th/...) กรุณาล็อกอิน affiliate.shopee.co.th ก่อนลงคิว');
        btn.disabled = false; btn.innerHTML = '📋 ลงคิวทั้งหมด';
        return;
      }

      const wantUniqueAi = $('#shopeeVideoUniqueAiCaption')?.checked !== false;
      const targetDevice = $('#shopeeVideoTargetDevice')?.value || '';

      for (let i = 0; i < shopeeVideoFiles.length; i++) {
        const media = await readShopeeVideoDataUrl(shopeeVideoFiles[i]);
        let caption = shopeeVideoCaption?.value?.trim() || '';
        let hashtags = shopeeVideoHashtags?.value?.trim() || '';

        // Calculate schedule time for this clip
        let jobDate = baseDate;
        let jobTime = baseTime;
        if (isScheduled && baseDate && baseTime && i > 0) {
          const base = new Date(baseDate + 'T' + baseTime);
          const offset = new Date(base.getTime() + (i * shopeeBatchIntervalMin * 60000));
          jobDate = offset.getFullYear() + '-' + String(offset.getMonth() + 1).padStart(2, '0') + '-' + String(offset.getDate()).padStart(2, '0');
          jobTime = String(offset.getHours()).padStart(2, '0') + ':' + String(offset.getMinutes()).padStart(2, '0');
        }

        let finalCaption = wantUniqueAi ? '' : caption;
        let finalTags = hashtags ? hashtags.split(/\s+/).filter(Boolean) : ['#ShopeeTH', '#รีวิว', '#ของดีบอกต่อ'];
        if (!wantUniqueAi && finalCaption) {
          const clamped = clampShopeeCaption(finalCaption, finalTags);
          finalCaption = clamped.caption;
          finalTags = clamped.hashtags.split(/\s+/).filter(Boolean);
        }

        const job = {
          platform: 'shopee',
          caption: finalCaption,
          hashtags: finalTags,
          videoDataUrl: media.dataUrl,
          filename: media.name,
          targetDevice: targetDevice,
          scheduleMode: isScheduled ? 'scheduled' : 'now',
          scheduleDate: jobDate,
          scheduleTime: jobTime,
          needsAiCaption: wantUniqueAi || !caption,
          productImage: product ? (product.imageUrl || product.images?.[0]?.url || product.images?.[0] || '') : '',
          productId: product ? (product.offerId || product.productId || '') : '',
          productTitle: product?.title || '',
          productUrl: affUrl,
          aiContext: {
            productName: product?.title || '',
            productDesc: product ? ('ราคา ฿' + (product.price || '') + (product.commissionRate ? ' คอมฯ ' + product.commissionRate + '%' : '')) : '',
            affiliateUrl: affUrl,
            videoIndex: i,
            totalVideos: shopeeVideoFiles.length,
            userCaption: caption
          },
          id: 'phim_shopee_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '_' + i,
          status: 'pending',
          createdAt: new Date().toISOString(),
          error: null
        };
        queue.push(job);
        addedCount++;
        const timeLabel = isScheduled ? ' ⏰ ' + jobDate + ' ' + jobTime : '';
        addShopeeProgressItem('ok', '📋 คลิป ' + (i + 1) + ' ลงคิวแล้ว' + timeLabel);
      }
      await chrome.storage.local.set({ phimbot_queue: queue });
      addShopeeProgressItem('ok', '🎉 ลงคิวเสร็จ! ' + addedCount + ' คลิป Shopee Video');
      showToast('✅ ลงคิวแล้ว ' + addedCount + ' คลิป Shopee');
      refreshQueue();
    } catch (e) { addShopeeProgressItem('error', '❌ ' + e.message); }
    btn.disabled = false; btn.innerHTML = '📋 ลงคิวทั้งหมด';
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'PHIMBOT_SHOPEE_VIDEO_PROGRESS') addShopeeProgressItem(msg.payload?.level || 'info', msg.payload?.message || '');
  });

  /* ═══ SHOPEE PRODUCT FETCHER (SINGLE) ═══ */
  const shopeeUrlInput = $('#shopeeUrlInput');
  const btnShopeeGo = $('#btnShopeeGo');
  const shopeeStatus = $('#shopeeStatus');
  const shopeeProductCard = $('#shopeeProductCard');
  let currentShopeeProduct = null;

  function showShopeeStatus(msg, type = 'info') {
    if (!shopeeStatus) return;
    shopeeStatus.className = 'status-msg ' + type;
    shopeeStatus.textContent = msg;
    shopeeStatus.classList.remove('hidden');
  }
  function hideShopeeStatus() { shopeeStatus?.classList.add('hidden'); }

  function formatPrice(p) {
    if (!p) return '';
    const num = parseFloat(String(p).replace(/,/g, ''));
    if (isNaN(num)) return String(p);
    if (num > 100000) return '฿' + (num / 100000).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    return '฿' + num.toLocaleString('th-TH');
  }

  function displayShopeeProduct(data) {
    currentShopeeProduct = data;
    if (!shopeeProductCard) return;
    shopeeProductCard.classList.remove('hidden');

    const nameEl = $('#shopeeProductName');
    if (nameEl) nameEl.textContent = data.title || 'ไม่มีชื่อ';
    const priceEl = $('#shopeeProductPrice');
    if (priceEl) priceEl.textContent = formatPrice(data.price);
    const origPrice = $('#shopeeProductOrigPrice');
    if (origPrice) {
      if (data.originalPrice && data.originalPrice !== data.price) {
        origPrice.textContent = formatPrice(data.originalPrice);
        origPrice.style.display = '';
      } else { origPrice.style.display = 'none'; }
    }

    const discBadge = $('#shopeeProductDiscount');
    if (discBadge) {
      if (data.discount) {
        discBadge.textContent = '-' + data.discount + '%';
        discBadge.style.display = '';
      } else { discBadge.style.display = 'none'; }
    }

    const ratEl = $('#shopeeProductRating');
    if (ratEl) ratEl.textContent = data.rating ? '⭐ ' + data.rating : '';
    const soldEl = $('#shopeeProductSold');
    if (soldEl) soldEl.textContent = data.sold ? 'ขายแล้ว ' + data.sold : '';

    const mainImg = $('#shopeeProductImg');
    if (mainImg) {
      if (data.images && data.images.length) {
        const imgSrc = typeof data.images[0] === 'string' ? data.images[0] : (data.images[0]?.url || '');
        mainImg.src = imgSrc.startsWith('//') ? 'https:' + imgSrc : imgSrc;
      } else { mainImg.src = ''; }
    }

    const gallery = $('#shopeeGallery');
    if (gallery) {
      gallery.innerHTML = '';
      if (data.images && data.images.length > 1) {
        data.images.slice(0, 8).forEach((img) => {
          const src = typeof img === 'string' ? img : (img?.url || '');
          const fullSrc = src.startsWith('//') ? 'https:' + src : src;
          const imgEl = document.createElement('img');
          imgEl.src = fullSrc;
          imgEl.style.cssText = 'width:56px; height:56px; object-fit:cover; border-radius:6px; cursor:pointer; border:2px solid transparent;';
          imgEl.addEventListener('click', () => { if (mainImg) mainImg.src = fullSrc; });
          gallery.appendChild(imgEl);
        });
      }
    }

    const affEl = $('#shopeeAffLink');
    if (affEl) {
      if (data.affiliateUrl) {
        affEl.innerHTML = '🔗 <a href="' + data.affiliateUrl + '" target="_blank" style="color:#1877f2;">' + data.affiliateUrl + '</a>';
      } else { affEl.textContent = ''; }
    }
  }

  async function fetchShopeeProduct() {
    const url = shopeeUrlInput?.value?.trim();
    if (!url) { showShopeeStatus('กรุณาวาง URL สินค้า Shopee', 'warning'); return; }
    showShopeeStatus('กำลังดึงข้อมูล...', 'info');
    if (btnShopeeGo) { btnShopeeGo.disabled = true; btnShopeeGo.textContent = '⏳'; }

    try {
      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'PHIMBOT_FETCH_SHOPEE', url }, (resp) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(resp);
        });
      });

      if (result?.ok) {
        hideShopeeStatus();
        displayShopeeProduct(result);
        loadShopeeHistory();
      } else {
        showShopeeStatus('❌ ' + (result?.reason || 'ดึงไม่สำเร็จ'), 'error');
      }
    } catch (err) {
      showShopeeStatus('❌ ' + err.message, 'error');
    }
    if (btnShopeeGo) { btnShopeeGo.disabled = false; btnShopeeGo.textContent = 'ดึง'; }
  }

  btnShopeeGo?.addEventListener('click', fetchShopeeProduct);
  shopeeUrlInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchShopeeProduct(); });

  $('#btnShopeeCopyLink')?.addEventListener('click', () => {
    if (currentShopeeProduct?.affiliateUrl) {
      navigator.clipboard.writeText(currentShopeeProduct.affiliateUrl);
      showToast('✅ คัดลอกแล้ว!');
    }
  });

  $('#btnShopeeAiCaption')?.addEventListener('click', async () => {
    if (!currentShopeeProduct) return;
    const btn = $('#btnShopeeAiCaption');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> AI...';
    const p = currentShopeeProduct;
    const prompt = 'สร้างแคปชั่นขายสินค้า Shopee ภาษาไทย 2-3 ประโยค ดึงดูดใจ ใส่อิโมจิ ใส่ 5 # ที่เกี่ยวข้อง\nชื่อสินค้า: ' + p.title + '\nราคา: ' + formatPrice(p.price) + (p.discount ? ' (ลด ' + p.discount + '%)' : '') + (p.sold ? '\nขายแล้ว: ' + p.sold : '') + '\nลิงก์: ' + (p.affiliateUrl || '');
    try {
      const resp = await sendMsg('PHIMBOT_AI_GENERATE', { action: 'generate_caption', prompt });
      const captionText = resp?.text || resp?.caption || '';
      if (captionText) {
        $('#shopeeAiCaption')?.classList.remove('hidden');
        const capRes = $('#shopeeCaptionResult');
        if (capRes) capRes.value = captionText;
      }
    } catch (e) { showToast('❌ AI: ' + e.message); }
    btn.disabled = false; btn.innerHTML = '📝 สร้างแคปชั่น AI';
  });

  $('#btnShopeeUseReels')?.addEventListener('click', () => {
    if (!currentShopeeProduct) return;
    const p = currentShopeeProduct;
    document.querySelector('[data-tab="fb-reels"]')?.click();
    window.dispatchEvent(new CustomEvent('phimbot-select-product', { detail: {
      offerId: p.offerId || '',
      title: p.title || '',
      price: p.price || 0,
      imageUrl: (p.images && p.images.length) ? (typeof p.images[0] === 'string' ? p.images[0] : (p.images[0]?.url || '')) : '',
      affiliateUrl: p.affiliateUrl || '',
      offerUrl: p.offerUrl || p.productUrl || p.url || '',
      commissionRate: p.commissionRate || 0,
      sold: p.sold || 0,
    }}));
    showToast('✅ เลือกสินค้าไปที่ FB Reels แล้ว!');
  });

  $('#btnShopeeUseShopeeVideoSingle')?.addEventListener('click', () => {
    if (!currentShopeeProduct) return;
    const p = currentShopeeProduct;
    document.querySelector('[data-tab="shopee-video"]')?.click();
    window.dispatchEvent(new CustomEvent('phimbot-select-shopee-video-product', { detail: {
      offerId: p.offerId || '',
      title: p.title || '',
      price: p.price || 0,
      imageUrl: (p.images && p.images.length) ? (typeof p.images[0] === 'string' ? p.images[0] : (p.images[0]?.url || '')) : '',
      affiliateUrl: p.affiliateUrl || '',
      offerUrl: p.offerUrl || p.productUrl || p.url || '',
      commissionRate: p.commissionRate || 0,
      sold: p.sold || 0,
    }}));
    showToast('✅ เลือกสินค้าไปที่ Shopee VDO แล้ว!');
  });

  // Load history
  async function loadShopeeHistory() {
    try {
      const stored = await chrome.storage.local.get('phimbot_shopee_history');
      const history = stored.phimbot_shopee_history || [];
      const container = $('#shopeeHistory');
      if (!container) return;
      if (!history.length) { container.textContent = 'ยังไม่มีประวัติ'; return; }
      container.innerHTML = history.slice(0, 5).map(h =>
        '<div style="padding:4px 0; border-bottom:1px solid #1a1a2e; cursor:pointer;" data-url="' + h.url + '">' +
        '<div style="color:#e0e0e0; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + (h.title || h.url) + '</div>' +
        '<div style="color:#ff6740; font-size:10px;">' + formatPrice(h.price) + '</div>' +
        '</div>'
      ).join('');
      container.querySelectorAll('[data-url]').forEach(el => {
        el.addEventListener('click', () => {
          shopeeUrlInput.value = el.dataset.url;
          fetchShopeeProduct();
        });
      });
    } catch (_) {}
  }
  // TikTok Login Button
  $('#btnTikTokLogin')?.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://www.tiktok.com/login?redirect_url=https%3A%2F%2Fwww.tiktok.com%2Ftiktokstudio%2Fupload', active: true });
  });

  // Shopee Affiliate Login Button
  $('#btnShopeeLogin')?.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://affiliate.shopee.co.th/offer/product_offer', active: true });
  });


  /* ═══ SETTINGS TAB ═══ */
  const settingsApiKey = $('#settingsApiKey');
  const settingsApiProvider = $('#settingsApiProvider');
  const settingsGeminiKey = $('#settingsGeminiKey');
  const settingsModel = $('#settingsModel');
  const settingsLang = $('#settingsLang');

  const models = window.PhimAI?.POPULAR_MODELS || [
    { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' },
  ];
  models.forEach((m) => { const o = document.createElement('option'); o.value = m.id; o.textContent = m.name; settingsModel?.appendChild(o); });

  const settingsZoom = document.querySelector("#settingsZoom");

  async function checkBridgeSettingsStatus() {
    const pill = $('#shopeeBridgePill');
    const ep = ($('#shopeeBridgeEndpoint')?.value?.trim() || 'http://127.0.0.1:17881').replace(/\/+$/, '');
    try {
      const res = await fetch(`${ep}/health`, { signal: AbortSignal.timeout(2000) });
      const data = await res.json();
      if (data && (data.ok || data.status === 'ready')) {
        if (pill) {
          pill.textContent = 'ออนไลน์ ✓ (พร้อมรับคลิป)';
          pill.style.background = 'rgba(34, 197, 94, 0.2)';
          pill.style.color = '#22c55e';
        }
        return true;
      }
    } catch (_) {}
    if (pill) {
      pill.textContent = 'ออฟไลน์ (เปิดแอป/ต่อ USB)';
      pill.style.background = 'rgba(239, 68, 68, 0.2)';
      pill.style.color = '#ef4444';
    }
    return false;
  }

  async function loadSettings() {
    const config = await sendMsg('PHIMBOT_GET_API_CONFIG');
    if (settingsApiKey) settingsApiKey.value = config.apiKey || '';
    if (settingsApiProvider) settingsApiProvider.value = config.apiProvider || 'openrouter';
    if (settingsGeminiKey) settingsGeminiKey.value = config.geminiKey || '';
    if (settingsModel) settingsModel.value = config.model || 'google/gemini-2.5-flash';
    if (settingsLang) settingsLang.value = window.PhimI18n?.getLanguage?.() || 'th';
    const data = await chrome.storage.local.get([
      'phimbot_queue_delay_min',
      'phimbot_queue_delay_max',
      'phimbot_zoom',
      'phimbot_bridge_endpoint',
      'phimbot_bridge_token'
    ]);
    if (queueDelayMin) queueDelayMin.value = data.phimbot_queue_delay_min || 100;
    if (queueDelayMax) queueDelayMax.value = data.phimbot_queue_delay_max || 200;
    
    const epInput = $('#shopeeBridgeEndpoint');
    const tokenInput = $('#shopeeBridgeToken');
    if (epInput) epInput.value = data.phimbot_bridge_endpoint || 'http://127.0.0.1:17881';
    if (tokenInput) tokenInput.value = data.phimbot_bridge_token || 'SHOPEE-S8W66-QJTM7-BY55D-PUDKR';

    checkBridgeSettingsStatus();

    const zoom = data.phimbot_zoom || '1';
    if (settingsZoom) settingsZoom.value = zoom;
    document.body.style.zoom = zoom;

    const curVer = chrome.runtime.getManifest()?.version || '1.3.6';
    const extCurVerEl = $('#extCurrentVer');
    if (extCurVerEl) extCurVerEl.textContent = `v${curVer}`;
    const hdrVerEl = $('#headerVersionBadge');
    if (hdrVerEl) hdrVerEl.textContent = `v${curVer} · คิดปุ๊บ คลิปปั๊บ 🔄`;
  }

  $('#btnSaveSettings')?.addEventListener('click', async () => {
    await sendMsg('PHIMBOT_SAVE_API_KEY', { apiKey: settingsApiKey?.value?.trim(), geminiKey: settingsGeminiKey?.value?.trim(), model: settingsModel?.value, apiProvider: settingsApiProvider?.value });
    const newLang = settingsLang?.value;
    if (newLang && window.PhimI18n?.getLanguage && newLang !== window.PhimI18n.getLanguage()) await window.PhimI18n.setLanguage(newLang);
    const zoom = document.querySelector('#settingsZoom')?.value || '1';
    
    const bridgeEp = $('#shopeeBridgeEndpoint')?.value?.trim() || 'http://127.0.0.1:17881';
    const bridgeTok = $('#shopeeBridgeToken')?.value?.trim() || '';

    await chrome.storage.local.set({
      phimbot_zoom: zoom,
      phimbot_bridge_endpoint: bridgeEp,
      phimbot_bridge_token: bridgeTok
    });
    document.body.style.zoom = zoom;
    checkBridgeSettingsStatus();
    checkShopeeDeviceConnection();
    showToast('\u2705 บันทึกตั้งค่าแล้ว!');
  });

  $('#btnTestBridgeConn')?.addEventListener('click', async () => {
    const btn = $('#btnTestBridgeConn');
    const hint = $('#shopeeBridgeHint');
    const pill = $('#shopeeBridgePill');
    btn.disabled = true;
    btn.textContent = '⏳ กำลังทดสอบ...';
    const ep = ($('#shopeeBridgeEndpoint')?.value?.trim() || 'http://127.0.0.1:17881').replace(/\/+$/, '');
    const token = $('#shopeeBridgeToken')?.value?.trim() || '';

    await chrome.storage.local.set({
      phimbot_bridge_endpoint: ep,
      phimbot_bridge_token: token
    });

    try {
      const res = await fetch(`${ep}/health`, { signal: AbortSignal.timeout(3000) });
      const data = await res.json();
      if (data && (data.ok || data.status === 'ready')) {
        let tokenVerified = false;
        try {
          const vRes = await fetch(`${ep}/verify-token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
            signal: AbortSignal.timeout(3000)
          });
          const vData = await vRes.json();
          if (vData && vData.ok) tokenVerified = true;
        } catch (_) {}

        if (pill) {
          pill.textContent = 'เชื่อมต่อแล้ว ✓';
          pill.style.background = 'rgba(34, 197, 94, 0.2)';
          pill.style.color = '#22c55e';
        }
        if (hint) {
          hint.innerHTML = '✅ <span style="color:#22c55e;font-weight:bold;">เชื่อมต่อสำเร็จ!</span> PUP PAP POST Bridge บนมือถือออนไลน์และพร้อมรับคลิปเข้า Shopee ทันที';
        }
        showToast('✅ เชื่อมต่อ PUP PAP POST Bridge สำเร็จ!');
        checkShopeeDeviceConnection();
      } else {
        throw new Error('ไม่ได้รับการตอบกลับจาก Bridge');
      }
    } catch (e) {
      if (pill) {
        pill.textContent = 'ออฟไลน์';
        pill.style.background = 'rgba(239, 68, 68, 0.2)';
        pill.style.color = '#ef4444';
      }
      if (hint) {
        hint.innerHTML = '❌ <span style="color:#ef4444;">เชื่อมต่อไม่สำเร็จ:</span> กรุณาตรวจสอบว่าเปิดแอปบนมือถืออยู่ หรือกดปุ่ม "🔌 ต่อสาย USB"';
      }
      showToast('❌ ไม่สามารถเชื่อมต่อ Bridge ได้ (' + e.message + ')', true);
    } finally {
      btn.disabled = false;
      btn.textContent = '📡 ทดสอบเชื่อมต่อ Bridge';
    }
  });

  $('#btnStartUsbForward')?.addEventListener('click', async () => {
    const btn = $('#btnStartUsbForward');
    btn.disabled = true;
    btn.textContent = '🔌 กำลังตรวจสอบ...';
    try {
      // Check port 17881 directly
      const ok = await checkBridgeSettingsStatus();
      if (ok) {
        showToast('✅ ตรวจพบการเชื่อมต่อ Port 17881 พร้อมใช้งาน!');
      } else {
        // Test 17882 (PC Bridge daemon)
        try {
          const pcRes = await fetch('http://127.0.0.1:17882/health', { signal: AbortSignal.timeout(2000) });
          const pcData = await pcRes.json();
          if (pcData && pcData.ok) {
            showToast('✅ PC Bridge daemon ทำงานอยู่ พร้อมส่งผ่านสาย USB!');
          } else {
            showToast('💡 เพื่อต่อสาย USB ให้เปิดไฟล์ Start_Shopee_Bridge.bat บนคอมพิวเตอร์');
          }
        } catch (_) {
          showToast('💡 เพื่อต่อสาย USB ให้เปิดไฟล์ Start_Shopee_Bridge.bat บนคอมพิวเตอร์');
        }
      }
    } finally {
      btn.disabled = false;
      btn.textContent = '🔌 ต่อสาย USB';
      checkShopeeDeviceConnection();
    }
  });

  $('#btnTestApi')?.addEventListener('click', async () => {
    const btn = $('#btnTestApi');
    btn.disabled = true;
    btn.textContent = '\u23f3 กำลังทดสอบ...';
    try {
      await sendMsg('PHIMBOT_SAVE_API_KEY', { apiKey: settingsApiKey?.value?.trim(), geminiKey: settingsGeminiKey?.value?.trim(), model: settingsModel?.value, apiProvider: settingsApiProvider?.value });
      const res = await sendMsg('PHIMBOT_AI_GENERATE', { action: 'generate_caption', prompt: 'นี่คือข้อความทดสอบระบบ กรุณาตอบกลับแค่คำว่า "OK" เท่านั้น' });
      if (res && res.success) { showToast('\u2705 เชื่อมต่อ AI สำเร็จ! ระบบพร้อมใช้งาน'); }
      else { showToast('\u274c ผิดพลาด: ' + (res?.error || 'ไม่สามารถเชื่อมต่อได้'), true); alert('เชื่อมต่อ AI ไม่สำเร็จ:\\n' + (res?.error || 'ไม่ทราบสาเหตุ')); }
    } catch (e) { showToast('\u274c ผิดพลาด: ' + e.message, true); }
    finally { btn.disabled = false; btn.textContent = '\ud83e\uddea ทดสอบ API Key'; }
  });

  /* ═══ EXTENSION UPDATE CHECKER ═══ */
  function compareVersions(v1, v2) {
    const p1 = String(v1).replace(/^v/i, '').split('.').map(Number);
    const p2 = String(v2).replace(/^v/i, '').split('.').map(Number);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      const n1 = p1[i] || 0;
      const n2 = p2[i] || 0;
      if (n1 > n2) return 1;
      if (n1 < n2) return -1;
    }
    return 0;
  }

  async function checkExtensionUpdate(silent = false) {
    const btn = $('#btnCheckExtUpdate');
    const resultBox = $('#extUpdateResult');
    const currentVer = chrome.runtime.getManifest()?.version || '1.3.6';
    const curVerEl = $('#extCurrentVer');
    if (curVerEl) curVerEl.textContent = `v${currentVer}`;

    if (!silent) {
      if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ กำลังตรวจสอบ...';
      }
      if (resultBox) {
        resultBox.classList.remove('hidden');
        resultBox.style.background = 'rgba(255,255,255,0.04)';
        resultBox.style.border = '1px solid var(--border-light)';
        resultBox.style.color = 'var(--text-muted)';
        resultBox.innerHTML = '🔍 กำลังเชื่อมต่อเซิร์ฟเวอร์เพื่อตรวจสอบเวอร์ชันล่าสุด...';
      }
    }

    try {
      const updateUrl = `https://raw.githubusercontent.com/nilmat2007/pas/main/extension_version.json?t=${Date.now()}`;
      const res = await fetch(updateUrl, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const info = await res.json();

      const remoteVer = info.version || '1.3.6';
      const hasNew = compareVersions(remoteVer, currentVer) > 0;

      if (hasNew) {
        const headerBadge = $('#headerVersionBadge');
        if (headerBadge) {
          headerBadge.innerHTML = `v${currentVer} · <span style="color:#ef4444; font-weight:700;">🔴 มีเวอร์ชันใหม่ v${remoteVer}!</span>`;
        }
        if (resultBox) {
          resultBox.classList.remove('hidden');
          resultBox.style.background = 'rgba(21, 128, 61, 0.12)';
          resultBox.style.border = '1.5px solid rgba(21, 128, 61, 0.4)';
          resultBox.style.color = 'var(--text-primary)';
          resultBox.innerHTML = `
            <div style="font-weight:700; color:#15803d; margin-bottom:4px; font-size:13px; display:flex; align-items:center; gap:6px;">
              <span>🎉</span> พบเวอร์ชันใหม่: <b>v${remoteVer} (${info.name || 'PUP PAP AI'})</b>
            </div>
            <div style="font-size:11px; color:var(--text-secondary); white-space:pre-line; margin-bottom:10px; line-height:1.5;">${info.notes || 'มีการอัปเดตฟีเจอร์และปรับปรุงประสิทธิภาพ'}</div>
            <div style="display:flex; flex-direction:column; gap:6px;">
              <a href="${info.downloadUrl || 'https://github.com/nilmat2007/pas/raw/main/PUP_PAP_AI_v1.3.6.zip'}" target="_blank" class="btn btn-primary btn-sm" style="display:inline-flex; align-items:center; justify-content:center; gap:6px; text-decoration:none; padding:8px 14px; font-size:12px; font-weight:700;">📥 ดาวน์โหลดอัปเดต v${remoteVer} (.zip)</a>
              <div style="font-size:10px; color:var(--text-muted); line-height:1.4;">💡 วิธีอัปเดต: โหลดไฟล์ zip → แตกไฟล์ทับโฟลเดอร์เดิม → กดปุ่ม 🔄 รีโหลดในหน้ารวม Extension (chrome://extensions)</div>
            </div>
          `;
        }
        if (!silent) showToast(`🚀 พบเวอร์ชันใหม่ v${remoteVer}!`);
      } else {
        if (!silent && resultBox) {
          resultBox.classList.remove('hidden');
          resultBox.style.background = 'rgba(21, 128, 61, 0.1)';
          resultBox.style.border = '1px solid rgba(21, 128, 61, 0.3)';
          resultBox.style.color = 'var(--text-primary)';
          resultBox.innerHTML = `
            <div style="font-weight:600; display:flex; align-items:center; gap:6px; color:#15803d;">
              <span>✅</span> คุณกำลังใช้งานเวอร์ชันล่าสุดแล้ว (v${currentVer})
            </div>
            ${info.notes ? `<div style="font-size:11px; color:var(--text-muted); margin-top:4px; white-space:pre-line;">${info.notes}</div>` : ''}
          `;
          showToast(`✅ ใช้เวอร์ชันล่าสุดแล้ว (v${currentVer})`);
        }
      }

      if (chrome.runtime?.requestUpdateCheck) {
        chrome.runtime.requestUpdateCheck((status) => {
          console.log('[Extension Update] Chrome native check:', status);
        });
      }
    } catch (err) {
      console.warn('[Extension Update] Error:', err);
      if (!silent && resultBox) {
        resultBox.classList.remove('hidden');
        resultBox.style.background = 'rgba(239, 68, 68, 0.1)';
        resultBox.style.border = '1px solid rgba(239, 68, 68, 0.3)';
        resultBox.style.color = '#b91c1c';
        resultBox.innerHTML = `⚠️ ไม่สามารถตรวจสอบอัปเดตได้ (${err.message || 'เครือข่ายขัดข้อง'})`;
      }
      if (!silent) showToast('⚠️ ตรวจสอบอัปเดตไม่สำเร็จ');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🔍 ตรวจสอบอัปเดต';
      }
    }
  }

  $('#btnCheckExtUpdate')?.addEventListener('click', () => checkExtensionUpdate());

  $('#headerVersionBadge')?.addEventListener('click', () => {
    const settingsBtn = document.querySelector('.tab-btn[data-tab="settings"]');
    if (settingsBtn) settingsBtn.click();
    const updateCard = $('#extUpdateCard');
    if (updateCard) updateCard.scrollIntoView({ behavior: 'smooth' });
    checkExtensionUpdate();
  });

  /* ═══ INIT ═══ */
  loadSettings();
  refreshQueue();

  // Set default schedule date/time (30 min from now)
  const now = new Date();
  now.setMinutes(now.getMinutes() + 30);
  const sd = $('#scheduleDate'); const stEl = $('#scheduleTime');
  if (sd) sd.value = now.toISOString().split('T')[0];
  if (stEl) stEl.value = now.toTimeString().slice(0, 5);

  const fbDate = $('#fbReelsDate'); const fbTime = $('#fbReelsTime');
  if (fbDate) fbDate.value = now.toISOString().split('T')[0];
  if (fbTime) fbTime.value = now.toTimeString().slice(0, 5);

  loadShopeeHistory();
  setTimeout(() => checkExtensionUpdate(true), 2500);
})();


/* ═══════════════════════════════════════════════════════════════
   SHOPEE KEYWORD SCANNER UI
   ═══════════════════════════════════════════════════════════════ */
(function initShopeeScanner() {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  const showToast = (msg) => { const t = document.createElement('div'); t.className = 'toast show'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3000); };
  let scanResults = window.shopeeScannedProducts = [];
  let currentSort = 'score';

  const scanStatus = $('#shopeeScanStatus');
  function showScanStatus(msg, type) {
    if (!scanStatus) return;
    scanStatus.className = 'status-msg ' + (type || 'info');
    scanStatus.textContent = msg;
    scanStatus.classList.remove('hidden');
  }

  function formatThb(n) {
    if (!n) return '';
    const num = Number(n);
    if (isNaN(num)) return String(n);
    return '฿' + num.toLocaleString('th-TH');
  }

  function sortResults(items, by) {
    const arr = [...items];
    switch (by) {
      case 'score': return arr.sort((a, b) => (b.trendScore || 0) - (a.trendScore || 0));
      case 'sold': return arr.sort((a, b) => (b.sold || 0) - (a.sold || 0));
      case 'revenue': return arr.sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
      case 'rating': return arr.sort((a, b) => (b.rating || 0) - (a.rating || 0));
      case 'price': return arr.sort((a, b) => (a.price || 0) - (b.price || 0));
      default: return arr;
    }
  }

  function renderScanResults() {
    const container = $('#shopeeScanResults');
    const wrap = $('#shopeeScanResultsWrap');
    const countEl = $('#shopeeScanCount');
    const actionsEl = $('#shopeeScanActions');
    if (!container) return;

    const sorted = sortResults(scanResults, currentSort);
    wrap?.classList.remove('hidden');

    // Summary stats
    const mallCount = sorted.filter(i => i.isMall).length;
    const extraCount = sorted.filter(i => i.isExtraComm).length;
    const linkCount = sorted.filter(i => i.affiliateUrl && !i.affiliateUrl.includes('affiliate.shopee.co.th')).length;
    if (countEl) {
      countEl.innerHTML = 'พบ ' + sorted.length + ' สินค้า' +
        (mallCount ? ' | <span style="color:#ee4d2d;">Mall ' + mallCount + '</span>' : '') +
        (extraCount ? ' | <span style="color:#ff6740;">EXTRACOMM ' + extraCount + '</span>' : '') +
        (linkCount ? ' | <span style="color:#10b981;">มีลิงก์ ' + linkCount + '</span>' : '');
    }
    if (actionsEl && sorted.length) { actionsEl.classList.remove('hidden'); actionsEl.style.display = 'flex'; }

    container.innerHTML = sorted.map((item, idx) => {
      const scoreColor = item.trendScore >= 70 ? '#10b981' : item.trendScore >= 40 ? '#f59e0b' : '#ef4444';
      const hasLink = item.affiliateUrl && !item.affiliateUrl.includes('affiliate.shopee.co.th');

      // Badges row
      const badgeParts = [];
      if (hasLink) badgeParts.push('<span style="background:#10b981; color:#fff; padding:2px 8px; border-radius:4px; font-size:10px; font-weight:600;">มีลิงก์แล้ว</span>');
      if (item.isExtraComm) badgeParts.push('<span style="background:#ff6740; color:#fff; padding:2px 8px; border-radius:4px; font-size:10px; font-weight:600;">EXTRA COMM</span>');
      if (item.isMall) badgeParts.push('<span style="background:#ee4d2d; color:#fff; padding:2px 8px; border-radius:4px; font-size:10px; font-weight:600;">Mall</span>');
      if (item.isPreferred) badgeParts.push('<span style="background:#1877f2; color:#fff; padding:2px 8px; border-radius:4px; font-size:10px; font-weight:600;">แนะนำ</span>');
      const badgesRow = badgeParts.length ? '<div style="display:flex; gap:4px; flex-wrap:wrap; margin-bottom:6px;">' + badgeParts.join('') + '</div>' : '';

      // Sales text
      const soldText = item.sold ? 'ขายแล้ว ' + item.sold.toLocaleString() + ' ชิ้น' : '';

      // Commission text  
      const commText = item.commissionRate ? '<div style="color:#10b981; font-size:11px; margin-top:3px;">\u{1F4B0} อัตราค่าคอมมิชชั่น ' + item.commissionRate + '%</div>' : '';

      return '<div class="scan-item" style="background:#1a1a2e; border-radius:10px; padding:10px; margin-bottom:2px;" data-idx="' + idx + '">' +
        // Badges row
        badgesRow +
        // Content row
        '<div style="display:flex; gap:10px; align-items:flex-start;">' +
          '<input type="checkbox" class="scan-check" data-idx="' + idx + '" style="flex-shrink:0; width:16px; height:16px; accent-color:#f90; cursor:pointer; margin-top:4px;">' +
          '<img src="' + (item.imageUrl || '') + '" style="width:60px; height:60px; object-fit:cover; border-radius:8px; flex-shrink:0; background:#0d0d1a; cursor:pointer;" class="scan-img" data-idx="' + idx + '">' +
          '<div style="flex:1; min-width:0;">' +
            '<div style="font-size:12px; color:#e0e0e0; line-height:1.4; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">' + (item.title || '') + '</div>' +
            '<div style="margin-top:4px; display:flex; align-items:center; gap:6px;">' +
              '<span style="color:#ff6740; font-weight:bold; font-size:14px;">' + formatThb(item.price) + '</span>' +
              (soldText ? '<span style="font-size:10px; color:#888;">' + soldText + '</span>' : '') +
            '</div>' +
            commText +
            '<div style="margin-top:2px; font-size:10px; color:#666;">' +
              '<span style="color:' + scoreColor + '; font-weight:bold;">Score: ' + (item.trendScore || 0) + '</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        // Action buttons row
        '<div style="display:flex; gap:4px; margin-top:8px; justify-content:flex-end;">' +
          '<button class="btn btn-secondary btn-sm scan-open-btn" data-idx="' + idx + '" style="font-size:10px; padding:3px 8px;">เปิด</button>' +
          '<button class="btn btn-secondary btn-sm scan-copy-btn" data-idx="' + idx + '" style="font-size:10px; padding:3px 8px;">คัดลอก</button>' +
          '<button class="btn btn-secondary btn-sm scan-use-shopee-btn" data-idx="' + idx + '" style="font-size:10px; padding:3px 8px; background:#ee4d2d; border-color:#ee4d2d; color:#fff;">Shopee VDO</button>' +
          '<button class="btn btn-primary btn-sm scan-use-btn" data-idx="' + idx + '" style="font-size:10px; padding:3px 8px;">ใช้Reels</button>' +
        '</div>' +
      '</div>';
    }).join('');

    // ─── Event Bindings ───
    const updateSelectedCount = () => {
      const checks = container.querySelectorAll('.scan-check:checked');
      const countSpan = $('#shopeeSelectedCount');
      if (countSpan) countSpan.textContent = checks.length + ' รายการ';
    };
    container.querySelectorAll('.scan-check').forEach(cb => cb.addEventListener('change', updateSelectedCount));

    const selectAllCb = $('#shopeeSelectAll');
    if (selectAllCb) {
      selectAllCb.onchange = () => {
        container.querySelectorAll('.scan-check').forEach(cb => { cb.checked = selectAllCb.checked; });
        updateSelectedCount();
      };
    }

    // Image click = toggle checkbox
    container.querySelectorAll('.scan-img').forEach(img => {
      img.addEventListener('click', () => {
        const cb = container.querySelector('.scan-check[data-idx="' + img.dataset.idx + '"]');
        if (cb) { cb.checked = !cb.checked; updateSelectedCount(); }
      });
    });

    // "เปิด" button - open offer page
    container.querySelectorAll('.scan-open-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = sortResults(scanResults, currentSort)[parseInt(btn.dataset.idx)];
        if (item?.offerUrl) chrome.tabs.create({ url: item.offerUrl, active: true });
      });
    });

    // "คัดลอก" button - copy affiliate link or offer URL
    container.querySelectorAll('.scan-copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = sortResults(scanResults, currentSort)[parseInt(btn.dataset.idx)];
        if (!item) return;
        const link = (item.affiliateUrl && !item.affiliateUrl.includes('affiliate.shopee.co.th')) ? item.affiliateUrl : item.offerUrl || '';
        if (link) { navigator.clipboard.writeText(link); showToast('\u2705 คัดลอกแล้ว!'); }
        else showToast('ยังไม่มีลิงก์ กดดึงลิงก์ก่อน');
      });
    });

    // "ใช้Reels" button - use for Reels
    container.querySelectorAll('.scan-use-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = sortResults(scanResults, currentSort)[parseInt(btn.dataset.idx)];
        if (!item) return;
        document.querySelector('[data-tab="fb-reels"]')?.click();
        window.dispatchEvent(new CustomEvent('phimbot-select-product', { detail: item }));
      });
    });

    // "ใช้ Shopee VDO" button - use for Shopee Video
    container.querySelectorAll('.scan-use-shopee-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = sortResults(scanResults, currentSort)[parseInt(btn.dataset.idx)];
        if (!item) return;
        document.querySelector('[data-tab="shopee-video"]')?.click();
        window.dispatchEvent(new CustomEvent('phimbot-select-shopee-video-product', { detail: item }));
      });
    });
  }

  // ─── Get Links for selected items ───
  $('#btnShopeeGetLinks')?.addEventListener('click', async () => {
    const container = $('#shopeeScanResults');
    const checks = container?.querySelectorAll('.scan-check:checked') || [];
    if (!checks.length) { showToast('กรุณาเลือกสินค้าก่อน'); return; }
    const btn = $('#btnShopeeGetLinks');
    const sorted = sortResults(scanResults, currentSort);
    btn.disabled = true;
    let done = 0;
    const total = checks.length;
    btn.textContent = '\u{1F517} 0/' + total;

    for (const cb of checks) {
      const idx = parseInt(cb.dataset.idx);
      const item = sorted[idx];
      if (!item || !item.offerId) { done++; continue; }
      if (item.affiliateUrl && !item.affiliateUrl.includes('affiliate.shopee.co.th')) { done++; btn.textContent = '\u{1F517} ' + done + '/' + total; continue; }

      try {
        const result = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            type: 'PHIMBOT_GET_AFFILIATE_LINK',
            item: { offerId: item.offerId, title: item.title, offerUrl: item.offerUrl }
          }, r => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(r);
          });
        });
        if (result?.ok && result?.affiliateUrl) {
          item.affiliateUrl = result.affiliateUrl;
          console.log('[PhimBot] Got link for', item.title, ':', result.affiliateUrl);
          if (window.phimbotSaveToCatalog) window.phimbotSaveToCatalog(item);
        } else {
          console.warn('[PhimBot] Get link returned no affiliateUrl:', result);
        }
      } catch (err) { console.warn('[PhimBot] Get link failed:', err); }
      done++;
      btn.textContent = '\u{1F517} ' + done + '/' + total;
    }

    btn.disabled = false;
    btn.textContent = '\u{1F517} ดึงลิงก์ที่เลือก';
    showToast('\u2705 ดึงลิงก์เสร็จ ' + done + ' สินค้า');
    renderScanResults(); // Re-render to show badges
    // Persist updated scanResults with affiliate links to storage
    try {
      await chrome.storage.local.set({ phimbot_shopee_scan: { items: scanResults, ts: Date.now() } });
    } catch (e) { console.warn('Failed to persist scan results:', e); }
  });

  // ─── Use selected for Reels ───
  $('#btnShopeeUseReels')?.addEventListener('click', () => {
    const container = $('#shopeeScanResults');
    const checks = container?.querySelectorAll('.scan-check:checked') || [];
    if (!checks.length) { showToast('กรุณาเลือกสินค้าก่อน'); return; }
    const idx = parseInt([...checks][0].dataset.idx);
    const item = sortResults(scanResults, currentSort)[idx];
    if (item) {
      document.querySelector('[data-tab="fb-reels"]')?.click();
      window.dispatchEvent(new CustomEvent('phimbot-select-product', { detail: item }));
    }
  });

  // ─── Use selected for Shopee Video ───
  $('#btnShopeeUseShopeeVideo')?.addEventListener('click', () => {
    const container = $('#shopeeScanResults');
    const checks = container?.querySelectorAll('.scan-check:checked') || [];
    if (!checks.length) { showToast('กรุณาเลือกสินค้าก่อน'); return; }
    const idx = parseInt([...checks][0].dataset.idx);
    const item = sortResults(scanResults, currentSort)[idx];
    if (item) {
      document.querySelector('[data-tab="shopee-video"]')?.click();
      window.dispatchEvent(new CustomEvent('phimbot-select-shopee-video-product', { detail: item }));
    }
  });

  // Sort chips
  document.querySelectorAll('.shopee-sort-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.shopee-sort-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentSort = chip.dataset.sort;
      renderScanResults();
    });
  });

  // Scan button
  $('#btnShopeeScan')?.addEventListener('click', async () => {
    const keyword = $('#shopeeScanKeyword')?.value?.trim();
    if (!keyword) { showScanStatus('กรุณาพิมพ์ keyword', 'warning'); return; }
    const pages = parseInt($('#shopeeScanPages')?.value) || 3;
    const sort = $('#shopeeScanSort')?.value || 'sold';
    const filters = {
      extraComm: $('#shopeeFilterExtraComm')?.checked || false,
      mall: $('#shopeeFilterMall')?.checked || false,
      preferred: $('#shopeeFilterPreferred')?.checked || false,
    };

    showScanStatus('กำลังเริ่มสแกน...', 'info');
    const btn = $('#btnShopeeScan');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> กำลังสแกน...';
    const startTime = Date.now();

    try {
      const result = await new Promise((resolve, reject) => {
        // Use Port for persistent connection (no timeout)
        const port = chrome.runtime.connect({ name: 'shopee-scanner' });
        let resolved = false;

        port.onMessage.addListener((msg) => {
          if (msg.type === 'status') {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            const step = msg.step === 'opening_tab' ? '📂 เปิดแท็บ...' :
              msg.step === 'waiting_for_page' ? '⏳ รอหน้าเว็บโหลด...' : '🔍 กำลังสแกน...';
            showScanStatus(step + ' (' + elapsed + 'วิ)', 'info');
          }
          if (msg.type === 'result') {
            resolved = true;
            port.disconnect();
            resolve(msg);
          }
        });

        port.onDisconnect.addListener(() => {
          if (!resolved) {
            const err = chrome.runtime.lastError?.message || 'port disconnected';
            reject(new Error(err));
          }
        });

        // Send scan command
        port.postMessage({
          action: 'start_scan',
          keyword,
          options: { pages, sort, filters }
        });

        // Safety timeout: 5 minutes
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            try { port.disconnect(); } catch(_) {}
            resolve({ ok: false, reason: 'หมดเวลา (5 นาที)', items: [] });
          }
        }, 5 * 60 * 1000);
      });

      if (result?.ok && result?.items?.length) {
        scanResults = window.shopeeScannedProducts = result.items || [];
        showScanStatus('✅ พบ ' + scanResults.length + ' สินค้า', 'success');
        renderScanResults();
      } else {
        showScanStatus('❌ ' + (result?.reason || 'ไม่พบสินค้า'), 'error');
      }
    } catch (err) {
      showScanStatus('❌ ' + err.message, 'error');
    }
    btn.disabled = false; btn.innerHTML = '🔥 สแกน';
  });

  // Enter key to scan
  $('#shopeeScanKeyword')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btnShopeeScan')?.click();
  });

  // Restore previous scan results from storage if available
  chrome.storage.local.get('phimbot_shopee_scan').then(res => {
    if (res?.phimbot_shopee_scan?.items?.length) {
      scanResults = window.shopeeScannedProducts = res.phimbot_shopee_scan.items;
      renderScanResults();
    }
  }).catch(() => {});
})();

/* ═══════════════════════════════════════════════════════════════
   FB Reels & Shopee Video - Shopee Product Picker
   ═══════════════════════════════════════════════════════════════ */
let fbReelsSelectedProduct = null;
let shopeeVideoSelectedProduct = null;
let currentProductPickerTarget = 'fbReels';

(function initFbReelsProductPicker() {
  const $ = (sel) => document.querySelector(sel);

  // ─── Persistent Catalog Functions ───
  async function getSavedCatalog() {
    try {
      const data = await chrome.storage.local.get(['phimbot_saved_catalog', 'phimbot_shopee_scan', 'phimbot_shopee_history']);
      let catalog = Array.isArray(data.phimbot_saved_catalog) ? data.phimbot_saved_catalog : [];
      let updated = false;

      const importItem = (item) => {
        if (!item) return;
        const affUrl = item.affiliateUrl || '';
        const hasAffLink = affUrl && !affUrl.includes('affiliate.shopee.co.th');
        // Accept items that have affiliate link, or offerId/offerUrl/productUrl
        if (hasAffLink || item.offerId || item.offerUrl || item.url) {
          const itemOfferId = item.offerId || '';
          const itemTitle = item.title || item.name || '';
          const exists = catalog.some(c => (itemOfferId && c.offerId && c.offerId === itemOfferId) || (itemTitle && c.title && c.title === itemTitle));
          if (!exists) {
            catalog.push({
              offerId: itemOfferId,
              productId: item.productId || '',
              title: itemTitle,
              price: item.price || 0,
              imageUrl: item.imageUrl || (item.images && item.images[0]?.url) || (item.images && typeof item.images[0] === 'string' && item.images[0]) || '',
              affiliateUrl: hasAffLink ? affUrl : '',
              offerUrl: item.offerUrl || item.productUrl || item.url || '',
              commissionRate: item.commissionRate || 0,
              sold: item.sold || 0,
              trendScore: item.trendScore || 0,
              savedAt: item.savedAt || item.timestamp || Date.now()
            });
            updated = true;
          } else if (hasAffLink) {
            const match = catalog.find(c => (itemOfferId && c.offerId && c.offerId === itemOfferId) || (itemTitle && c.title && c.title === itemTitle));
            if (match && (!match.affiliateUrl || match.affiliateUrl.includes('affiliate.shopee.co.th'))) {
              match.affiliateUrl = affUrl;
              updated = true;
            }
          }
        }
      };

      // Auto-import scanned items from storage
      const scanData = data.phimbot_shopee_scan?.items || [];
      for (const item of scanData) importItem(item);

      // Auto-import memory scanned items if any
      if (Array.isArray(window.shopeeScannedProducts)) {
        for (const item of window.shopeeScannedProducts) importItem(item);
      }

      // Auto-import history
      const historyData = Array.isArray(data.phimbot_shopee_history) ? data.phimbot_shopee_history : [];
      for (const item of historyData) importItem(item);

      if (updated) {
        await chrome.storage.local.set({ phimbot_saved_catalog: catalog });
      }
      return catalog;
    } catch (_) { return []; }
  }

  async function saveProductToCatalog(product) {
    if (!product || !product.affiliateUrl || product.affiliateUrl.includes('affiliate.shopee.co.th')) return;
    try {
      const catalog = await getSavedCatalog();
      const existingIdx = catalog.findIndex(i => (i.offerId && i.offerId === product.offerId) || i.title === product.title);
      const itemData = {
        offerId: product.offerId || '',
        productId: product.productId || '',
        title: product.title || '',
        price: product.price || 0,
        imageUrl: product.imageUrl || product.images?.[0]?.url || product.images?.[0] || '',
        affiliateUrl: product.affiliateUrl,
        commissionRate: product.commissionRate || 0,
        sold: product.sold || 0,
        trendScore: product.trendScore || 0,
        savedAt: Date.now()
      };
      if (existingIdx >= 0) {
        catalog[existingIdx] = { ...catalog[existingIdx], ...itemData };
      } else {
        catalog.unshift(itemData);
      }
      await chrome.storage.local.set({ phimbot_saved_catalog: catalog });
      updateCatalogCount();
      console.log('[PhimBot] Saved to catalog, total:', catalog.length);
    } catch (e) {
      console.warn('[PhimBot] Failed to save to catalog:', e);
    }
  }

  async function removeProductFromCatalog(offerIdOrTitle) {
    try {
      let catalog = await getSavedCatalog();
      catalog = catalog.filter(i => (i.offerId ? i.offerId !== offerIdOrTitle : i.title !== offerIdOrTitle));
      await chrome.storage.local.set({ phimbot_saved_catalog: catalog });
      updateCatalogCount();
      return catalog;
    } catch (_) { return []; }
  }

  async function updateCatalogCount() {
    const catalog = await getSavedCatalog();
    const countEl = document.getElementById('pmSavedCount');
    if (countEl) countEl.textContent = catalog.length;
  }

  window.phimbotSaveToCatalog = saveProductToCatalog;
  window.phimbotUpdateCatalogCount = updateCatalogCount;
  updateCatalogCount();
  const showToast = (msg) => {
    const t = document.getElementById('toast');
    if (t) { t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500); }
  };

  // ─── Product Selection ───
  async function selectProduct(product) {
    if (currentProductPickerTarget === 'shopeeVideo') {
      await selectShopeeVideoProduct(product);
      return;
    }
    console.log('[PhimBot-SP] selectProduct:', product?.offerId, 'affiliateUrl:', product?.affiliateUrl);
    fbReelsSelectedProduct = product;
    const card = document.getElementById('fbReelsProductCard');
    const picker = document.getElementById('fbReelsProductPicker');
    if (!card || !picker) { console.warn('[PhimBot-SP] card/picker not found'); return; }

    const imgEl = document.getElementById('fbReelsProductImg');
    const titleEl = document.getElementById('fbReelsProductTitle');
    const priceEl = document.getElementById('fbReelsProductPrice');
    if (imgEl) imgEl.src = product.imageUrl || product.images?.[0]?.url || product.images?.[0] || '';
    if (titleEl) titleEl.textContent = product.title || '';
    if (priceEl) priceEl.textContent = '฿' + (product.price || '0') + (product.commissionRate ? '  คอมฯ ' + product.commissionRate + '%' : '');
    
    card.classList.remove('hidden');
    picker.style.display = 'none';
    closeModal();

    // Helper: always get fresh reference
    const getLinkEl = () => document.getElementById('fbReelsProductLinkText');
    const hasRealLink = product.affiliateUrl && /^https:\/\/(s\.shopee\.co\.th|shope\.ee|shopee\.co\.th)\//i.test(product.affiliateUrl) && !product.affiliateUrl.includes('affiliate.shopee.co.th');
    console.log('[PhimBot-SP] hasRealLink:', hasRealLink, 'offerId:', product.offerId);

    if (hasRealLink) {
      const el = getLinkEl();
      if (el) { el.textContent = '🔗 ' + product.affiliateUrl; el.style.color = '#10b981'; }
      console.log('[PhimBot-SP] Using existing link:', product.affiliateUrl);
    } else if (product.offerId) {
      const el = getLinkEl();
      if (el) { el.textContent = '⏳ กำลังดึง affiliate link...'; el.style.color = '#f59e0b'; }
      console.log('[PhimBot-SP] Fetching link for offerId:', product.offerId);
      try {
        const linkResult = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            type: 'PHIMBOT_GET_AFFILIATE_LINK',
            item: { offerId: product.offerId, title: product.title, offerUrl: product.offerUrl }
          }, r => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(r);
          });
        });
        console.log('[PhimBot-SP] linkResult:', JSON.stringify(linkResult));
        const el2 = getLinkEl(); // Fresh reference after await
        if (linkResult?.ok && linkResult?.affiliateUrl) {
          product.affiliateUrl = linkResult.affiliateUrl;
          fbReelsSelectedProduct.affiliateUrl = linkResult.affiliateUrl;
          if (el2) { el2.textContent = '🔗 ' + linkResult.affiliateUrl; el2.style.color = '#10b981'; }
          if (window.phimbotSaveToCatalog) window.phimbotSaveToCatalog(product);
          showToast('✅ ได้ affiliate link แล้ว!');
          // Also update scanner results if exists
          if (window.shopeeScannedProducts) {
            const scanItem = window.shopeeScannedProducts.find(i => i.offerId === product.offerId);
            if (scanItem) scanItem.affiliateUrl = linkResult.affiliateUrl;
          }
        } else {
          if (el2) { el2.textContent = '❌ ดึง link ไม่ได้: ' + (linkResult?.reason || 'unknown'); el2.style.color = '#ef4444'; }
        }
      } catch (err) {
        console.error('[PhimBot-SP] Link fetch error:', err);
        const el3 = getLinkEl();
        if (el3) { el3.textContent = '❌ ' + err.message; el3.style.color = '#ef4444'; }
      }
    } else {
      const el = getLinkEl();
      if (el) { el.textContent = product.offerUrl ? '📎 ' + product.offerUrl : ''; el.style.color = '#888'; }
    }

    // Keep caption blank by default so AI generates fresh unique caption per clip
    const captionEl = document.getElementById('fbReelsCaption');
    const hashEl = document.getElementById('fbReelsHashtags');
    if (captionEl) {
      if (captionEl.value.includes('สายช้อปห้ามพลาด')) captionEl.value = '';
      captionEl.placeholder = 'เขียนแคปชั่น... (เว้นว่างให้ AI คิดแคปชั่นใหม่ทุกคลิปไม่ซ้ำกัน)';
    }
    if (hashEl && !hashEl.value.trim()) {
      hashEl.value = '#reels #reelsfb #ของดีบอกต่อ #ช้อปปี้ถูกชัวร์';
    }
  }

  async function selectShopeeVideoProduct(product) {
    console.log('[PhimBot-SP] selectShopeeVideoProduct:', product?.offerId, 'affiliateUrl:', product?.affiliateUrl);
    shopeeVideoSelectedProduct = product;
    const card = document.getElementById('shopeeVideoProductCard');
    const picker = document.getElementById('shopeeVideoProductPicker');
    if (!card || !picker) { console.warn('[PhimBot-SP] shopeeVideo card/picker not found'); return; }

    const imgEl = document.getElementById('shopeeVideoProductImg');
    const titleEl = document.getElementById('shopeeVideoProductTitle');
    const priceEl = document.getElementById('shopeeVideoProductPrice');
    if (imgEl) imgEl.src = product.imageUrl || product.images?.[0]?.url || product.images?.[0] || '';
    if (titleEl) titleEl.textContent = product.title || '';
    if (priceEl) priceEl.textContent = '฿' + (product.price || '0') + (product.commissionRate ? '  คอมฯ ' + product.commissionRate + '%' : '');

    card.classList.remove('hidden');
    card.style.display = 'flex';
    picker.style.display = 'none';
    closeModal();

    const getLinkEl = () => document.getElementById('shopeeVideoProductLinkText');
    const hasRealLink = isShopeeAffShortLink(product.affiliateUrl);

    if (hasRealLink) {
      const el = getLinkEl();
      if (el) { el.textContent = '🔗 ' + product.affiliateUrl; el.style.color = '#10b981'; }
    } else if (product.offerId || product.offerUrl || product.productUrl || product.url) {
      const el = getLinkEl();
      if (el) { el.textContent = '⏳ กำลังดึง affiliate shortlink (s.shopee.co.th)...'; el.style.color = '#f59e0b'; }
      try {
        const linkResult = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            type: 'PHIMBOT_GET_AFFILIATE_LINK',
            item: product,
            url: product.offerUrl || product.productUrl || product.url || ''
          }, r => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(r);
          });
        });
        const el2 = getLinkEl();
        if (linkResult?.ok && isShopeeAffShortLink(linkResult?.affiliateUrl)) {
          product.affiliateUrl = linkResult.affiliateUrl;
          shopeeVideoSelectedProduct.affiliateUrl = linkResult.affiliateUrl;
          if (el2) { el2.textContent = '🔗 ' + linkResult.affiliateUrl; el2.style.color = '#10b981'; }
          if (window.phimbotSaveToCatalog) window.phimbotSaveToCatalog(product);
          showToast('✅ ได้ affiliate link แล้ว! (s.shopee.co.th)');
        } else {
          if (el2) { el2.textContent = '❌ ดึง link ไม่ได้ (กรุณาล็อกอิน affiliate.shopee.co.th)'; el2.style.color = '#ef4444'; }
        }
      } catch (err) {
        const el3 = getLinkEl();
        if (el3) { el3.textContent = '❌ ' + err.message; el3.style.color = '#ef4444'; }
      }
    } else {
      const el = getLinkEl();
      if (el) { el.textContent = product.offerUrl ? '📎 ' + product.offerUrl : ''; el.style.color = '#888'; }
    }

    const captionEl = document.getElementById('shopeeVideoCaption');
    const hashEl = document.getElementById('shopeeVideoHashtags');
    if (captionEl && !captionEl.value.trim()) {
      captionEl.placeholder = 'เขียนแคปชั่น... (เว้นว่างให้ AI คิดแคปชั่นใหม่ทุกคลิปไม่ซ้ำกัน สไตล์ป้ายยา Shopee)';
    }
    if (hashEl && !hashEl.value.trim()) {
      hashEl.value = '#ShopeeTH #ช้อปปี้ถูกชัวร์ #รีวิว #ของดีบอกต่อ';
    }
  }

  function removeProduct() {
    fbReelsSelectedProduct = null;
    const card = $('#fbReelsProductCard');
    const picker = $('#fbReelsProductPicker');
    if (card) { card.classList.add('hidden'); card.style.display = 'none'; }
    if (picker) picker.style.display = '';
  }

  function removeShopeeVideoProduct() {
    shopeeVideoSelectedProduct = null;
    const card = $('#shopeeVideoProductCard');
    const picker = $('#shopeeVideoProductPicker');
    if (card) { card.classList.add('hidden'); card.style.display = 'none'; }
    if (picker) picker.style.display = '';
  }

  // ─── Modal ───
  function openModal(target = 'fbReels') {
    currentProductPickerTarget = target;
    const modal = $('#fbReelsProductModal');
    if (modal) { modal.classList.remove('hidden'); modal.style.display = 'flex'; }
    
    // Dynamic Header Title
    const headerTitle = $('#productModalHeaderTitle');
    if (headerTitle) {
      if (target === 'shopeeVideo') {
        headerTitle.innerHTML = '🛒 เลือกสินค้า Shopee <span style="color:#ee4d2d;font-size:12px;font-weight:normal;">(สำหรับ Shopee Video)</span>';
      } else {
        headerTitle.innerHTML = '🛒 เลือกสินค้า Shopee <span style="color:#1877f2;font-size:12px;font-weight:normal;">(สำหรับ FB Reels)</span>';
      }
    }

    // Switch to saved tab by default
    const savedBtn = document.querySelector('.product-modal-tab[data-pm-tab="saved"]');
    if (savedBtn) savedBtn.click();
    else loadSavedCatalog();
  }

  function closeModal() {
    const modal = $('#fbReelsProductModal');
    if (modal) { modal.classList.add('hidden'); modal.style.display = 'none'; }
  }

  // ─── Tab switching in modal ───
  document.querySelectorAll('.product-modal-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.product-modal-tab').forEach(t => {
        t.classList.remove('active');
        t.style.color = '#888';
        t.style.borderBottom = '2px solid transparent';
      });
      tab.classList.add('active');
      const target = tab.getAttribute('data-pm-tab');
      if (target === 'saved') {
        tab.style.color = '#10b981';
        tab.style.borderBottom = '2px solid #10b981';
      } else if (target === 'scanned') {
        tab.style.color = '#f90';
        tab.style.borderBottom = '2px solid #f90';
      } else {
        tab.style.color = '#fff';
        tab.style.borderBottom = '2px solid #3b82f6';
      }

      const savedTab = $('#productModalSavedTab');
      const scannedTab = $('#productModalScannedTab');
      const urlTab = $('#productModalUrlTab');

      if (savedTab) savedTab.classList.toggle('hidden', target !== 'saved');
      if (scannedTab) scannedTab.classList.toggle('hidden', target !== 'scanned');
      if (urlTab) urlTab.classList.toggle('hidden', target !== 'url');

      if (target === 'saved') loadSavedCatalog();
      else if (target === 'scanned') loadScannedProducts();
    });
  });

  async function loadSavedCatalog() {
    const list = $('#productModalSavedList');
    if (!list) return;
    const catalog = await getSavedCatalog();
    updateCatalogCount();

    if (!catalog.length) {
      list.innerHTML = `
        <div style="text-align:center; padding:32px 16px;">
          <div style="font-size:36px; margin-bottom:8px;">📦</div>
          <div style="font-weight:600; font-size:14px; color:#e0e0e0;">ยังไม่มีสินค้าในคลัง</div>
          <div style="font-size:12px; color:#888; margin-top:6px; line-height:1.5;">
            ไปสแกนและกด <b>"🔗 ดึงลิงก์ที่เลือก"</b> ที่แท็บ Shopee<br>ระบบจะบันทึกมาเก็บไว้ในคลังนี้ให้อัตโนมัติ
          </div>
          <button id="btnGoToShopeeTab" class="btn btn-primary btn-sm" type="button" style="margin-top:14px;">
            👉 ไปแท็บ Shopee เพื่อดึงสินค้า
          </button>
        </div>`;
      document.getElementById('btnGoToShopeeTab')?.addEventListener('click', () => {
        closeModal();
        document.querySelector('[data-tab="shopee"]')?.click();
      });
      return;
    }

    list.innerHTML = '';
    catalog.forEach(item => {
      const card = document.createElement('div');
      card.className = 'product-modal-item';
      card.style.cssText = 'display:flex; align-items:center; gap:10px; padding:10px; background:#161622; border-radius:8px; border:1px solid rgba(255,255,255,.08); cursor:pointer; margin-bottom:6px;';

      const img = item.imageUrl ? `<img src="${item.imageUrl}" style="width:52px; height:52px; object-fit:cover; border-radius:6px; flex-shrink:0; background:#0d0d1a;">` : `<div style="width:52px; height:52px; background:#222; border-radius:6px; display:flex; align-items:center; justify-content:center; flex-shrink:0;">🛍️</div>`;

      const commBadge = item.commissionRate ? `<span style="background:rgba(16,185,129,.15); color:#10b981; padding:1px 6px; border-radius:4px; font-size:10px; font-weight:600;">คอมฯ ${item.commissionRate}%</span>` : '';

      card.innerHTML = `
        ${img}
        <div style="flex:1; min-width:0;">
          <div style="font-size:12px; font-weight:600; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${item.title || 'สินค้า Shopee'}</div>
          <div style="display:flex; align-items:center; gap:6px; margin-top:2px;">
            <span style="color:#ff6740; font-weight:bold; font-size:13px;">฿${item.price || 0}</span>
            ${commBadge}
          </div>
          <div style="font-size:11px; color:#10b981; font-weight:500; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">🔗 ${item.affiliateUrl || 'ยังไม่มีลิงก์ย่อ'}</div>
        </div>
        <div style="display:flex; flex-direction:column; gap:6px; flex-shrink:0;">
          <button class="btn btn-primary btn-sm pm-use-btn" type="button" style="font-size:11px; padding:4px 10px;">เลือกใช้</button>
          <button class="btn btn-secondary btn-sm pm-del-btn" type="button" style="font-size:11px; padding:4px 8px; color:#f87171; border-color:rgba(239,68,68,.3);" title="ลบออกจากคลัง">🗑️ ลบ</button>
        </div>
      `;

      card.addEventListener('click', (e) => {
        if (e.target.closest('.pm-del-btn')) return;
        selectProduct(item);
      });

      card.querySelector('.pm-del-btn')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = item.offerId || item.title;
        await removeProductFromCatalog(id);
        showToast('🗑️ ลบสินค้าออกจากคลังแล้ว');
        loadSavedCatalog();
      });

      list.appendChild(card);
    });
  }

  // ─── Fetch product from URL ───
  $('#btnProductModalFetch')?.addEventListener('click', async () => {
    const input = $('#productModalUrlInput');
    const url = input?.value?.trim();
    if (!url) { showToast('กรุณาวาง URL'); return; }
    const resultDiv = $('#productModalUrlResult');
    if (resultDiv) resultDiv.innerHTML = '<span class="spinner"></span> กำลังดึงข้อมูล...';

    try {
      const resp = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'PHIMBOT_FETCH_SHOPEE', url }, r => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(r);
        });
      });
      if (resp?.ok) {
        if (resultDiv) {
          resultDiv.innerHTML = '';
          const item = document.createElement('div');
          item.className = 'product-modal-item';
          item.innerHTML = '<img src="' + (resp.images?.[0]?.url || resp.images?.[0] || '') + '" />'
            + '<div style="flex:1;min-width:0;">'
            + '<div class="pm-title">' + (resp.title || '') + '</div>'
            + '<div class="pm-price">฿' + (resp.price || '0') + '</div>'
            + '</div>';
          item.addEventListener('click', () => {
            selectProduct({
              title: resp.title, price: resp.price, imageUrl: resp.images?.[0]?.url || resp.images?.[0] || '',
              affiliateUrl: resp.affiliateUrl || resp.productUrl || '',
              commission: resp.commission || '',
              commissionRate: 0,
            });
          });
          resultDiv.appendChild(item);
        }
      } else {
        if (resultDiv) resultDiv.innerHTML = '<span style="color:#f66;">\u274c ' + (resp?.reason || 'ไม่พบสินค้า') + '</span>';
      }
    } catch (err) {
      if (resultDiv) resultDiv.innerHTML = '<span style="color:#f66;">\u274c ' + err.message + '</span>';
    }
  });

  // ─── Load scanned products ───
  async function loadScannedProducts() {
    const list = $('#productModalScannedList');
    if (!list) return;
    let products = Array.isArray(window.shopeeScannedProducts) && window.shopeeScannedProducts.length ? window.shopeeScannedProducts : [];
    if (!products.length) {
      const stored = await chrome.storage.local.get('phimbot_shopee_scan').catch(() => ({}));
      if (stored?.phimbot_shopee_scan?.items?.length) {
        products = window.shopeeScannedProducts = stored.phimbot_shopee_scan.items;
      }
    }
    if (!products.length) {
      list.innerHTML = '<p style="text-align:center;opacity:.5;font-size:13px;padding:24px 0;">ยังไม่มีสินค้า ไปสแกนที่แท็บ Shopee ก่อน</p>';
      return;
    }
    list.innerHTML = '';
    products.forEach(p => {
      const item = document.createElement('div');
      item.className = 'product-modal-item';
      item.style.cssText = 'display:flex; align-items:center; gap:10px; padding:10px; background:#161622; border-radius:8px; border:1px solid rgba(255,255,255,.08); cursor:pointer; margin-bottom:6px;';
      const hasLink = p.affiliateUrl && !p.affiliateUrl.includes('affiliate.shopee.co.th');
      const linkBadge = hasLink ? '<span style="color:#10b981;font-size:10px;font-weight:600;">🔗 มีลิงก์</span>' : '';
      const commBadge = p.commissionRate ? `<span style="background:rgba(16,185,129,.15); color:#10b981; padding:1px 6px; border-radius:4px; font-size:10px; font-weight:600;">คอมฯ ${p.commissionRate}%</span>` : '';

      item.innerHTML = (p.imageUrl ? `<img src="${p.imageUrl}" style="width:52px; height:52px; object-fit:cover; border-radius:6px; flex-shrink:0; background:#0d0d1a;">` : `<div style="width:52px; height:52px; background:#222; border-radius:6px; display:flex; align-items:center; justify-content:center; flex-shrink:0;">🛍️</div>`)
        + '<div style="flex:1; min-width:0;">'
        + '<div style="font-size:12px; font-weight:600; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + (p.title || '') + '</div>'
        + '<div style="display:flex; align-items:center; gap:6px; margin-top:2px;">'
        + '<span style="color:#ff6740; font-weight:bold; font-size:13px;">฿' + (p.price || 0) + '</span>'
        + commBadge
        + linkBadge
        + '</div>'
        + '<div style="font-size:10px; color:#888; margin-top:2px;">Score: ' + (p.trendScore || 0) + ' | ขายแล้ว ' + (p.sold || 0) + '</div>'
        + '</div>'
        + '<button class="btn btn-primary btn-sm pm-use-btn" type="button" style="font-size:11px; padding:4px 10px; flex-shrink:0;">เลือกใช้</button>';

      item.addEventListener('click', () => {
        selectProduct({
          offerId: p.offerId,
          offerUrl: p.offerUrl,
          title: p.title,
          price: p.price,
          imageUrl: p.imageUrl,
          affiliateUrl: (p.affiliateUrl && !p.affiliateUrl.includes('affiliate.shopee.co.th')) ? p.affiliateUrl : '',
          commissionRate: p.commissionRate || 0,
          commission: p.commissionRate ? p.commissionRate + '%' : '',
          sold: p.sold,
        });
      });
      list.appendChild(item);
    });
  }

  // ─── Event listeners ───
  $('#btnFbReelsPickProduct')?.addEventListener('click', () => openModal('fbReels'));
  $('#btnFbReelsRemoveProduct')?.addEventListener('click', removeProduct);
  $('#btnShopeeVideoPickProduct')?.addEventListener('click', () => openModal('shopeeVideo'));
  $('#btnShopeeVideoRemoveProduct')?.addEventListener('click', removeShopeeVideoProduct);
  $('#btnCloseProductModal')?.addEventListener('click', closeModal);

  // Close modal on overlay click
  $('#fbReelsProductModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'fbReelsProductModal') closeModal();
  });

  // Enter key in URL input
  $('#productModalUrlInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btnProductModalFetch')?.click();
  });
  // Listen for product selection from scanner tab
  window.addEventListener('phimbot-select-product', (e) => {
    if (e.detail) {
      currentProductPickerTarget = 'fbReels';
      selectProduct(e.detail);
    }
  });

  window.addEventListener('phimbot-select-shopee-video-product', (e) => {
    if (e.detail) {
      currentProductPickerTarget = 'shopeeVideo';
      selectProduct(e.detail);
    }
  });


})();













(function() {
const $ = (sel) => document.querySelector(sel);
const showToast = (msg, dur = 3000) => {
  const toast = $('#toast');
  if(toast) {
    toast.textContent = msg;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), dur);
  }
};
const sendMsg = (type, payload) => new Promise((r) => chrome.runtime.sendMessage({ type, payload }, (res) => r(res || {})));
const selectProduct = (p) => { window.dispatchEvent(new CustomEvent('phimbot-select-product', { detail: p })); };

  /* ─── TikTok Showcase API Fetch (Products Tab) ─────────────────────── */
  const btnFetchShowcaseApi = document.getElementById('btnFetchShowcaseApi');
  const btnScanProducts = document.getElementById('btnScanProducts');
  const btnClearProducts = document.getElementById('btnClearProducts');
  const productCount = document.getElementById('productCount');
  const productList = document.getElementById('productList');
  const productSearch = document.getElementById('productSearch');
  const scanStatus = document.getElementById('scanStatus');

  let showcaseProducts = [];

  function renderProductList(products) {
    if (!productList) return;
    if (!products || products.length === 0) {
      productList.innerHTML = '<div class="queue-empty">ยังไม่มีสินค้า กดดึงสินค้าจาก TikTok</div>';
      if (productCount) productCount.textContent = '0';
      return;
    }
    if (productCount) productCount.textContent = String(products.length);
    productList.innerHTML = products.map((p, i) => `
      <div class="product-card" style="display:flex;gap:10px;padding:10px;border-bottom:1px solid rgba(255,255,255,0.06);align-items:center;">
        <img src="${p.imageUrl || ''}" style="width:50px;height:50px;object-fit:cover;border-radius:6px;flex-shrink:0;background:#1a1a2e;" onerror="this.style.display='none'">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.name || 'ไม่มีชื่อ'}</div>
          <div style="font-size:11px;opacity:0.6;margin-top:2px;">ID: ${p.productId} ${p.statusLabel ? '| ' + p.statusLabel : ''}</div>
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0;">
          <button class="btn btn-sm btn-primary" data-action="use" data-idx="${i}" title="ใช้สินค้านี้" style="font-size:11px;padding:4px 8px;">ใช้</button>
          <button class="btn btn-sm btn-outline" data-action="copy-id" data-idx="${i}" title="คัดลอก ID" style="font-size:11px;padding:4px 8px;">ID</button>
          <button class="btn btn-sm btn-outline" data-action="sync-flow" data-idx="${i}" title="ส่งไป Ai SALER PRO" style="font-size:11px;padding:4px 8px;color:#60a5fa;border-color:#3b82f6;">⚡ Flow</button>
        </div>
      </div>
    `).join('');

    productList.onclick = (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const idx = parseInt(btn.dataset.idx);
      const product = products[idx];
      if (!product) return;
      if (btn.dataset.action === 'use') {
        selectProduct(product);
        document.querySelector('[data-tab="post"]')?.click();
        showToast('เลือกสินค้า: ' + (product.name || '').substring(0, 30));
      } else if (btn.dataset.action === 'copy-id') {
        navigator.clipboard.writeText(product.productId).catch(() => {});
        showToast('คัดลอก ID: ' + product.productId);
      } else if (btn.dataset.action === 'sync-flow') {
        syncToAiSalerPro(product);
      }
    };
  }

  async function refreshProducts() {
    const res = await sendMsg('PHIMBOT_GET_PRODUCTS');
    showcaseProducts = res?.products || [];
    renderProductList(showcaseProducts);
  }

  btnFetchShowcaseApi?.addEventListener('click', async () => {
    btnFetchShowcaseApi.disabled = true;
    btnFetchShowcaseApi.innerHTML = '<span class="spinner"></span> กำลังดึงสินค้า...';
    if (scanStatus) { scanStatus.textContent = '⏳ กำลังเรียก TikTok Showcase API...'; scanStatus.classList.remove('hidden'); }

    try {
      const res = await sendMsg('PHIMBOT_FETCH_SHOWCASE_API', { limit: 500, offset: 0 });
      if (res?.success) {
        showcaseProducts = res.products || [];
        renderProductList(showcaseProducts);
        if (scanStatus) { scanStatus.textContent = '✅ ดึงสินค้าสำเร็จ ' + showcaseProducts.length + '/' + (res.total || '?') + ' รายการ'; scanStatus.className = 'status-msg success'; }
        showToast('✅ ดึงสินค้าสำเร็จ ' + showcaseProducts.length + ' รายการ');
      } else {
        const errMsg = res?.error || 'ดึงสินค้าไม่สำเร็จ';
        const isLoginErr = /log\s*in|เข้าสู่ระบบ|auth|api fetch failed|ล็อกอิน/i.test(errMsg);
        if (scanStatus) {
          if (isLoginErr) {
            scanStatus.innerHTML = `❌ ยังไม่ได้ล็อกอิน TikTok <button id="btnScanLoginPrompt" style="margin-left:8px; font-size:11px; padding:3px 8px; background:#ff0050; color:#fff; border:none; border-radius:4px; cursor:pointer; font-weight:600;">🔑 ไปหน้าล็อกอิน</button>`;
            $('#btnScanLoginPrompt')?.addEventListener('click', () => {
              chrome.tabs.create({ url: 'https://www.tiktok.com/login?redirect_url=https%3A%2F%2Fwww.tiktok.com%2Ftiktokstudio%2Fupload', active: true });
            });
          } else {
            scanStatus.textContent = '❌ ' + errMsg;
          }
          scanStatus.className = 'status-msg error';
        }
        showToast(isLoginErr ? '⚠️ กรุณาล็อกอิน TikTok ก่อนดึงสินค้า' : '❌ ' + errMsg);
      }
    } catch (err) {
      if (scanStatus) { scanStatus.textContent = '❌ ' + err.message; scanStatus.className = 'status-msg error'; }
    }
    btnFetchShowcaseApi.disabled = false;
    btnFetchShowcaseApi.innerHTML = '🚀 ดึงสินค้า (API)';
  });

  btnClearProducts?.addEventListener('click', async () => {
    showcaseProducts = [];
    await chrome.storage.local.set({ phimbot_products: [] });
    renderProductList([]);
    if (scanStatus) { scanStatus.textContent = ''; scanStatus.classList.add('hidden'); }
    showToast('ล้างรายการสินค้าแล้ว');
  });

  productSearch?.addEventListener('input', () => {
    const q = (productSearch.value || '').trim().toLowerCase();
    if (!q) { renderProductList(showcaseProducts); return; }
    const filtered = showcaseProducts.filter((p) => 
      (p.name || '').toLowerCase().includes(q) || (p.productId || '').includes(q)
    );
    renderProductList(filtered);
  });

  /* ═══════════════════════════════════════════════════════════════
     Ai SALER PRO (Google Flow) — Matrix-Certified Integration Bridge
     ═══════════════════════════════════════════════════════════════ */
  const FLOW_TOOL_STATES = {
    idle: { label: 'พร้อมรับข้อมูล (idle)', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)' },
    data_ready: { label: 'ข้อมูลเข้าแล้ว รอระดมสมอง (data_ready)', color: '#22c55e', bg: 'rgba(34, 197, 94, 0.15)' },
    brainstorming: { label: 'กำลังคิดคอนเทนต์... (brainstorming)', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.15)' },
    ready_to_factory: { label: 'ไอเดียพร้อม สั่งผลิตได้ (ready_to_factory)', color: '#a855f7', bg: 'rgba(168, 85, 247, 0.15)' },
    factory_running: { label: 'กำลังผลิตวิดีโอ... (factory_running)', color: '#ef4444', bg: 'rgba(239, 68, 68, 0.15)' }
  };

  async function urlToBase64(url) {
    if (!url || typeof url !== 'string' || url.startsWith('data:')) return url;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return url;
      const blob = await res.blob();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result || url);
        reader.onerror = () => resolve(url);
        reader.readAsDataURL(blob);
      });
    } catch {
      return url;
    }
  }

  async function formatProductForAiSalerPro(p) {
    if (!p) return null;
    const name = p.name || p.title || 'สินค้า';
    const rawId = String(p.productId || p.tiktokProductId || p.offerId || p.itemId || p.id || '')
      .trim()
      .replace(/^(PID_)?UNKNOWN$/i, '')
      .replace(/^PID_/i, '')
      .trim();
    const tiktokProductId = rawId || '';
    const productUrl = p.affiliateUrl || p.productUrl || p.offerUrl || p.url || p.link || '';

    // Keywords
    let keywords = '';
    if (Array.isArray(p.keywords)) {
      keywords = p.keywords.join(', ');
    } else if (p.keywords) {
      keywords = String(p.keywords);
    } else if (Array.isArray(p.sellingPoints)) {
      keywords = p.sellingPoints.join(', ');
    } else if (p.sellingPoints) {
      keywords = String(p.sellingPoints);
    } else {
      const words = name.replace(/[^\w\s\u0E00-\u0E7F]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .slice(0, 6);
      keywords = words.join(', ');
    }

    // Images / Assets
    let rawUrls = [];
    if (Array.isArray(p.assets) && p.assets.length) {
      rawUrls = p.assets.map((a) => (typeof a === 'string' ? a : a.url)).filter(Boolean);
    } else if (Array.isArray(p.images) && p.images.length) {
      rawUrls = p.images.map((img) => (typeof img === 'string' ? img : (img.url || img.imageUrl || ''))).filter(Boolean);
    } else {
      const single = p.imageUrl || p.image || p.coverUrl || p.img || '';
      if (single) rawUrls.push(single);
    }

    // Process assets: convert up to 2 main images in parallel to base64 Data URLs for fast Flow.upload()
    const assets = await Promise.all(rawUrls.slice(0, 2).map(async (u) => {
      if (!u.startsWith('data:')) {
        const b64 = await urlToBase64(u);
        return { url: b64, base64: b64 };
      }
      return { url: u, base64: u };
    }));

    return {
      name,
      tiktokProductId,
      productUrl,
      keywords,
      assets
    };
  }

  async function buildAiSalerProPayload(items) {
    const list = Array.isArray(items) ? items.filter(Boolean) : [items].filter(Boolean);
    const formattedProducts = [];
    for (const p of list) {
      const f = await formatProductForAiSalerPro(p);
      if (f) formattedProducts.push(f);
    }

    // Character image from Factory if available
    let charImg = '';
    const firstCharInDom = document.querySelector('#factoryCharGrid img')?.getAttribute('src');
    if (firstCharInDom && firstCharInDom.startsWith('data:')) {
      charImg = firstCharInDom;
    }

    // Mode
    const activeModeBtn = document.querySelector('.factory-mode-btn.active');
    const productionMode = activeModeBtn?.dataset.mode || 'influencer';

    // Voice gender
    const activeVoiceBtn = document.querySelector('.factory-voice-btn.active');
    const gender = activeVoiceBtn?.dataset.voice
      || document.getElementById('metaAiCharGender')?.value
      || window.__phimbotFactoryVoice
      || 'female';

    const ideaEl = document.getElementById('factoryIdeaCount');
    const sceneEl = document.getElementById('factorySceneCount');
    const durEl = document.getElementById('factoryDuration');
    const imgEl = document.getElementById('factoryImageModel');
    const vidEl = document.getElementById('factoryVideoModel');
    const styleEl = document.getElementById('factoryContentStyle');

    const ideaCount = ideaEl && ideaEl.value ? parseInt(ideaEl.value, 10) : 1;
    const sceneCount = sceneEl && sceneEl.value ? parseInt(sceneEl.value, 10) : 1;
    const duration = durEl && durEl.value ? parseInt(durEl.value, 10) : 8;
    const contentStyle = styleEl?.value || 'influencer_review';

    const STYLE_HINTS = {
      influencer_review: 'สไตล์รีวิวอินฟลูเอนเซอร์ป้ายยา เป็นธรรมชาติ น่าเชื่อถือ',
      viral_hook: 'สไตล์ฮุกไวรัลหยุดนิ้วใน 3 วินาทีแรก ตื่นเต้นเร้าใจ',
      problem_solver: 'สไตล์ขยี้ปัญหาแล้วเฉลยทางออกด้วยสินค้านี้ ชัดเจนตรงจุด',
      hot_deal: 'สไตล์โปรเด็ดนาทีทองเร่งตัดสินใจ คุ้มค่าห้ามพลาด',
      pro_showcase: 'สไตล์โชว์สินค้าพรีเมียม หรูหรา เน้นดีเทลชัดระดับสตูดิโอ'
    };
    const styleHint = STYLE_HINTS[contentStyle] || STYLE_HINTS.influencer_review;

    for (const prod of formattedProducts) {
      if (prod.keywords && !prod.keywords.includes(styleHint)) {
        prod.keywords = `${prod.keywords}, ${styleHint}`;
      } else if (!prod.keywords) {
        prod.keywords = styleHint;
      }
    }

    return {
      gender: gender,
      voiceGender: gender,
      settings: {
        imageModel: imgEl?.value || '🍌 Nano Banana 2.1',
        videoModel: vidEl?.value || 'Omni 1.1 Flash',
        duration: String(duration),
        durationSeconds: duration,
        campaignCount: ideaCount,
        targetSetCount: ideaCount,
        ideaCount: ideaCount,
        sceneCount: sceneCount,
        scenes: sceneCount,
        productionMode: productionMode,
        gender: gender,
        voiceGender: gender,
        contentStyle: contentStyle,
        styleHint: styleHint
      },
      strategy: {
        voiceGender: gender
      },
      influencer: {
        name: 'น้องเอไอ',
        gender: gender,
        voiceGender: gender,
        url: charImg || '',
        image: charImg || ''
      },
      products: formattedProducts
    };
  }

  // Direct injection into Google Flow tabs (PostMessage + Clipboard + DOM inputs + SYNC MATRIX trigger)
  async function sendDataToFlowTool(injectPayload) {
    const DEFAULT_FLOW_TOOL_URL = 'https://flow.google.com/shared/tool/9e80057a-5cea-4b08-99d4-a9bfea111099';
    let allTabs = await chrome.tabs.query({});
    let tabs = allTabs.filter((t) => t.url && (t.url.includes('flow.google.com') || t.url.includes('labs.google')));

    const existingToolTab = tabs.find((t) => t.url && t.url.includes('/tool/') && !t.url.includes('4365c4fb-023d-40be-82e6-8b4d0d080c4c'));
    if (existingToolTab?.url && existingToolTab.url.includes('/project/')) {
      try { await chrome.storage.local.set({ phimbot_flow_tool_url: existingToolTab.url }); } catch (_) {}
    } else if (!tabs.some((t) => t.url && t.url.includes('/tool/') && !t.url.includes('4365c4fb-023d-40be-82e6-8b4d0d080c4c'))) {
      const stFlow = await chrome.storage.local.get(['phimbot_flow_tool_url']).catch(() => ({}));
      const savedUrl = String(stFlow?.phimbot_flow_tool_url || '');
      const targetUrl = (savedUrl && !savedUrl.includes('4365c4fb-023d-40be-82e6-8b4d0d080c4c')) ? savedUrl : DEFAULT_FLOW_TOOL_URL;
      if (tabs.length > 0) {
        await chrome.tabs.update(tabs[0].id, { url: targetUrl });
        // Close duplicate plain flow.google.com home tabs if more than 1
        for (let ti = 1; ti < tabs.length; ti++) {
          if (tabs[ti].url === 'https://flow.google.com/') {
            try { await chrome.tabs.remove(tabs[ti].id); } catch (_) {}
          }
        }
      } else {
        await chrome.tabs.create({ url: targetUrl, active: false });
      }
      for (let w = 0; w < 16; w++) {
        await new Promise((r) => setTimeout(r, 1000));
        allTabs = await chrome.tabs.query({});
        tabs = allTabs.filter((t) => t.url && (t.url.includes('flow.google.com') || t.url.includes('labs.google')));
        if (tabs.some((t) => t.status === 'complete' && t.url?.includes('/tool/'))) break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (!tabs || tabs.length === 0) {
      return { success: false, reason: 'no_tabs' };
    }

    // Ensure shared tool ("Try in a project" -> select project -> "Open" -> "Done") is entered and app iframe is mounted
    try {
      const targetTab = tabs.find((t) => t.url && t.url.includes('/tool/')) || tabs[0];
      if (targetTab?.id) {
        await sendMsg('PHIMBOT_ENSURE_FLOW_TOOL_READY', { tabId: targetTab.id });
        allTabs = await chrome.tabs.query({});
        tabs = allTabs.filter((t) => t.url && (t.url.includes('flow.google.com') || t.url.includes('labs.google')));
      }
    } catch (_) {}

    // 0. Update Clipboard with the EXACT payload and root-level counts
    const s = injectPayload.settings || {};
    const resolvedGender = injectPayload.influencer?.gender || s.gender || s.voiceGender || injectPayload.gender || 'female';
    const campaignCount = Number(s.campaignCount || 1);
    const sceneCount = Number(s.sceneCount || 1);
    const clipboardObj = {
      ...injectPayload,
      name: injectPayload.products?.[0]?.name || '',
      tiktokProductId: injectPayload.products?.[0]?.tiktokProductId || '',
      keywords: injectPayload.products?.[0]?.keywords || '',
      assets: injectPayload.products?.[0]?.assets || [],
      campaignCount: campaignCount,
      sceneCount: sceneCount,
      targetSetCount: campaignCount,
      ideaCount: campaignCount,
      scenes: sceneCount,
      duration: Number(s.duration || 8),
      durationSeconds: Number(s.duration || 8),
      imageModel: s.imageModel || '🍌 Nano Banana 2.1',
      videoModel: s.videoModel || 'Omni 1.1 Flash',
      productionMode: s.productionMode || 'influencer',
      gender: resolvedGender,
      voiceGender: resolvedGender,
      contentStyle: s.contentStyle || 'influencer_review',
      styleHint: s.styleHint || ''
    };
    const clipText = JSON.stringify(clipboardObj, null, 2);

    try {
      await navigator.clipboard.writeText(clipText);
    } catch (clipErr) {
      try {
        const ta = document.createElement('textarea');
        ta.value = clipText;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (_) {}
    }

    const toolTabsOnly = tabs.filter((t) => t.url && t.url.includes('/tool/'));
    if (toolTabsOnly.length > 0) {
      tabs = toolTabsOnly;
    }

    let lastResult = null;
    for (const tab of tabs) {
      try {
        const results = await Promise.race([
          chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            world: 'MAIN',
            func: (payloadData, clipObj, clipStr) => {
            let foundElement = false;

            // Expose on window for direct access by Tool scripts
            window.__PHIMBOT_INJECTED_PAYLOAD__ = payloadData;
            window.__PHIMBOT_CLIPBOARD_DATA__ = clipObj;
            window.campaignCount = clipObj.campaignCount;
            window.sceneCount = clipObj.sceneCount;
            try { navigator.clipboard.writeText(clipStr).catch(() => {}); } catch (_) {}

            if (typeof window.processInjectedData === 'function') {
              try { window.processInjectedData(payloadData); } catch (_) {}
            }

            // 1. PostMessage to window and all iframes with standard event names
            const eventMsg1 = { type: 'EXT_INJECT_DATA', payload: payloadData, data: clipObj };
            const eventMsg2 = { type: 'SYNC_MATRIX_DATA', payload: payloadData, data: clipObj };
            window.postMessage(eventMsg1, '*');
            window.postMessage(eventMsg2, '*');

            document.querySelectorAll('iframe').forEach((f) => {
              try {
                f.contentWindow.postMessage(eventMsg1, '*');
                f.contentWindow.postMessage(eventMsg2, '*');
              } catch (_) {}
            });

            // 2. Direct DOM injection into inputs using React-aware property setters
            const injectDoc = (doc) => {
              if (!doc) return;
              try {
                // Inject clean spacing/padding CSS inside the Ai SALER PRO iframe so elements aren't cramped
                if ((location.href.includes('usercontent.goog') || doc.title?.includes('SALER') || doc.title?.includes('Flow app') || doc.getElementById('tiktok-product-id')) && (doc.head || doc.documentElement) && !doc.getElementById('phimbot-flow-tool-spacing-fix')) {
                  const st = doc.createElement('style');
                  st.id = 'phimbot-flow-tool-spacing-fix';
                  st.textContent = `
                    body { padding: 14px 18px !important; box-sizing: border-box !important; }
                    section, .card, [class*="card"], [class*="panel"] { margin-bottom: 14px !important; }
                    button, select, input, textarea { margin-top: 3px !important; margin-bottom: 3px !important; }
                    h1, h2, h3, h4 { margin-top: 6px !important; margin-bottom: 6px !important; line-height: 1.35 !important; }
                    [class*="aspect-[9/16]"] { max-height: 44vh !important; width: auto !important; margin-top: 36px !important; margin-bottom: 12px !important; }
                  `;
                  (doc.head || doc.documentElement).appendChild(st);
                }

                const setVal = (el, val) => {
                  if (el && val !== undefined) {
                    try {
                      const tag = (el.tagName || '').toUpperCase();
                      const win = el.ownerDocument?.defaultView || window;
                      const proto = tag === 'SELECT'
                        ? win.HTMLSelectElement?.prototype
                        : (tag === 'TEXTAREA' ? win.HTMLTextAreaElement?.prototype : (tag === 'INPUT' ? win.HTMLInputElement?.prototype : null));
                      const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
                      if (setter) {
                        setter.call(el, String(val));
                      } else if ('value' in el) {
                        el.value = String(val);
                      }
                      el.dispatchEvent(new Event('input', { bubbles: true }));
                      el.dispatchEvent(new Event('change', { bubbles: true }));
                      el.dispatchEvent(new Event('blur', { bubbles: true }));
                      foundElement = true;
                    } catch (_) {
                      try {
                        el.value = String(val);
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        foundElement = true;
                      } catch (__) {}
                    }
                  }
                };

                const findAndSet = (id, val) => {
                  const el = doc.getElementById(id) || doc.querySelector(`[name="${id}"]`) || doc.querySelector(`[data-id="${id}"]`);
                  if (el) setVal(el, val);
                };

                // Specific IDs
                findAndSet('setting-image-model', clipObj.imageModel);
                findAndSet('setting-video-model', clipObj.videoModel);
                findAndSet('setting-duration', clipObj.duration);
                findAndSet('setting-campaign-count', clipObj.campaignCount);
                findAndSet('setting-scene-count', clipObj.sceneCount);
                findAndSet('campaign-count', clipObj.campaignCount);
                findAndSet('scene-count', clipObj.sceneCount);
                findAndSet('target-set-count', clipObj.campaignCount);

                // Generic scan for any input/select related to campaign or scene count
                doc.querySelectorAll('input, select').forEach((el) => {
                  const id = (el.id || '').toLowerCase();
                  const name = (el.name || '').toLowerCase();
                  const ph = (el.placeholder || '').toLowerCase();
                  const aria = (el.getAttribute('aria-label') || '').toLowerCase();

                  if (id.includes('campaign') || name.includes('campaign') || ph.includes('campaign') || aria.includes('campaign') || id.includes('idea') || ph.includes('ไอเดีย')) {
                    setVal(el, clipObj.campaignCount);
                  }
                  if (id.includes('scene') || name.includes('scene') || ph.includes('scene') || aria.includes('scene') || id.includes('ฉาก') || ph.includes('ฉาก')) {
                    setVal(el, clipObj.sceneCount);
                  }
                });

                if (payloadData.products?.[0]) {
                  const p = payloadData.products[0];
                  findAndSet('active-product-name', p.name);
                  findAndSet('tiktok-product-id', p.tiktokProductId);
                  findAndSet('global-tiktok-id', p.tiktokProductId);
                  const pidInput = doc.querySelector('input[placeholder*="PID_"]');
                  if (pidInput) setVal(pidInput, p.tiktokProductId);
                }

                if (payloadData.influencer) {
                  findAndSet('character-name-0', payloadData.influencer.name);
                }

                // Trigger sync button (either SYNC MATRIX DATA, #sync-matrix-data, or #sync-from-extension)
                const syncBtns = Array.from(doc.querySelectorAll('button, [role="button"]'));
                const targetSyncBtn = doc.getElementById('sync-matrix-data') ||
                                     doc.getElementById('sync-from-extension') ||
                                     doc.querySelector('[data-action="sync-matrix-data"]') ||
                                     doc.querySelector('[data-action="sync-from-extension"]') ||
                                     syncBtns.find((b) => {
                                       const txt = (b.innerText || '').toUpperCase();
                                       return txt.includes('SYNC FROM EXTENSION') || txt.includes('SYNC MATRIX');
                                     });
                if (targetSyncBtn) {
                  targetSyncBtn.click();
                  foundElement = true;
                }

                // Ensure the gender button ("ชาย (ครับ)" or "หญิง (ค่ะ)") is clicked in Tool UI
                const gTarget = payloadData.influencer?.gender || clipObj.gender || 'female';
                const clickGenderInDoc = () => {
                  const matchText = gTarget === 'male' ? /ชาย\s*\(ครับ\)|^ชาย$/i : /หญิง\s*\(ค่ะ\)|^หญิง$/i;
                  const allBtns = Array.from(doc.querySelectorAll('button, [role="button"], [role="tab"]'));
                  for (const b of allBtns) {
                    const txt = (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim();
                    if (matchText.test(txt)) {
                      b.click();
                      foundElement = true;
                    }
                  }
                };
                clickGenderInDoc();
                setTimeout(clickGenderInDoc, 400);
                setTimeout(clickGenderInDoc, 1000);
              } catch (e) {
                injectError = e?.message || String(e);
              }
            };

            let injectError = null;
            injectDoc(document);
            document.querySelectorAll('iframe').forEach((f) => {
              try { injectDoc(f.contentDocument); } catch (_) {}
            });

            // 3. Read data-state from root
            const stateEl = document.querySelector('[data-state]');
            const state = stateEl ? stateEl.getAttribute('data-state') : null;

            return {
              url: location.href,
              foundElement,
              injectError,
              state: state || 'idle'
            };
          },
          args: [injectPayload, clipboardObj, clipText]
          }),
          new Promise((r) => setTimeout(() => r([]), 5000))
        ]);

        if (results && results.length > 0) {
          const valid = results.find((r) => r.result?.foundElement) || results.find((r) => r.result?.state && r.result.state !== 'idle');
          if (valid?.result) {
            lastResult = { ...valid.result, framesCount: results.length };
          } else if (!lastResult) {
            lastResult = { ...(results[0]?.result || {}), framesCount: results.length, allFrames: results.map(r => r.result) };
          }
        }
      } catch (err) {
        console.warn('[FlowBridge] executeScript error on tab ' + tab.id, err);
      }
    }

    return { success: true, detail: lastResult };
  }

  // Trigger Action in Flow Tool (e.g. brainstorm-batch, start-factory, clear-product-queue, sync-matrix-data)
  async function triggerFlowToolAction(actionId) {
    const allTabs = await chrome.tabs.query({});
    const tabs = allTabs.filter((t) => t.url && (t.url.includes('flow.google.com') || t.url.includes('labs.google')));

    if (!tabs || tabs.length === 0) {
      showToast('⚠️ ไม่พบแท็บ Google Flow ที่เปิดอยู่ — กรุณาเปิด Google Flow ก่อน');
      return false;
    }

    let triggered = false;
    let finalState = null;

    for (const tab of tabs) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          world: 'MAIN',
          func: (btnId) => {
            const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
            const cleanId = btnId.toUpperCase().replace(/[-_]/g, ' ');
            const el = document.getElementById(btnId) ||
                       document.querySelector(`[data-action="${btnId}"]`) ||
                       allButtons.find((b) => (b.innerText || '').toUpperCase().includes(cleanId));
            let clicked = false;
            if (el) {
              el.click();
              clicked = true;
            }
            const stateEl = document.querySelector('[data-state]');
            return {
              clicked,
              state: stateEl ? stateEl.getAttribute('data-state') : null
            };
          },
          args: [actionId]
        });

        if (results) {
          const match = results.find((r) => r.result?.clicked);
          if (match) {
            triggered = true;
            finalState = match.result.state;
            break;
          }
        }
      } catch (e) {
        console.warn('[FlowBridge] Action error:', e);
      }
    }

    if (triggered) {
      updateFlowToolStateUI(finalState);
      const actionNames = {
        'brainstorm-batch': '💡 สั่ง Brainstorm Batch ใน Ai SALER PRO แล้ว!',
        'start-factory': '🚀 สั่ง Start Factory ใน Ai SALER PRO แล้ว!',
        'clear-product-queue': '🗑️ ล้างคิวสินค้าใน Ai SALER PRO แล้ว!',
        'sync-from-extension': '⚡ สั่ง Sync from Extension แล้ว!',
        'sync-matrix-data': '⚡ สั่ง SYNC MATRIX DATA แล้ว!'
      };
      showToast(actionNames[actionId] || `⚡ สั่งการ ${actionId} สำเร็จ!`);
      return true;
    } else {
      showToast(`⚠️ ส่งคำสั่งแล้ว (ไม่พบปุ่ม #${actionId} ในแท็บหลัก — กรุณาเปิดหน้าจอ Tool)`);
      return false;
    }
  }

  function updateFlowToolStateUI(state) {
    const badge = $('#flowToolStateBadge');
    if (!badge) return;
    const info = FLOW_TOOL_STATES[state] || { label: state || 'idle', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)' };
    badge.textContent = info.label;
    badge.style.color = info.color;
    badge.style.background = info.bg;
    badge.style.border = `1px solid ${info.color}55`;
  }

  async function checkFlowToolStatus() {
    const badge = $('#flowToolStateBadge');
    if (badge) badge.textContent = 'กำลังตรวจสอบ...';

    const allTabs = await chrome.tabs.query({});
    const tabs = allTabs.filter((t) => t.url && (t.url.includes('flow.google.com') || t.url.includes('labs.google')));

    if (!tabs || tabs.length === 0) {
      if (badge) {
        badge.textContent = 'ไม่ได้เปิดแท็บ Flow';
        badge.style.background = 'rgba(239,68,68,0.15)';
        badge.style.color = '#f87171';
        badge.style.border = '1px solid rgba(239,68,68,0.3)';
      }
      return null;
    }

    let detectedState = 'idle';
    for (const tab of tabs) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          world: 'MAIN',
          func: () => {
            const stateEl = document.querySelector('[data-state]');
            return stateEl ? stateEl.getAttribute('data-state') : null;
          }
        });
        const match = results?.find((r) => r.result);
        if (match && match.result) {
          detectedState = match.result;
          break;
        }
      } catch (_) {}
    }

    updateFlowToolStateUI(detectedState);
    return detectedState;
  }

  // Tool DOM & Code Inspector: Scans Google Flow and copies report to Clipboard
  async function inspectFlowToolDOM() {
    showToast('🔍 กำลังดึงข้อมูล DOM และโค้ดจาก Google Flow...');
    const allTabs = await chrome.tabs.query({});
    const tabs = allTabs.filter((t) => t.url && (t.url.includes('flow.google.com') || t.url.includes('labs.google')));

    if (!tabs || tabs.length === 0) {
      showToast('⚠️ ไม่พบแท็บ Google Flow ที่เปิดอยู่ — กรุณาเปิดหน้า Google Flow');
      return;
    }

    const reports = [];
    for (const tab of tabs) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          world: 'MAIN',
          func: () => {
            const frameInfo = {
              url: location.href,
              title: document.title,
              dataState: document.querySelector('[data-state]')?.getAttribute('data-state') || null,
              buttons: [],
              inputs: [],
              iframes: []
            };

            // Buttons
            document.querySelectorAll('button, [role="button"]').forEach((b) => {
              const text = (b.innerText || b.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 60);
              if (text || b.id) {
                frameInfo.buttons.push({
                  id: b.id || null,
                  text: text,
                  dataAction: b.getAttribute('data-action') || null,
                  className: (b.className || '').toString().substring(0, 40)
                });
              }
            });

            // Inputs
            document.querySelectorAll('input, textarea, select').forEach((inp) => {
              frameInfo.inputs.push({
                tag: inp.tagName.toLowerCase(),
                id: inp.id || null,
                placeholder: inp.placeholder || null,
                value: inp.value ? inp.value.substring(0, 50) : '',
                type: inp.type || null
              });
            });

            // Iframes
            document.querySelectorAll('iframe').forEach((ifr) => {
              frameInfo.iframes.push({
                id: ifr.id || null,
                src: ifr.src ? ifr.src.substring(0, 100) : null
              });
            });

            return frameInfo;
          }
        });

        if (results && results.length) {
          reports.push({
            tabId: tab.id,
            tabUrl: tab.url,
            frames: results.map((r) => r.result).filter(Boolean)
          });
        }
      } catch (err) {
        console.warn('[FlowInspector] Scan error:', err);
      }
    }

    const jsonReport = JSON.stringify(reports, null, 2);
    await navigator.clipboard.writeText(jsonReport);
    console.log('[FlowToolInspector] Report copied to clipboard:', reports);
    showToast('📋 คัดลอกข้อมูล DOM ของ Tool ลง Clipboard แล้ว! (นำมา Paste ให้ AI ตรวจสอบได้เลย)', 6000);
  }

  function getFactoryProducts() {
    if (Array.isArray(window.__phimbotFactoryProducts) && window.__phimbotFactoryProducts.length > 0) {
      return window.__phimbotFactoryProducts;
    }
    if (Array.isArray(factoryProducts) && factoryProducts.length > 0) {
      return factoryProducts;
    }
    return [];
  }

  async function syncToAiSalerPro(items) {
    if (!items) {
      showToast('⚠️ กรุณาเลือกสินค้าก่อนซิงค์');
      return;
    }
    const list = Array.isArray(items) ? items.filter(Boolean) : [items].filter(Boolean);
    if (list.length === 0) {
      showToast('⚠️ ไม่มีสินค้าให้ซิงค์');
      return;
    }

    showToast(`⏳ กำลังเตรียมข้อมูล ${list.length} รายการสำหรับ Ai SALER PRO...`, 2000);

    try {
      const fullPayload = await buildAiSalerProPayload(list);
      if (!fullPayload.products || fullPayload.products.length === 0) {
        showToast('⚠️ ไม่พบข้อมูลสินค้าที่ถูกต้อง');
        return;
      }

      // Hybrid clipboard format: both full structure and top-level fields for universal compatibility
      const clipboardObj = {
        ...fullPayload,
        name: fullPayload.products[0]?.name,
        tiktokProductId: fullPayload.products[0]?.tiktokProductId,
        keywords: fullPayload.products[0]?.keywords,
        assets: fullPayload.products[0]?.assets
      };

      const jsonStr = JSON.stringify(clipboardObj, null, 2);
      await navigator.clipboard.writeText(jsonStr);

      // Attempt Direct postMessage & DOM injection
      const injectRes = await sendDataToFlowTool(fullPayload);

      if (injectRes.success) {
        const state = injectRes.detail?.state || 'data_ready';
        updateFlowToolStateUI(state);
        const stateDesc = FLOW_TOOL_STATES[state]?.label || state;
        showToast(`⚡ ส่งข้อมูลเข้า Ai SALER PRO แล้ว! (${stateDesc})`, 5000);
      } else {
        showToast(`⚡ คัดลอก ${fullPayload.products.length} รายการลง Clipboard แล้ว! เปิด Flow แล้วกด "SYNC MATRIX DATA" ได้ทันที`, 5000);
      }
    } catch (err) {
      console.error('[AiSalerPro Sync] Error:', err);
      showToast('❌ ซิงค์ข้อมูลไม่สำเร็จ: ' + err.message);
    }
  }

  // 1) Selected Product Card sync button
  $('#btnSyncSelectedToFlow')?.addEventListener('click', async () => {
    const selProd = typeof selectedProduct !== 'undefined' ? selectedProduct : window.__phimbotSelectedProduct;
    const selProds = typeof selectedProducts !== 'undefined' ? selectedProducts : window.__phimbotSelectedProducts;
    if (selProd) {
      syncToAiSalerPro(selProd);
    } else if (selProds && selProds.length) {
      syncToAiSalerPro(selProds);
    } else if (showcaseProducts && showcaseProducts.length) {
      syncToAiSalerPro(showcaseProducts[0]);
    } else {
      const st = await chrome.storage.local.get(['phimbot_products']).catch(() => ({}));
      if (st?.phimbot_products?.length) {
        syncToAiSalerPro(st.phimbot_products[0]);
      } else {
        showToast('⚠️ กรุณาเลือกสินค้าก่อนซิงค์');
      }
    }
  });

  // 2) Tab Products "Sync All" button
  $('#btnSyncAllToFlow')?.addEventListener('click', async () => {
    if (showcaseProducts && showcaseProducts.length) {
      syncToAiSalerPro(showcaseProducts);
    } else {
      const st = await chrome.storage.local.get(['phimbot_products']).catch(() => ({}));
      if (st?.phimbot_products?.length) {
        syncToAiSalerPro(st.phimbot_products);
      } else {
        showToast('⚠️ ไม่มีสินค้าในรายการ กรุณาดึงสินค้าจาก TikTok ก่อน');
      }
    }
  });

  // 3) Tab Shopee sync button
  $('#btnShopeeSyncFlow')?.addEventListener('click', () => {
    const curShopee = typeof currentShopeeProduct !== 'undefined' ? currentShopeeProduct : window.__phimbotCurrentShopeeProduct;
    if (curShopee) {
      syncToAiSalerPro({
        name: curShopee.title || curShopee.name || 'Shopee Product',
        productId: curShopee.offerId || curShopee.itemId || curShopee.productId || 'SHOPEE',
        keywords: curShopee.keywords || (curShopee.title ? curShopee.title.split(' ').slice(0, 5).join(', ') : ''),
        images: curShopee.images || (curShopee.imageUrl ? [curShopee.imageUrl] : [])
      });
    } else {
      showToast('⚠️ กรุณาดึงข้อมูลสินค้า Shopee ก่อนซิงค์');
    }
  });

  // 4) Tab Factory queue & sync button
  let factoryProducts = [];
  const factoryProductQueue = $('#factoryProductQueue');
  const btnAddFactoryProduct = $('#btnAddFactoryProduct');

  function renderFactoryQueue() {
    if (!factoryProductQueue) return;
    const currentList = getFactoryProducts();
    if (!currentList.length) {
      factoryProductQueue.innerHTML = '<span style="font-size:11px;color:var(--text-dim);">ยังไม่มีสินค้าในคิว</span>';
      return;
    }
    factoryProductQueue.innerHTML = currentList.map((p, i) => `
      <div style="display:flex;align-items:center;gap:6px;background:rgba(255,255,255,0.06);padding:4px 8px;border-radius:6px;font-size:11px;border:1px solid rgba(255,255,255,0.1);">
        <img src="${p.imageUrl || (p.images && p.images[0]) || ''}" style="width:22px;height:22px;object-fit:cover;border-radius:3px;background:#1a1a2e;" onerror="this.style.display='none'">
        <span style="max-width:110px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.name || p.title || 'สินค้า'}</span>
        <button data-remove-factory="${i}" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:13px;padding:0 2px;line-height:1;" title="ลบออก">&times;</button>
      </div>
    `).join('');

    factoryProductQueue.querySelectorAll('[data-remove-factory]').forEach((b) => {
      b.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.dataset.removeFactory);
        if (Array.isArray(window.__phimbotFactoryProducts)) {
          window.__phimbotFactoryProducts.splice(idx, 1);
        }
        factoryProducts.splice(idx, 1);
        renderFactoryQueue();
      });
    });
  }

  $('#btnFactorySyncFlow')?.addEventListener('click', async () => {
    const list = getFactoryProducts();
    const selProd = typeof selectedProduct !== 'undefined' ? selectedProduct : window.__phimbotSelectedProduct;
    if (list && list.length) {
      syncToAiSalerPro(list);
    } else if (selProd) {
      syncToAiSalerPro(selProd);
    } else if (showcaseProducts && showcaseProducts.length) {
      syncToAiSalerPro(showcaseProducts);
    } else {
      const st = await chrome.storage.local.get(['phimbot_products']).catch(() => ({}));
      if (st?.phimbot_products?.length) {
        syncToAiSalerPro(st.phimbot_products);
      } else {
        showToast('⚠️ กรุณาเพิ่มสินค้าเข้าคิวโรงงานก่อนซิงค์');
      }
    }
  });

  // 5) Tool Remote Controls & Inspector
  $('#btnFactoryClearFlowQueue')?.addEventListener('click', async () => {
    factoryProducts = [];
    if (Array.isArray(window.__phimbotFactoryProducts)) {
      window.__phimbotFactoryProducts = [];
    }
    renderFactoryQueue();
    await triggerFlowToolAction('clear-product-queue');
  });

  $('#btnTriggerFlowBrainstorm')?.addEventListener('click', () => {
    triggerFlowToolAction('brainstorm-batch');
  });

  $('#btnTriggerFlowStartFactory')?.addEventListener('click', () => {
    triggerFlowToolAction('start-factory');
  });

  $('#btnCheckFlowState')?.addEventListener('click', () => {
    checkFlowToolStatus();
  });

  $('#btnInspectFlowDOM')?.addEventListener('click', async () => {
    await inspectFlowToolDOM();
    // Also trigger background code extraction to local bridge if available
    try {
      chrome.runtime.sendMessage({ type: 'ANTIGRAVITY_EXEC_CMD', cmd: 'FLOW_EXTRACT_CODE', args: {} }, (res) => {
        if (res?.ok && res?.fileCount > 0) {
          showToast(`📦 ดึงซอร์สโค้ด Tool สำเร็จ (${res.fileCount} ไฟล์: ${res.fileNames.join(', ')})`, 5000);
        }
      });
    } catch (_) {}
  });

  async function upgradeFlowToolInBrowser() {
    const upgradePrompt = `กรุณาอัปเกรดโค้ด ProductionMonitor.tsx, App.tsx และ BatchManager.tsx ให้สมบูรณ์แบบ (V5.2.6 - Responsive UI + 100% Extension Bridge + Stereo Audio) ดังนี้:
1. แก้ไขหน้า ProductionMonitor (ProductionMonitor.tsx) ไม่ให้ซ้อนทับกันเด็ดขาด:
   - แถบป้ายด้านบน ("หน้าจอแสดงผลสดจากระบบ" และ "มอนิเตอร์ 01.A"): ห้ามใช้ absolute top-0 left-0 เพราะจอมือถือ 9:16 จะไปทับป้าย ให้แยกออกมาเป็นแถว Flex ด้านบนสุดของฝั่งขวา มี mb-4 pb-3 border-b border-white/10 flex items-center justify-between shrink-0
   - กรอบจอมือถือ 9:16 (Live Preview): ใส่ Container รอบจอมือถือเป็น flex-1 min-h-0 flex items-center justify-center py-3 my-2 overflow-hidden และตัวกรอบจอมือถือใช้ h-full max-h-[44vh] w-auto aspect-[9/16] mx-auto bg-[#111] rounded-[28px] border-[6px] border-white/10 shadow-2xl overflow-hidden relative shrink-0 เพื่อไม่ให้ล้นไปทับป้ายด้านบนหรือกล่อง Log ด้านล่าง
   - กล่อง Terminal Logs (AI_PROD_OS >) ด้านล่าง: ใช้ mt-3 h-[125px] p-4 rounded-2xl bg-black/50 border border-white/10 shrink-0 overflow-y-auto
   - แถบซ้ายของ ProductionMonitor: ใช้ความกว้าง w-full md:w-[280px] lg:w-[310px] p-5 gap-3 และปุ่มด้านล่างใช้ p-4 gap-2.5 border-t border-white/10 mt-auto
2. แก้ไขหน้าหลัก (App.tsx และ BatchManager.tsx) ให้มี Margin และ Padding ที่เป็นระเบียบเมื่อเปิดคู่กับแถบ Extension:
   - ปรับ Sidebar ด้านซ้ายเป็น w-full md:w-[300px] lg:w-[320px] p-5 gap-6 shrink-0 และพื้นที่หลักฝั่งขวาใช้ flex-1 p-6 md:p-8 overflow-y-auto space-y-6
   - การ์ดในคลังไอเดียโฆษณา (IDEA BANK) ใช้ gap-4 p-5 ไม่เบียดซ้อนกัน
3. การซิงค์เพศตัวละครและเสียง Stereo 44.1kHz ใน App.tsx:
   - ตั้งค่าเริ่มต้น imageModel เป็น '🍌 Nano Banana 2.1' และซิงค์ influencer.gender ('male' / 'female') จาก Extension ให้ตรงกับปุ่ม ชาย (ครับ) / หญิง (ค่ะ)
   - ใน finalizeCampaign เปลี่ยนพารามิเตอร์ ffmpegService.exec เป็น ['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c:v', 'copy', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k', '-y', 'out.mp4'] และใช้ new Blob([res], { type: 'video/mp4' })`;

    try {
      await navigator.clipboard.writeText(upgradePrompt);
    } catch (_) {}

    showToast('🛠️ กำลังส่งคำสั่งอัปเกรดเข้า Tool Builder ใน Google Flow...', 4000);
    chrome.runtime.sendMessage(
      { type: 'ANTIGRAVITY_EXEC_CMD', cmd: 'FLOW_SEND_BUILDER_PROMPT', args: { prompt: upgradePrompt } },
      (res) => {
        if (res?.ok) {
          showToast('✅ ส่งคำสั่งอัปเกรดเข้า Tool Builder สำเร็จ! รอ Google Flow คอมไพล์สักครู่ (คัดลอกคำสั่งสำรองลง Clipboard ให้แล้ว)', 6000);
        } else {
          showToast('📋 คัดลอกคำสั่งอัปเกรดลง Clipboard แล้ว! (เปิดโหมด Edit ใน Google Flow แล้วกด Paste ในช่อง Tool Builder ได้เลย)', 6000);
        }
      }
    );
  }

  $('#btnUpgradeFlowTool')?.addEventListener('click', () => {
    upgradeFlowToolInBrowser();
  });

  // Define buildFlowMatrixPayload helper for Video Factory & One-Click Auto-Pilot
  async function buildFlowMatrixPayload(customItems) {
    let list = customItems;
    const selProd = typeof selectedProduct !== 'undefined' ? selectedProduct : window.__phimbotSelectedProduct;
    if (!list || !list.length) {
      if (typeof getFactoryProducts === 'function' && getFactoryProducts()?.length) {
        list = getFactoryProducts();
      } else if (Array.isArray(window.__phimbotFactoryProducts) && window.__phimbotFactoryProducts.length) {
        list = window.__phimbotFactoryProducts;
      } else if (selProd) {
        list = [selProd];
      } else if (showcaseProducts && showcaseProducts.length) {
        list = showcaseProducts.slice(0, 1);
      } else {
        const st = await chrome.storage.local.get(['phimbot_products']).catch(() => ({}));
        if (st?.phimbot_products?.length) {
          list = st.phimbot_products.slice(0, 1);
        }
      }
    }
    if (!list || !list.length) return null;
    return await buildAiSalerProPayload(list);
  }

  // Expose Flow Bridge functions to window for Video Factory coordination
  window.sendDataToFlowTool = sendDataToFlowTool;
  window.triggerFlowToolAction = triggerFlowToolAction;
  window.buildFlowMatrixPayload = buildFlowMatrixPayload;
  window.buildAiSalerProPayload = buildAiSalerProPayload;
  window.checkFlowToolStatus = checkFlowToolStatus;

  // Auto check flow tool status when clicking factory tab
  document.querySelector('.tab-btn[data-tab="factory"]')?.addEventListener('click', () => {
    setTimeout(checkFlowToolStatus, 400);
  });

  // Keep Antigravity Live Bridge active while Sidepanel is open
  if (location.search.includes('ag_reload=1')) {
    setTimeout(() => {
      try { chrome.runtime.reload(); } catch (_) {}
    }, 300);
  }
  let _spAgBridgeEnabled = false;
  chrome.storage.local.get(['ag_bridge_enabled'], (res) => {
    _spAgBridgeEnabled = Boolean(res?.ag_bridge_enabled);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.ag_bridge_enabled) {
      _spAgBridgeEnabled = Boolean(changes.ag_bridge_enabled.newValue);
    }
  });
  setInterval(() => {
    if (!_spAgBridgeEnabled) return;
    try {
      chrome.runtime.sendMessage({ type: 'ANTIGRAVITY_BRIDGE_WAKE' }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {}
  }, 2500);

  // ── Antigravity Live Bridge Sidepanel Controller ──
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (msg.type === 'AG_SIDEPANEL_PING') {
      const activeTabBtn = document.querySelector('.tab-btn.active');
      sendResponse({
        ok: true,
        url: location.href,
        activeTab: activeTabBtn?.dataset?.tab || '',
        tabs: Array.from(document.querySelectorAll('.tab-btn')).map(b => ({
          tab: b.dataset.tab,
          text: (b.innerText || b.textContent || '').trim(),
          active: b.classList.contains('active'),
        })),
        factoryApiAvailable: Boolean(window.__AG_FACTORY_API__),
      });
      return false;
    }

    if (msg.type === 'AG_SIDEPANEL_CMD') {
      (async () => {
        try {
          const sub = msg.subAction || 'GET_UI_STATE';
          if (sub === 'RELOAD_SIDEPANEL') {
            sendResponse({ ok: true, reloading: true });
            setTimeout(() => location.reload(), 100);
            return;
          }
          if (sub === 'SWITCH_TAB') {
            const tabName = msg.tab || 'factory';
            const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
            if (!btn) {
              sendResponse({ ok: false, error: `Tab not found: ${tabName}` });
              return;
            }
            btn.click();
            await new Promise(r => setTimeout(r, 250));
            sendResponse({ ok: true, activeTab: tabName });
            return;
          }

          if (sub === 'GET_UI_STATE') {
            const activeTab = document.querySelector('.tab-btn.active')?.dataset?.tab || '';
            const factoryState = window.__AG_FACTORY_API__?.getState?.() || null;
            const vaultCards = Array.from(document.querySelectorAll('#vaultGrid .vault-card')).map(c => ({
              id: c.dataset.id,
              text: (c.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 180),
              buttons: Array.from(c.querySelectorAll('.vault-action')).map(b => ({
                action: b.dataset.action,
                text: (b.innerText || '').trim(),
                disabled: b.disabled,
              })),
            }));
            sendResponse({
              ok: true,
              activeTab,
              factoryState,
              factoryDom: {
                engine: document.getElementById('factoryVideoEngine')?.value || '',
                imageModel: document.getElementById('factoryImageModel')?.value || '',
                videoModel: document.getElementById('factoryVideoModel')?.value || '',
                duration: document.getElementById('factoryDuration')?.value || '',
                sceneCount: document.getElementById('factorySceneCount')?.value || '',
                ideaCount: document.getElementById('factoryIdeaCount')?.value || '',
                contentStyle: document.getElementById('factoryContentStyle')?.value || '',
                postAction: document.querySelector('input[name="factoryPostAction"]:checked')?.value || '',
                activeVoice: document.querySelector('.factory-voice-btn.active')?.dataset?.voice || '',
                activeMode: document.querySelector('.factory-mode-btn.active')?.dataset?.mode || '',
                charImgsInGrid: document.querySelectorAll('#factoryCharGrid img').length,
                productQueueChips: document.querySelectorAll('#factoryProductQueue > *').length,
                flowStatusText: document.getElementById('flowStatusText')?.textContent || '',
                monLog: (document.getElementById('monLog')?.innerText || '').slice(-1200),
              },
              vaultDom: {
                vaultCountText: document.getElementById('vaultCount')?.textContent || '',
                cardCount: vaultCards.length,
                cards: vaultCards.slice(0, 10),
              },
            });
            return;
          }

          if (sub === 'BUILD_FLOW_PAYLOAD') {
            const payload = await buildFlowMatrixPayload(msg.items || null);
            sendResponse({
              ok: Boolean(payload),
              gender: payload?.gender,
              voiceGender: payload?.voiceGender,
              influencerGender: payload?.influencer?.gender,
              hasCharImage: Boolean(payload?.influencer?.image),
              settings: payload?.settings,
              productsCount: payload?.products?.length || 0,
              productsSummary: (payload?.products || []).map(p => ({
                name: p.name,
                tiktokProductId: p.tiktokProductId,
                productUrl: p.productUrl,
                assetsCount: Array.isArray(p.assets) ? p.assets.length : 0,
                keywords: p.keywords,
              })),
            });
            return;
          }

          if (sub === 'SEND_DATA_TO_FLOW_TOOL') {
            const payload = msg.payload || await buildFlowMatrixPayload(msg.items || null);
            if (!payload) {
              sendResponse({ ok: false, error: 'No payload available to send' });
              return;
            }
            const res = await sendDataToFlowTool(payload);
            sendResponse({ ok: true, result: res, sentProducts: payload.products?.length || 0, gender: payload.gender });
            return;
          }

          if (sub === 'TRIGGER_FLOW_TOOL_ACTION') {
            const res = await triggerFlowToolAction(msg.actionType || 'GEN_SCRIPT');
            sendResponse({ ok: true, result: res });
            return;
          }

          if (sub === 'CHECK_FLOW_TOOL_STATUS') {
            const res = await checkFlowToolStatus();
            sendResponse({ ok: true, result: res });
            return;
          }

          if (sub === 'SET_FACTORY_CHARS') {
            if (!window.__AG_FACTORY_API__) {
              sendResponse({ ok: false, error: '__AG_FACTORY_API__ not available' });
              return;
            }
            const r = window.__AG_FACTORY_API__.setCharImages(msg.images || [], msg.voiceGender);
            sendResponse({ ok: true, ...r });
            return;
          }

          if (sub === 'SET_FACTORY_PRODUCTS') {
            if (!window.__AG_FACTORY_API__) {
              sendResponse({ ok: false, error: '__AG_FACTORY_API__ not available' });
              return;
            }
            const count = window.__AG_FACTORY_API__.setFactoryProducts(msg.products || []);
            sendResponse({ ok: true, count });
            return;
          }

          if (sub === 'TEST_RESOLVE_CATALOG_PRODUCT') {
            if (!window.__AG_FACTORY_API__) {
              sendResponse({ ok: false, error: '__AG_FACTORY_API__ not available' });
              return;
            }
            const resolved = await window.__AG_FACTORY_API__.resolveCatalogProduct(msg.item || {}, msg.fallbackIndex || 0);
            sendResponse({ ok: true, resolved });
            return;
          }

          if (sub === 'CLICK_SELECTOR') {
            const el = document.querySelector(msg.selector);
            if (!el) {
              sendResponse({ ok: false, error: `Selector not found: ${msg.selector}` });
              return;
            }
            el.click();
            await new Promise(r => setTimeout(r, 200));
            sendResponse({ ok: true, clicked: msg.selector });
            return;
          }

          sendResponse({ ok: false, error: `Unknown AG_SIDEPANEL_CMD subAction: ${sub}` });
        } catch (err) {
          sendResponse({ ok: false, error: err?.message || String(err) });
        }
      })();
      return true;
    }
    return false;
  });
})();

