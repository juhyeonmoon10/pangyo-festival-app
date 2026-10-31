/* Festival notices for participants (list and one notice) and the photo part of the operator editor.
   Photos are shrunk in the browser, stored in the public 'festival-notices' bucket and referenced by path. */
const festivalNotices = (() => {
  const MAX_IMAGES = 4, MAX_EDGE = 1600;
  let draft = null;
  const h = value => escapeHtml(String(value ?? ''));
  const items = () => isServerMode() ? (festivalOpsUI.notices?.() || []) : (state.db.announcements || []);
  const images = () => festivalAccount?.noticeImages;
  const url = path => images()?.url(path) || '';
  const when = value => value ? new Date(value).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' }) : '';
  const header = (title, back) => `<header class="top-bar"><button class="icon-btn" data-history-back="${back}" aria-label="뒤로">${icon('back')}</button><h1>${title}</h1><span class="icon-btn" aria-hidden="true"></span></header>`;

  function open(id) {
    state.noticeId = id;
    navigateTo('notice');
    window.scrollTo(0, 0);
  }

  function listView() {
    const news = items();
    return `<main class="screen festival-notices-screen">${header('축제 소식', 'home')}
      ${news.length ? `<ul class="festival-notice-list">${news.map(n => `<li><button type="button" class="festival-notice-row ${n.important ? 'important' : ''}" data-notice-open="${h(n.id)}">
        <span><strong>${n.important ? '<span class="web-news-flag">중요</span>' : ''}${h(n.title)}</strong>${n.body ? `<small>${h(n.body)}</small>` : ''}
        <em>${h(when(n.publishedAt))}${n.images?.length ? ` · 사진 ${n.images.length}장` : ''}</em></span>${icon('arrow')}</button></li>`).join('')}</ul>`
        : '<div class="festival-empty"><span>' + icon('notice') + '</span><strong>등록된 공지가 없어요</strong></div>'}
      ${bottomNav('home')}</main>`;
  }

  function detailView() {
    const n = items().find(x => String(x.id) === String(state.noticeId));
    const loading = isServerMode() && !festivalOpsUI.snapshot()?.ready;
    const body = n ? `<article class="festival-notice-article">
        ${n.important ? '<span class="web-news-flag">중요</span>' : ''}<h2>${h(n.title)}</h2>
        <p class="festival-notice-date">${h(when(n.publishedAt))}${n.updatedAt && n.updatedAt !== n.publishedAt ? ' · 수정됨' : ''}</p>
        ${(n.images || []).map((path, i) => `<img class="festival-notice-photo" src="${h(url(path))}" alt="${h(n.title)} 사진 ${i + 1}" loading="${i ? 'lazy' : 'eager'}" decoding="async">`).join('')}
        ${n.body ? `<p class="festival-notice-body">${h(n.body)}</p>` : ''}
      </article>`
      : `<div class="festival-empty"><span>${icon('notice')}</span><strong>${loading ? '공지를 불러오는 중이에요' : '공지를 찾을 수 없어요'}</strong>${loading ? '' : '<p>삭제되었거나 숨겨진 공지예요.</p>'}<button type="button" class="ghost-btn" data-route="notices">축제 소식 전체 보기</button></div>`;
    return `<main class="screen festival-notices-screen">${header('공지', 'notices')}${body}${bottomNav('home')}</main>`;
  }

  function bind() {
    document.querySelectorAll('[data-notice-open]').forEach(button => button.addEventListener('click', event => {
      event.stopPropagation();
      open(button.dataset.noticeOpen);
    }));
    const box = document.querySelector('[data-notice-images]');
    if (box) bindEditor(box);
  }

  // Operator editor: photos already on the notice plus new ones waiting to be uploaded on save.
  function editor(notice) {
    const id = notice?.id || '';
    if (!draft || draft.id !== id) {
      draft?.added.forEach(a => URL.revokeObjectURL(a.preview));
      draft = { id, original: [...(notice?.images || [])], keep: [...(notice?.images || [])], added: [], note: '' };
    }
    return editorMarkup();
  }

  function editorMarkup() {
    const count = draft.keep.length + draft.added.length;
    return `<div class="ops-notice-images" data-notice-images><span class="ops-recipient-label">사진 (최대 ${MAX_IMAGES}장)</span>
      ${count ? `<ul>${draft.keep.map(path => `<li><img src="${h(url(path))}" alt=""><button type="button" class="icon-btn" data-notice-image-keep="${h(path)}" aria-label="사진 빼기">${icon('close')}</button></li>`).join('')}
        ${draft.added.map((a, i) => `<li><img src="${h(a.preview)}" alt=""><button type="button" class="icon-btn" data-notice-image-added="${i}" aria-label="사진 빼기">${icon('close')}</button></li>`).join('')}</ul>` : ''}
      ${count < MAX_IMAGES ? `<label class="ghost-btn ops-notice-photo-pick">${icon('plus')} 사진 추가<input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple data-notice-file hidden></label>` : ''}
      ${draft.note ? `<p class="ops-form-status" role="status">${h(draft.note)}</p>` : ''}</div>`;
  }

  function redrawEditor(box) {
    if (!box.isConnected) return;
    box.outerHTML = editorMarkup();
    const next = document.querySelector('[data-notice-images]');
    if (next) bindEditor(next);
  }

  function bindEditor(box) {
    box.querySelector('[data-notice-file]')?.addEventListener('change', async event => {
      const files = [...event.currentTarget.files].slice(0, MAX_IMAGES - draft.keep.length - draft.added.length);
      draft.note = files.length ? '사진을 준비하는 중...' : '';
      for (const file of files) {
        try {
          const blob = await shrink(file);
          draft.added.push({ blob, preview: URL.createObjectURL(blob) });
          draft.note = '';
        } catch { draft.note = '이 사진은 열 수 없어요. JPG·PNG 사진을 골라 주세요.'; }
      }
      redrawEditor(box);
    });
    box.querySelectorAll('[data-notice-image-keep]').forEach(b => b.addEventListener('click', () => {
      draft.keep = draft.keep.filter(path => path !== b.dataset.noticeImageKeep); redrawEditor(box);
    }));
    box.querySelectorAll('[data-notice-image-added]').forEach(b => b.addEventListener('click', () => {
      const [gone] = draft.added.splice(Number(b.dataset.noticeImageAdded), 1);
      if (gone) URL.revokeObjectURL(gone.preview);
      redrawEditor(box);
    }));
  }

  // Longest edge at most 1600 px (booth photos: 1080), JPEG: a phone photo becomes a few hundred KB.
  async function shrink(file, edge = MAX_EDGE) {
    if (!/^image\//.test(file.type) && !/\.(heic|heif)$/i.test(file.name)) throw new Error('NOT_IMAGE');
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw new Error('ENCODE_FAILED');
    return blob;
  }

  // Before notice_save: upload new photos and return the full list of paths for the notice.
  async function uploadDraft(noticeId) {
    if (!draft || draft.id !== (noticeId || '')) return { ok: true, images: undefined, uploaded: [] };
    const uploaded = [];
    for (const item of draft.added) {
      const result = await images()?.upload(item.blob);
      if (!result?.ok) { await discard(uploaded); return { ok: false, message: result?.message || '사진을 올리지 못했어요. 다시 시도해 주세요.', uploaded: [] }; }
      uploaded.push(result.path);
    }
    return { ok: true, images: [...draft.keep, ...uploaded], uploaded };
  }
  async function discard(paths) { if (paths?.length) await images()?.remove(paths); }
  // After a successful save: photos taken off the notice are deleted from storage.
  async function afterSave() {
    const removed = draft ? draft.original.filter(path => !draft.keep.includes(path)) : [];
    draft?.added.forEach(a => URL.revokeObjectURL(a.preview));
    draft = null;
    await discard(removed);
  }
  function reset() { draft?.added.forEach(a => URL.revokeObjectURL(a.preview)); draft = null; }

  return { listView, detailView, bind, open, editor, uploadDraft, afterSave, discard, reset, shrink };
})();
