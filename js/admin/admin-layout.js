function switchPanel(name, btn) {
  document.querySelectorAll('.admin-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
  const panel = document.getElementById('panel-' + name);
  if (panel) panel.classList.add('active');
  if (btn) btn.classList.add('active');

  if (name === 'orders') {
    startOrderPolling();
  } else {
    stopOrderPolling();
  }
  if (name === 'stats') renderSalesStats();
}

/* ═════════════════════════════
   小便籤（存在這台裝置的瀏覽器，換裝置不會同步）
   ═════════════════════════════ */
let notepadSaveTimer = null;

function initNotepad() {
  const box = document.getElementById('notepad-text');
  if (!box) return;
  box.value = localStorage.getItem('kigoNotepad') || '';
  // 邊打邊存，停一下沒動作才寫入，不用按儲存
  box.addEventListener('input', () => {
    setNotepadStatus('');
    clearTimeout(notepadSaveTimer);
    notepadSaveTimer = setTimeout(() => {
      localStorage.setItem('kigoNotepad', box.value);
      setNotepadStatus('✓');
      setTimeout(() => setNotepadStatus(''), 1500);
    }, 500);
  });
}

function setNotepadStatus(text) {
  const el = document.getElementById('notepad-status');
  if (el) el.textContent = text;
}

function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}
