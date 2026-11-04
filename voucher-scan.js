/* Voucher approval helpers shared by 관리 마법사 (operations-ui.js) and 바우처 담당자 (voucher-manager.js).
   scan(onCode): opens the camera and reads the student's voucher QR (its 8-character code). The
   browser's BarcodeDetector is used when present; otherwise jsQR (assets/vendor, loaded on first use)
   reads camera frames, so iPhone Safari scans too.
   approved(result): the popup after a redemption — voucher, owner, 학번 and the approval time. */
const festivalVoucherScan = (() => {
  const CODE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/;
  const JSQR = './assets/vendor/jsqr-1.4.0.js';
  const KINDS = { food: '푸드트럭 바우처', photo: '포토부스 바우처' };
  const h = value => escapeHtml(String(value ?? ''));
  let stream = null, timer = null, jsqr = null;

  const normalize = raw => String(raw || '').toUpperCase().replace(/[\s-]/g, '');

  function close() {
    stream?.getTracks().forEach(t => t.stop()); stream = null;
    clearTimeout(timer); timer = null;
    document.querySelector('.voucher-scan-dialog')?.remove();
  }

  function dialog(title, extra = '') {
    close();
    document.querySelector('.ops-dialog')?.remove();
    const d = document.createElement('dialog');
    d.className = `ops-dialog voucher-scan-dialog ${extra}`;
    d.setAttribute('aria-labelledby', 'voucherScanTitle');
    d.innerHTML = `<header><h2 id="voucherScanTitle">${h(title)}</h2><button type="button" class="icon-btn" aria-label="닫기">${icon('close')}</button></header><div class="ops-dialog-content"></div>`;
    d.querySelector('header button').onclick = close;
    d.addEventListener('cancel', e => { e.preventDefault(); close(); });
    document.body.append(d); d.showModal();
    return d;
  }

  // jsQR is about 250 KB, so it loads only when a camera opens without BarcodeDetector.
  function loadJsQR() {
    if (window.jsQR) return Promise.resolve(window.jsQR);
    jsqr ||= new Promise((resolve, reject) => {
      const s = Object.assign(document.createElement('script'), { src: JSQR, async: true });
      s.onload = () => window.jsQR ? resolve(window.jsQR) : reject(Error('JSQR_MISSING'));
      s.onerror = () => { jsqr = null; reject(Error('JSQR_LOAD')); };
      document.head.append(s);
    });
    return jsqr;
  }

  async function reader(video) {
    if ('BarcodeDetector' in window) {
      try {
        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        return async () => (await detector.detect(video)).map(x => x.rawValue);
      } catch { /* Fall back to jsQR. */ }
    }
    const decode = await loadJsQR();
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
    return async () => {
      const w = video.videoWidth, hgt = video.videoHeight;
      if (!w || !hgt) return [];
      // A smaller frame keeps decoding fast on phones; the QR fills most of the view.
      const scale = Math.min(1, 640 / Math.max(w, hgt));
      canvas.width = Math.round(w * scale); canvas.height = Math.round(hgt * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const found = decode(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
      return found ? [found.data] : [];
    };
  }

  async function scan(onCode) {
    const d = dialog('바우처 QR 스캔'), body = d.querySelector('.ops-dialog-content');
    body.innerHTML = '<video playsinline muted></video><p role="status">카메라 연결 중...</p>';
    const say = text => { const p = body.querySelector('p'); if (p) p.textContent = text; };
    if (!navigator.mediaDevices?.getUserMedia) { say('이 브라우저에서는 카메라를 쓸 수 없어요. 학생 화면의 인증키 8자리를 입력해 주세요.'); return; }
    try {
      const capture = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      if (!d.isConnected) { capture.getTracks().forEach(t => t.stop()); return; }
      stream = capture;
      const video = body.querySelector('video');
      video.srcObject = stream; await video.play();
      const read = await reader(video);
      if (!d.isConnected) return;
      say('학생 화면의 바우처 QR을 비춰 주세요.');
      const tick = async () => {
        if (!d.isConnected) return;
        try {
          const code = (await read()).map(normalize).find(v => CODE.test(v));
          if (code) { close(); onCode(code); return; }
        } catch { /* Try the next camera frame. */ }
        timer = setTimeout(tick, 200);
      };
      tick();
    } catch (e) {
      if (d.isConnected) say(String(e?.message).startsWith('JSQR') ? 'QR 인식 도구를 불러오지 못했어요. 인증키 8자리를 입력해 주세요.' : '카메라 권한을 확인해 주세요. 허용하지 않으면 인증키 8자리를 입력해 주세요.');
    }
  }

  // result: the festival_voucher_redeem 'redeem' answer.
  function approved(result) {
    const d = dialog('바우처 사용 승인'), body = d.querySelector('.ops-dialog-content');
    const at = result.redeemedAt ? new Date(result.redeemedAt) : new Date();
    const when = at.toLocaleString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' });
    const rows = [['바우처', result.title || KINDS[result.kind] || '바우처'], ['이름', result.participant || '-'], ['학번', result.studentNumber || '-'], ['승인 일시', when]];
    body.innerHTML = `<div class="ops-voucher-done used" role="status" aria-live="assertive">${icon('check')}<strong>사용 승인이 완료되었어요</strong><p>상품을 전달해 주세요.</p></div>
      <dl class="voucher-approved-list">${rows.map(([k, v]) => `<div><dt>${h(k)}</dt><dd>${h(v)}</dd></div>`).join('')}</dl>
      <button type="button" class="primary-btn" data-voucher-approved-ok>확인</button>`;
    body.querySelector('[data-voucher-approved-ok]').onclick = close;
    body.querySelector('[data-voucher-approved-ok]').focus();
  }

  return { scan, approved, close, normalize, CODE };
})();
