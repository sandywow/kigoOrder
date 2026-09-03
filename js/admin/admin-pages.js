function buildTabsEditor() {
  const wrap = document.getElementById('tabs-editor');
  if (!wrap) return;
  wrap.innerHTML = '';
  state.tabs.forEach((tab, i) => {
    const row = document.createElement('div');
    row.className = 'field-row';
    row.innerHTML = `
      <div class="field" style="flex:0 0 90px">
        <label>識別碼</label>
        <input type="text" value="${tab.key}" readonly style="opacity:0.45;cursor:not-allowed">
      </div>
      <div class="field">
        <label>顯示名稱</label>
        <input type="text" value="${tab.label}" oninput="state.tabs[${i}].label=this.value">
      </div>`;
    wrap.appendChild(row);
  });
}

function buildSectionTitlesEditor() {
  const wrap = document.getElementById('section-titles-editor');
  if (!wrap) return;
  wrap.innerHTML = '';
  Object.keys(state.sectionTitles).forEach(key => {
    const t = state.sectionTitles[key];
    const g = document.createElement('div');
    g.className = 'other-group';
    g.innerHTML = `
      <div class="key-chip">${key}</div>
      <div class="field-row">
        <div class="field">
          <label>英文標題</label>
          <input type="text" value="${ve(t.en)}" oninput="state.sectionTitles['${key}'].en=ne(this.value)">
        </div>
        <div class="field">
          <label>中文副標</label>
          <input type="text" value="${ve(t.jp)}" oninput="state.sectionTitles['${key}'].jp=ne(this.value)">
        </div>
      </div>`;
    wrap.appendChild(g);
  });
}

function populateLanding() {
  const ld = state.landingData;
  const textFields = [
    'cafeName','cafeSub','dateSeasonLabel','heroImage','heroBadge',
    'heroTitle','heroSubtitle','tagline','taglineJp',
    'cardLabel','cardName','cardNameJp','cardDesc','cardPrice','cardTag',
    'bannerLabel','bannerImage','ctaButton','ctaHint',
    'footerLeft','footerRight','menuTitle','menuSubtitle','orderEndpoint'
  ];
  textFields.forEach(k => {
    const el = document.getElementById('ld-' + k);
    if (el) el.value = ve(ld[k]);
  });
  document.getElementById('ld-bannerImages').value = Array.isArray(ld.bannerImages) ? ld.bannerImages.filter(Boolean).join('\n') : '';
  document.getElementById('ld-tableNumbers').value = Array.isArray(ld.tableNumbers) ? ld.tableNumbers.filter(Boolean).join('\n') : '';
  document.getElementById('ld-showDate').checked          = !!ld.showDate;
  document.getElementById('ld-bannerPlaceholder').checked = !!ld.bannerPlaceholder;
  document.getElementById('ld-hideHero').checked           = !!ld.hideHero;
  document.getElementById('ld-hideCard').checked           = !!ld.hideCard;
  document.getElementById('ld-hideBanner').checked         = !!ld.hideBanner;
}

function readLanding() {
  const t = id => ne(document.getElementById('ld-' + id).value);
  const multi = id => {
    const value = document.getElementById('ld-' + id).value || '';
    return value
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean);
  };
  return {
    cafeName:        t('cafeName'),
    cafeSub:         t('cafeSub'),
    showDate:        document.getElementById('ld-showDate').checked,
    dateSeasonLabel: t('dateSeasonLabel'),
    heroImage:       t('heroImage'),
    bannerImages:    multi('bannerImages'),
    heroBadge:       t('heroBadge'),
    heroTitle:       t('heroTitle'),
    heroSubtitle:    t('heroSubtitle'),
    tagline:         t('tagline'),
    taglineJp:       t('taglineJp'),
    cardLabel:       t('cardLabel'),
    cardName:        t('cardName'),
    cardNameJp:      t('cardNameJp'),
    cardDesc:        t('cardDesc'),
    cardPrice:       t('cardPrice'),
    cardTag:         t('cardTag'),
    bannerLabel:     t('bannerLabel'),
    bannerImage:     t('bannerImage'),
    bannerAlt:       state.landingData.bannerAlt || '當季推薦海報',
    bannerPlaceholder: document.getElementById('ld-bannerPlaceholder').checked,
    hideHero:        document.getElementById('ld-hideHero').checked,
    hideCard:        document.getElementById('ld-hideCard').checked,
    hideBanner:      document.getElementById('ld-hideBanner').checked,
    ctaButton:       t('ctaButton'),
    ctaHint:         t('ctaHint'),
    footerLeft:      t('footerLeft'),
    footerRight:     t('footerRight'),
    menuTitle:       t('menuTitle'),
    menuSubtitle:    t('menuSubtitle'),
    tableNumbers:    multi('tableNumbers'),
    orderEndpoint:   t('orderEndpoint'),
  };
}

function openConfigModal() {
  state.landingData = readLanding();

  function jv(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return String(v);
    return JSON.stringify(v);
  }

  function renderItem(item) {
    const keys = ['name','nameJp','desc','price','tag','image','emoji','temp','soldOut'];
    const lines = keys.filter(k => k in item).map(k => `      ${k}: ${jv(item[k])}`);
    return '    {\n' + lines.join(',\n') + '\n    }';
  }

  function renderMenuData(md) {
    const cats = Object.keys(md);
    const blocks = cats.map(cat => {
      const items = (md[cat] || []).map(renderItem).join(',\n');
      return `  ${cat}: [\n${items}\n  ]`;
    });
    return 'const menuData = {\n' + blocks.join(',\n') + '\n};';
  }

  function renderLanding(ld) {
    const entries = Object.keys(ld).map(k => `  ${k}: ${jv(ld[k])}`);
    return 'const landingData = {\n' + entries.join(',\n') + '\n};';
  }

  function renderTabs(t) {
    const items = t.map(tab => `  { key: ${jv(tab.key)}, label: ${jv(tab.label)} }`);
    return 'const tabs = [\n' + items.join(',\n') + '\n];';
  }

  function renderSectionTitles(st) {
    const entries = Object.keys(st).map(k => {
      const t = st[k];
      return `  ${k}: { en: ${jv(t.en)}, jp: ${jv(t.jp)} }`;
    });
    return 'const sectionTitles = {\n' + entries.join(',\n') + '\n};';
  }

  // 訂單 API 欄位留空代表「沿用 config.js 寫死的網址」（見 admin-data.js 的 mergeLanding）。
  // 但匯出時若照樣寫成 null，貼回 config.js 就會把那個網址清掉，前台從此送不出訂單。
  // 所以這裡要把原始的 config.js 值補回去 —— 全域的 landingData 沒被後台動過，就是檔案裡的內容。
  // 其他欄位的 null 是真的「不顯示」，維持原樣。
  const exported = Object.assign({}, state.landingData);
  if (exported.orderEndpoint == null) exported.orderEndpoint = landingData.orderEndpoint;

  const content = [
    renderMenuData(state.menuData),
    renderLanding(exported),
    renderTabs(state.tabs),
    renderSectionTitles(state.sectionTitles)
  ].join('\n\n');

  document.getElementById('config-output').value = content;
  document.getElementById('modal-backdrop').classList.add('open');
  document.getElementById('config-modal').classList.add('open');
  document.getElementById('copy-btn').textContent = '複製全部';
  document.getElementById('copy-btn').classList.remove('copied');
}

function closeConfigModal() {
  document.getElementById('modal-backdrop').classList.remove('open');
  document.getElementById('config-modal').classList.remove('open');
}

function copyConfig() {
  const ta  = document.getElementById('config-output');
  const btn = document.getElementById('copy-btn');
  ta.select();
  navigator.clipboard.writeText(ta.value).then(() => {
    btn.textContent = '已複製 ✓';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = '複製全部'; btn.classList.remove('copied'); }, 2000);
  });
}
