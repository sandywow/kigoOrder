/* ═════════════════════
   LOAD ADMIN OVERRIDES
   ═════════════════════ */
(function () {
  var stored = localStorage.getItem('kigoMenuConfig');
  if (!stored) return;
  try {
    var c = JSON.parse(stored);
    if (c.menuData)      Object.keys(c.menuData).forEach(function(k) { menuData[k] = c.menuData[k]; });
    if (c.landingData)   Object.keys(c.landingData).forEach(function(k) { if (c.landingData[k] !== null) landingData[k] = c.landingData[k]; });
    if (c.tabs)          { tabs.length = 0; c.tabs.forEach(function(t) { tabs.push(t); }); }
    if (c.sectionTitles) Object.assign(sectionTitles, c.sectionTitles);
  } catch(e) {}
})();

/* ═════════════════════
   PAGE TRANSITIONS
   ═════════════════════ */
function showMenu(initialKey) {
  const key = initialKey || tabs[0].key;
  document.getElementById('landing').classList.replace('visible', 'hidden');
  const menuPage = document.getElementById('menu-page');
  menuPage.classList.replace('hidden', 'visible');
  menuPage.scrollTop = 0;

  // Activate correct tab, then render
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-key') === key);
  });
  renderSection(key);
}

function showLanding() {
  document.getElementById('menu-page').classList.replace('visible', 'hidden');
  document.getElementById('landing').classList.replace('hidden', 'visible');
  document.getElementById('landing').scrollTop = 0;
}

/* ═════════════════════
   TAB SWITCHING
   ═════════════════════ */
function switchTab(category, btn) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderSection(category);
  // Scroll content back to top of menu-content
  const content = document.getElementById('menu-content');
  if (content) content.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ═════════════════════
   RENDER SECTIONS
   ═════════════════════ */
function tempDots(temp) {
  const hot   = `<span class="temp-dot temp-dot-hot"></span>`;
  const cold  = `<span class="temp-dot temp-dot-cold"></span>`;
  const blank = `<span class="temp-dot temp-dot-blank"></span>`;
  const h = (temp === 'hot'  || temp === 'both') ? hot  : blank;
  const c = (temp === 'iced' || temp === 'both') ? cold : blank;
  return `<div class="temp-dots">${h}${c}</div>`;
}

function renderSection(category) {
  const container = document.getElementById('menu-content');
  const items = menuData[category] || [];
  const t = sectionTitles[category] || { en: category, jp: null };
  const hasTempItems = items.some(item => item.temp !== undefined);
  let html = `<div class="menu-section active">`;

  if (t.en || t.jp) {
    html += `<div class="section-intro">
      ${t.en ? `<h3>${t.en}</h3>` : ''}
      ${t.jp ? `<p>${t.jp}</p>` : ''}
    </div>`;
  }

  items.forEach((item, i) => {
    const imgHtml = item.image
      ? `<img src="${item.image}" alt="${item.name || ''}" loading="lazy">`
      : '';
    const imgBlock   = imgHtml ? `<div class="menu-item-img-wrap">${imgHtml}</div>` : '';
    const dotsHtml   = hasTempItems ? tempDots(item.temp) : '';
    const rightBlock = (dotsHtml || imgBlock) ? `<div class="menu-item-right">${dotsHtml}${imgBlock}</div>` : '';
    const tagHtml     = item.tag ? `<span class="item-tag">${item.tag}</span>` : '';
    const soldOutHtml = item.soldOut ? `<span class="item-tag item-tag-soldout">售完</span>` : '';
    const nameHtml   = item.name   ? `<span class="menu-item-name">${item.name}</span>` : '';
    const nameJpHtml = item.nameJp ? `<div class="menu-item-name-jp">${item.nameJp.replace(/\n/g, '<br>')}</div>` : '';
    const descHtml   = item.desc   ? `<p class="menu-item-desc">${item.desc.replace(/\n/g, '<br>')}</p>` : '';
    const priceHtml  = item.price  ? `<div class="menu-item-price">${item.price}</div>` : '';
    const addBtn     = item.soldOut ? '' : `<div class="menu-item-actions"><button class="add-to-cart" onclick="addToCart('${category}',${i})">加入購物車</button></div>`;

    html += `
      <div class="menu-item${item.soldOut ? ' menu-item-soldout' : ''}" style="animation-delay:${i * 0.07}s">
        <div class="menu-item-body">
          <div class="menu-item-top">${nameHtml}${tagHtml}${soldOutHtml}</div>
          ${nameJpHtml}
          ${descHtml}
          ${priceHtml}
          ${addBtn}
        </div>
        ${rightBlock}
      </div>`;
  });

  html += `<div class="ornament" style="padding:28px 0">✦ &nbsp; ✦ &nbsp; ✦</div></div>`;
  container.innerHTML = html;
}

/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */
function setOrHide(id, val, useInnerHTML = false) {
  const el = document.getElementById(id);
  if (!el) return;
  if (val) {
    if (useInnerHTML) el.innerHTML = val; else el.textContent = val;
    el.style.display = '';
  } else {
    el.style.display = 'none';
  }
}

function hideEl(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

function showToast(msg, duration = 2800) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => toast.classList.remove('show'), duration);
}

/* ═══════════════════════════════════
   BUILD TABS
   ═══════════════════════════════════════════ */
function buildTabs() {
  const bar = document.getElementById('tab-bar');
  bar.innerHTML = '';
  tabs.forEach((tab, i) => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (i === 0 ? ' active' : '');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('data-key', tab.key);
    btn.textContent = tab.label;
    btn.onclick = () => switchTab(tab.key, btn);
    bar.appendChild(btn);
  });
}
let bannerCarouselTimer = null;
let bannerCarouselIndex = 0;
let bannerCarouselImages = [];
let pendingCartSelection = null;

function clearBannerCarousel() {
  if (bannerCarouselTimer) {
    clearTimeout(bannerCarouselTimer);
    bannerCarouselTimer = null;
  }
}

function updateBannerDisplayHeight(bannerDisplay, img) {
  if (!bannerDisplay || !img || !img.naturalWidth) return;
  const width = bannerDisplay.clientWidth;
  const height = Math.round((img.naturalHeight / img.naturalWidth) * width);
  bannerDisplay.style.height = `${height}px`;
}

function scheduleBannerCarousel() {
  clearBannerCarousel();
  if (bannerCarouselImages.length < 2) return;
  const delay = 5000;
  bannerCarouselTimer = setTimeout(() => {
    renderBannerSlide(bannerCarouselIndex + 1);
    scheduleBannerCarousel();
  }, delay);
}

function renderBannerSlide(index, noFade) {
  const bannerDisplay = document.getElementById('banner-display');
  if (!bannerDisplay || !bannerCarouselImages.length) return;
  bannerCarouselIndex = ((index % bannerCarouselImages.length) + bannerCarouselImages.length) % bannerCarouselImages.length;
  const src = bannerCarouselImages[bannerCarouselIndex];
  const dots = bannerCarouselImages.map((_, i) =>
    `<button type="button" class="banner-carousel-dot${i === bannerCarouselIndex ? ' active' : ''}" data-index="${i}" aria-label="切換至第 ${i + 1} 張海報"></button>`
  ).join('');

  let dotsWrapper = bannerDisplay.querySelector('.banner-carousel-dots');
  if (!dotsWrapper) {
    dotsWrapper = document.createElement('div');
    dotsWrapper.className = 'banner-carousel-dots';
    dotsWrapper.setAttribute('aria-label', '海報輪播指示');
    bannerDisplay.appendChild(dotsWrapper);
  }
  dotsWrapper.innerHTML = dots;

  const previousSlide = bannerDisplay.querySelector('.banner-slide.visible');
  const slide = document.createElement('div');
  slide.className = 'banner-slide';
  slide.dataset.slideIndex = bannerCarouselIndex;
  slide.style.zIndex = previousSlide ? 2 : 1;
  slide.innerHTML = `<img src="${src}" alt="${landingData.bannerAlt || '當季推薦'}">`;
  bannerDisplay.insertBefore(slide, dotsWrapper);

  const img = slide.querySelector('img');
  if (img) {
    if (img.complete && img.naturalWidth) {
      updateBannerDisplayHeight(bannerDisplay, img);
    } else {
      img.addEventListener('load', () => updateBannerDisplayHeight(bannerDisplay, img), { once: true });
    }
  }

  if (previousSlide) {
    previousSlide.style.zIndex = 1;
  }

  if (noFade) {
    slide.classList.add('visible');
  } else {
    setTimeout(() => slide.classList.add('visible'), 40);
  }

  if (previousSlide) {
    setTimeout(() => {
      if (previousSlide.parentNode) previousSlide.parentNode.removeChild(previousSlide);
    }, 2600);
  }

  bannerDisplay.querySelectorAll('.banner-carousel-dot').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.index);
      clearBannerCarousel();
      renderBannerSlide(idx);
      scheduleBannerCarousel();
    });
  });
}
// ─────────────────────────────────────
//  Shopping cart (client-side)
// ─────────────────────────────────────
let cart = [];

function getPriceNumber(price) {
  if (!price) return 0;
  const m = String(price).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function addToCart(cat, idx) {
  const item = (menuData[cat] || [])[idx];
  if (!item) return;
  if (item.soldOut) { showToast('此品項已售完'); return; }
  openAddToCartModal(cat, idx);
}

function openAddToCartModal(cat, idx) {
  const item = (menuData[cat] || [])[idx];
  if (!item) return;
  pendingCartSelection = { cat, idx, qty: 1 };
  const modal = document.getElementById('item-option-modal');
  const backdrop = document.getElementById('item-option-backdrop');
  if (!modal || !backdrop) return;

  modal.querySelector('.modal-item-name').textContent = item.name || '';
  const pickerContainer = modal.querySelector('#modal-temp-picker');
  const quantityInput = modal.querySelector('#modal-qty-input');
  const priceEl = modal.querySelector('.modal-item-price');

  quantityInput.value = 1;
  updateModalTotal();

  if (item.temp === 'both') {
    pickerContainer.innerHTML = `
      <div class="modal-temp-options">
        <div class="modal-field-label">選擇溫度</div>
        <label><input type="radio" name="modal-temp" value="hot" checked> 熱</label>
        <label><input type="radio" name="modal-temp" value="iced"> 冰</label>
      </div>`;
  } else if (item.temp === 'hot' || item.temp === 'iced') {
    const label = item.temp === 'hot' ? '熱' : '冰';
    pickerContainer.innerHTML = `
      <div class="modal-temp-options modal-temp-fixed">
        <div class="modal-field-label">溫度</div>
        <span>${label}</span>
      </div>`;
  } else {
    pickerContainer.innerHTML = '';
  }

  backdrop.classList.add('open');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}

function updateModalTotal() {
  const item = pendingCartSelection ? (menuData[pendingCartSelection.cat] || [])[pendingCartSelection.idx] : null;
  const input = document.getElementById('modal-qty-input');
  const priceEl = document.querySelector('.modal-item-price');
  if (!item || !input || !priceEl) return;
  let qty = parseInt(input.value, 10);
  if (!qty || qty < 1) qty = 1;
  const total = getPriceNumber(item.price) * qty;
  priceEl.textContent = `NT$${total}`;
}

function closeAddToCartModal() {
  const modal = document.getElementById('item-option-modal');
  const backdrop = document.getElementById('item-option-backdrop');
  if (modal) { modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); }
  if (backdrop) backdrop.classList.remove('open');
  pendingCartSelection = null;
}

function changeModalQty(delta) {
  const input = document.getElementById('modal-qty-input');
  if (!input) return;
  let value = parseInt(input.value, 10) || 1;
  value = Math.max(1, value + delta);
  input.value = value;
  updateModalTotal();
}

function confirmAddToCart() {
  if (!pendingCartSelection) return;
  const { cat, idx } = pendingCartSelection;
  const item = (menuData[cat] || [])[idx];
  if (!item) { closeAddToCartModal(); return; }

  const input = document.getElementById('modal-qty-input');
  let qty = input ? parseInt(input.value, 10) : 1;
  if (!qty || qty < 1) qty = 1;

  let temp = null;
  if (item.temp === 'both') {
    const selected = document.querySelector('input[name="modal-temp"]:checked');
    temp = selected ? selected.value : 'hot';
  } else if (item.temp === 'hot' || item.temp === 'iced') {
    temp = item.temp;
  }

  const found = cart.find(c => c.cat === cat && c.idx === idx && c.temp === temp);
  if (found) {
    found.qty += qty;
  } else {
    cart.push({ cat, idx, qty, temp });
  }

  renderCart();
  showToast('已加入購物車');
  closeAddToCartModal();
}

function toggleCart() {
  const drawer = document.getElementById('cart-drawer');
  const backdrop = document.getElementById('cart-backdrop');
  const open = !drawer.classList.contains('open');
  drawer.classList.toggle('open', open);
  backdrop.classList.toggle('open', open);
  drawer.setAttribute('aria-hidden', String(!open));
  if (open) renderCart();
}

function openCart() { document.getElementById('cart-drawer').classList.add('open'); document.getElementById('cart-backdrop').classList.add('open'); renderCart(); }
function closeCart() { document.getElementById('cart-drawer').classList.remove('open'); document.getElementById('cart-backdrop').classList.remove('open'); }

function renderCart() {
  const wrap = document.getElementById('cart-items');
  const countEl = document.getElementById('cart-count');
  const totalEl = document.getElementById('cart-total');
  if (!wrap) return;
  if (!cart.length) {
    wrap.innerHTML = '<div class="cart-empty">購物車目前是空的</div>';
    countEl.textContent = '0';
    totalEl.textContent = 'NT$0';
    return;
  }
  let html = '';
  let total = 0;
  cart.forEach((c, i) => {
    const item = (menuData[c.cat] || [])[c.idx] || {};
    const price = getPriceNumber(item.price);
    total += price * c.qty;
    const tempLabel = c.temp ? ` <span class="cart-item-temp">(${c.temp === 'hot' ? '熱' : c.temp === 'iced' ? '冰' : c.temp})</span>` : '';
    html += `<div class="cart-item">
      <div class="cart-item-info">
        <div class="cart-item-header">
          <div class="cart-item-name">${item.name || ''}${tempLabel}</div>
          <div class="cart-item-unit">NT$${price}</div>
        </div>
        <div class="cart-item-controls">數量：<button onclick="changeQty(${i},-1)">-</button> <span class="cart-qty">${c.qty}</span> <button onclick="changeQty(${i},1)">+</button></div>
      </div>
      <div class="cart-item-remove"><button onclick="removeCartItem(${i})">移除</button></div>
    </div>`;
  });
  wrap.innerHTML = html;
  countEl.textContent = String(cart.reduce((s, c) => s + c.qty, 0));
  totalEl.textContent = 'NT$' + total;
}

function changeQty(i, delta) {
  if (!cart[i]) return;
  cart[i].qty += delta;
  if (cart[i].qty <= 0) cart.splice(i, 1);
  renderCart();
}

function removeCartItem(i) { cart.splice(i, 1); renderCart(); }

function clearCart() { if (!confirm('清空購物車？')) return; cart.length = 0; renderCart(); }

function submitOrder() {
  if (!cart.length) { showToast('購物車為空'); return; }
  const endpoint = landingData.orderEndpoint || '/api/orders';
  const orderItems = cart.map(c => {
    const item = (menuData[c.cat] || [])[c.idx] || {};
    return {
      name: item.name || '',
      category: c.cat,
      quantity: c.qty,
      temp: c.temp || null,
      unitPrice: getPriceNumber(item.price)
    };
  });
  const total = orderItems.reduce((sum, item) => sum + (item.unitPrice || 0) * item.quantity, 0);
  const payload = {
    createdAt: new Date().toISOString(),
    total,
    items: orderItems,
    meta: {
      pageUrl: location.href
    }
  };

  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(res => {
      if (!res.ok) throw new Error('伺服器回應錯誤');
      return res.json().catch(() => null);
    })
    .then(() => {
      showToast('訂單已送出');
      cart.length = 0;
      renderCart();
      closeCart();
    })
    .catch(err => {
      console.error('Submit order failed:', err);
      showToast('送出失敗，請稍後重試');
    });
}
/* ═══════════════════════════════════
   INIT
   ═══════════════════════════════════════════ */
function initLanding() {
  const ld = landingData;

  /* ── Header ── */
  setOrHide('cafe-name', ld.cafeName);
  setOrHide('cafe-sub',  ld.cafeSub);
  if (ld.showDate) {
    const d = new Date();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const dateStr = `${months[d.getMonth()]} ${d.getDate()}`;
    const full = ld.dateSeasonLabel ? `${dateStr} &nbsp;·&nbsp; ${ld.dateSeasonLabel}` : dateStr;
    setOrHide('landing-date-line', full, true);
  } else {
    hideEl('landing-date-line');
  }

  /* ── Hero image (single image override) ── */
  const heroVisual = document.getElementById('hero-visual');
  if (ld.heroImage) {
    heroVisual.innerHTML = `<img class="hero-img" src="${ld.heroImage}" alt="${ld.heroTitle || '季節主視覺'}" loading="lazy">`;
  }
  setOrHide('hero-badge',    ld.heroBadge);
  setOrHide('hero-title',    ld.heroTitle);
  setOrHide('hero-subtitle', ld.heroSubtitle);

  /* ── Tagline ── */
  const taglineBlock = document.querySelector('.tagline-block');
  if (ld.tagline) {
    setOrHide('landing-tagline',    ld.tagline, true);
    setOrHide('landing-tagline-jp', ld.taglineJp);
    if (taglineBlock) taglineBlock.style.display = '';
  } else {
    if (taglineBlock) taglineBlock.style.display = 'none';
  }

  /* ── Seasonal card ── */
  const card = document.getElementById('seasonal-card');
  if (ld.cardLabel) {
    setOrHide('card-label-text', ld.cardLabel);
    setOrHide('card-name',       ld.cardName);
    setOrHide('card-name-jp',    ld.cardNameJp);
    setOrHide('card-desc',       ld.cardDesc);
    setOrHide('card-price',      ld.cardPrice);
    setOrHide('card-tag',        ld.cardTag);
    if (card) card.style.display = '';
  } else {
    if (card) card.style.display = 'none';
  }

  /* ── Banner ──
     bannerImage 有值 → 顯示圖片
     bannerImage null + bannerPlaceholder true → 顯示佔位符
     bannerImage null + bannerPlaceholder false/null → 整區塊隱藏 */
  const bannerSection = document.getElementById('banner-section');
  const bannerDisplay = document.getElementById('banner-display');
  clearBannerCarousel();
  bannerCarouselImages = Array.isArray(ld.bannerImages) ? ld.bannerImages.filter(Boolean) : [];
  bannerCarouselIndex = 0;
  setOrHide('banner-label-text', ld.bannerLabel);
  if (bannerCarouselImages.length) {
    renderBannerSlide(0, true);
    scheduleBannerCarousel();
  } else if (ld.bannerImage) {
    bannerDisplay.innerHTML =
      `<div class="banner-img-wrap"><img src="${ld.bannerImage}" alt="${ld.bannerAlt || '當季推薦'}"></div>`;
  } else if (ld.bannerPlaceholder) {
    bannerDisplay.innerHTML = `
      <div class="banner-placeholder">
        <div class="banner-placeholder-icon">🌿</div>
        <div class="banner-placeholder-text">
          當季推薦海報<br>
          <span style="font-size:11px;opacity:0.7;letter-spacing:0.1em">在 bannerImage 填入圖片網址</span>
        </div>
      </div>`;
  } else {
    if (bannerSection) bannerSection.style.display = 'none';
  }

  /* ── CTA ── */
  setOrHide('cta-btn',  ld.ctaButton);
  setOrHide('cta-hint', ld.ctaHint);

  /* ── Footer ── */
  setOrHide('footer-left',  ld.footerLeft);
  setOrHide('footer-right', ld.footerRight);
  if (!ld.footerLeft && !ld.footerRight) hideEl('landing-footer');

  /* ── Menu page header ── */
  setOrHide('menu-title-text',    ld.menuTitle);
  setOrHide('menu-subtitle-text', ld.menuSubtitle);

  /* ── Menu page small logo ── */
  const logoWrap = document.getElementById('menu-logo-wrap');
  if (logoWrap && (ld.cafeName || ld.cafeSub)) {
    logoWrap.innerHTML =
      (ld.cafeName ? `<div class="cafe-logo-text" style="font-size:12px">${ld.cafeName}</div>` : '') +
      (ld.cafeSub  ? `<div class="cafe-logo-jp"   style="font-size:10px">${ld.cafeSub}</div>`  : '');
  }

  buildTabs();

  /* ── Apply visibility flags from landingData ── */
  const landing = document.getElementById('landing');
  landing.classList.toggle('hide-hero',   !!ld.hideHero);
  landing.classList.toggle('hide-card',   !!ld.hideCard);
  landing.classList.toggle('hide-banner', !!ld.hideBanner);
}

document.addEventListener('DOMContentLoaded', initLanding);
