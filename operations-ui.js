/* Real operations UI. All authorization and rewards remain in guarded server RPCs. */
const festivalOpsUI = (() => {
  let owner=null, mine=null, catalog=[], event=null, busy=false, loading=false, loaded=false, failure='';
  let tab='dashboard', data=null, offset=0, search='', selectedBooth='', selectedRule='';
  let stream=null, cameraTimer=null, qrTimer=null;
  let lastRoute=null;
  const labels={dashboard:'운영 현황',catalog:'부스 관리',participants:'참여자',visits:'방문 기록',ledger:'포인트',rules:'바우처 설정',vouchers:'발급·사용',audit:'처리 기록',nfc:'NFC 발급'};
  const h=value=>escapeHtml(String(value ?? ''));
  const api=()=>festivalAccount?.operations;
  const active=()=>isServerMode() && !!state.user;
  const snapshot=()=>owner===state.user?.id ? mine : null;
  const statusName=value=>({preparing:'준비 중',open:'운영 중',paused:'일시 중지',closed:'종료',available:'사용 가능',used:'사용 완료',void:'취소'})[value] || value;
  const time=value=>value ? new Date(value).toLocaleString('ko-KR') : '-';
  const field=(name,label,value='',extra='',type='text')=>`<label>${h(label)}<input class="input" name="${name}" type="${type}" value="${h(value)}" ${extra}></label>`;
  const select=(name,label,options,value)=>`<label>${h(label)}<select class="select" name="${name}">${options.map(([id,text])=>`<option value="${h(id)}" ${String(id)===String(value)?'selected':''}>${h(text)}</option>`).join('')}</select></label>`;
  const form=(action,body,submit='저장')=>`<form class="ops-form" data-ops-form="${action}">${body}<p class="ops-form-status" role="status"></p><button class="primary-btn" type="submit">${icon('save')} ${submit}</button></form>`;
  const reason=()=>field('reason','처리 사유','','required minlength="3" maxlength="300"');
  const participant=()=>field('userId','참여자 번호','','required min="1" step="1"','number');
  const options=()=>catalog.map(b=>[b.key,b.name]);

  function reset() {
    owner=state.user?.id || null; mine=null; catalog=[]; event=null; data=null; loaded=false; failure=''; tab='dashboard';
    closeDialog();
  }
  function mergeCatalog() {
    state.db.booths.filter(b=>!b.opsRecord).forEach(b=>{b.status='unregistered';});
    for(const remote of catalog) {
      let b=state.db.booths.find(x=>boothKeyFor(x)===remote.key);
      if(!b) {
        b={id:remote.key,category:'additional',room:'',favorite:false,aliases:[],imageKind:'initial',opsKey:remote.key};
        state.db.booths.push(b);
      }
      Object.assign(b,{opsKey:remote.key,opsRecord:remote,name:remote.name,status:remote.status,
        description:remote.description || b.description,location:remote.location || '위치 미등록'});
      // Existing map geometry is not reassigned by an imported default floor.
      if(remote.location || b.category==='additional') b.floor=remote.floor;
    }
    if(event) state.db.event={...state.db.event,name:event.name,emergencyMode:event.state==='paused'};
  }
  async function refresh(repaint=true) {
    if(!active() || !api() || loading) return;
    const actor=state.user.id;
    if(owner!==actor) reset();
    loading=true;
    try {
      const a=await api().read('catalog');
      const b=await api().read('me');
      if(state.user?.id!==actor) return;
      if(!a.ok || !b.ok) { failure=(a.ok?b:a).message; loaded=true; return; }
      catalog=a.data.items || []; mine=b.data; event=a.data.event || null; failure=''; loaded=true;
      mergeCatalog();
      serverMyReviews=new Set((mine.reviews || []).map(x=>x.booth_key));
      for(const r of mine.reviews || []) {
        const before=serverReviews.get(r.booth_key);
        if(before) serverReviews.set(r.booth_key,{...before,myRating:r.rating,reviews:[...before.reviews.filter(x=>!x.mine),{rating:r.rating,content:r.content,mine:true,author:'나',createdAt:r.created_at}]});
      }
      if(state.route==='admin' && isAdminUser() && tab!=='nfc') {
        if(tab==='catalog') data=a.data;
        else {
          const r=await api().read(tab,{offset,search});
          if(state.user?.id!==actor) return;
          if(r.ok) data=r.data; else failure=r.message;
        }
      }
    } finally {
      loading=false;
      if(repaint && state.user?.id===actor) {
        if(state.route!=='admin' && document.activeElement?.matches('input,textarea')) {
          updateCatalogDom(); festivalWeb.refreshIndicators();
        } else render();
      }
      else if(active() && state.user.id!==actor) queueMicrotask(()=>refresh());
    }
  }
  function navigation() {
    return `<nav class="ops-nav" aria-label="운영 메뉴"><select id="opsTab" class="select" aria-label="운영 메뉴">${Object.entries(labels).map(([id,label])=>`<option value="${id}" ${tab===id?'selected':''}>${label}</option>`).join('')}</select><button class="icon-btn" data-ops-refresh aria-label="새로고침" title="새로고침">${icon('refresh')}</button></nav>`;
  }
  function eventForm() {
    return `<section class="ops-section"><h2>행사 설정</h2>${form('event_save',
      field('name','행사 이름',event?.name || '', 'required maxlength="100"')+
      select('state','운영 상태',Object.entries({preparing:'준비 중',open:'운영 중',paused:'일시 중지',closed:'종료'}),event?.state || 'preparing')+
      field('reviewPoints','글 후기 최초 등록 포인트',event?.review_points || 0,'required min="0" max="1000" step="1"','number')+
      `<input type="hidden" name="version" value="${event?.version || 0}">`)}</section>`;
  }
  function table(rows,cols) {
    if(!rows?.length) return '<p class="ops-empty">기록이 없어요.</p>';
    return `<div class="ops-table-wrap" tabindex="0" aria-label="${h(labels[tab])} 목록"><table><thead><tr>${cols.map(([label])=>`<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${cols.map(([,key])=>`<td>${h(typeof key==='function'?key(row):row[key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  function searchForm() {
    return `<form id="opsSearch" class="ops-search"><input class="input" name="search" value="${h(search)}" placeholder="이름 또는 참여자 번호" aria-label="검색"><button class="icon-btn" title="검색" aria-label="검색">${icon('search')}</button></form>`;
  }
  function paging() {
    return `<div class="ops-paging"><button class="icon-btn" data-ops-page="-50" ${offset?'':'disabled'} aria-label="이전 페이지">${icon('back')}</button><span>${Math.floor(offset/50)+1}페이지</span><button class="icon-btn" data-ops-page="50" ${(data?.items?.length || 0)<50?'disabled':''} aria-label="다음 페이지">${icon('arrow')}</button></div>`;
  }
  function boothForm() {
    const b=catalog.find(x=>x.key===selectedBooth);
    return `<section class="ops-section"><h2>${b?'부스 수정':'부스 추가'}</h2><label>편집할 부스<select id="opsBoothSelect" class="select"><option value="">새 부스</option>${options().map(([key,name])=>`<option value="${h(key)}" ${key===selectedBooth?'selected':''}>${h(name)}</option>`).join('')}</select></label>${form('booth_save',
      field('name','부스 이름',b?.name,'required maxlength="100"')+field('location','위치',b?.location,'maxlength="200"')+
      select('floor','층',[[1,'1층'],[2,'2층'],[3,'3층'],[4,'4층']],b?.floor || 1)+
      select('status','운영 상태',[['paused','일시 중지'],['open','운영 중'],['closed','마감']],b?.status || 'paused')+
      `<label>프로그램 안내<textarea class="textarea" name="description" maxlength="2000">${h(b?.description)}</textarea></label><input type="hidden" name="booth" value="${h(b?.key)}"><input type="hidden" name="version" value="${b?.version || 0}">`)}</section>`;
  }
  function ruleForm() {
    const r=(data?.items || []).find(x=>x.id===selectedRule);
    return `<section class="ops-section"><h2>${r?'발급 기준 수정':'발급 기준 추가'}</h2><label>편집할 기준<select id="opsRuleSelect" class="select"><option value="">새 발급 기준</option>${(data?.items || []).map(x=>`<option value="${h(x.id)}" ${x.id===selectedRule?'selected':''}>${h(x.title)}</option>`).join('')}</select></label>${form('rule_save',
      field('title','바우처 이름',r?.title,'required maxlength="100"')+
      field('target','필요한 완성 스탬프',r?.target || 5,'required min="1" max="500" step="1"','number')+
      field('stock','총 발급 한도',r?.stock || 0,'required min="0" max="100000" step="1"','number')+
      field('expiresAt','사용 마감 (한국 시간)',r?.expires_at ? new Date(new Date(r.expires_at).getTime()+9*3600000).toISOString().slice(0,16) : '', 'required','datetime-local')+
      `<label class="ops-checkbox"><input name="enabled" type="checkbox" ${r?.enabled?'checked':''}>자동 발급 활성화</label><input type="hidden" name="id" value="${h(r?.id)}"><input type="hidden" name="version" value="${r?.version || 0}">`)}</section>`;
  }
  function content() {
    if(!event) return eventForm();
    if(tab==='dashboard') return `<dl class="ops-stats">${[['방문 참여자',data?.participants],['방문',data?.visits],['리뷰',data?.reviews],['발급',data?.issued],['사용',data?.used]].map(([k,v])=>`<div><dt>${k}</dt><dd>${v ?? '-'}</dd></div>`).join('')}</dl>${eventForm()}`;
    if(tab==='catalog') return boothForm()+table(catalog,[['부스','name'],['위치','location'],['상태',r=>statusName(r.status)]]);
    if(tab==='participants') return searchForm()+table(data?.items,[['번호','id'],['이름','name'],['방문','visits'],['포인트','points']])+paging();
    if(tab==='visits') return `<section class="ops-section"><h2>수동 방문 승인</h2>${form('visit_approve',participant()+select('booth','방문 부스',options(),null)+reason(),'방문 승인')}</section>`+searchForm()+table(data?.items,[['시각',r=>time(r.created_at)],['참여자',r=>`${r.name} (#${r.user_id})`],['부스','booth_key'],['방식','method'],['사유','reason']])+paging();
    if(tab==='ledger') return `<section class="ops-section"><h2>포인트 조정</h2>${form('points_adjust',participant()+field('delta','변경 포인트 (+지급 / -차감)','','required min="-100000" max="100000" step="1"','number')+reason(),'조정 확정')}</section>`+searchForm()+table(data?.items,[['시각',r=>time(r.created_at)],['참여자',r=>`${r.name} (#${r.user_id})`],['변경','delta'],['사유','reason']])+paging();
    if(tab==='rules') return ruleForm()+table(data?.items,[['이름','title'],['목표','target'],['발급','issued'],['한도','stock'],['활성',r=>r.enabled?'예':'아니오']]);
    if(tab==='vouchers') return `<section class="ops-section"><h2>바우처 사용</h2><form id="opsRedeem" class="ops-form"><label>QR 인증 코드<input class="input" name="token" autocomplete="off" spellcheck="false" required pattern="fv1\\.[0-9a-f]{64}"></label><p class="ops-form-status" role="status"></p><div class="ops-actions"><button class="icon-btn" type="button" data-ops-camera title="QR 스캔" aria-label="QR 스캔">${icon('scan')}</button><button class="primary-btn" type="submit">바우처 확인</button></div></form></section><section class="ops-section"><h2>수동 발급</h2>${form('voucher_issue',participant()+select('ruleId','바우처', (mine?.rules || []).map(r=>[r.id,r.title]),null)+reason(),'발급 확정')}</section><section class="ops-section"><h2>발급 취소</h2>${form('voucher_void',select('id','취소할 바우처',(data?.items || []).filter(v=>v.state==='available').map(v=>[v.id,`${v.name} · ${v.title}`]),null)+reason(),'취소 확정')}</section>`+searchForm()+table(data?.items,[['참여자','user_id'],['이름','name'],['바우처','title'],['상태',r=>statusName(r.state)],['마감',r=>time(r.expires_at)]])+paging();
    return table(data?.items,[['시각',r=>time(r.created_at)],['처리자','actor_id'],['작업','action'],['대상','target'],['사유','reason']])+paging();
  }
  function admin() {
    if(tab==='nfc') return serverAdminView();
    return `<main class="screen ops-screen"><header class="top-bar"><button class="icon-btn" data-route="home" aria-label="홈으로">${icon('back')}</button><div class="top-title"><strong>운영자 도구</strong><span>${h(event?.name || '행사 준비')}</span></div></header>${navigation()}<div class="ops-body"><h1>${labels[tab]}</h1>${failure?`<p class="ops-alert" role="alert">${h(failure)}</p>`:''}${!loaded?'<p role="status">불러오는 중...</p>':failure&&!event?'':content()}</div>${bottomNav('admin')}</main>`;
  }
  async function save(e) {
    e.preventDefault(); if(busy) return;
    const form=e.currentTarget, action=form.dataset.opsForm, body=Object.fromEntries(new FormData(form)), note=form.querySelector('.ops-form-status');
    for(const key of ['version','floor','reviewPoints','delta','userId','stock','target']) if(key in body) body[key]=Number(body[key]);
    for(const key of ['id','booth']) if(body[key]==='') body[key]=null;
    if(action==='rule_save') { body.enabled=form.elements.enabled.checked; body.expiresAt=new Date(body.expiresAt+':00+09:00').toISOString(); }
    if(['event_save','points_adjust','visit_approve','voucher_issue','voucher_void'].includes(action) && !confirm('입력한 내용으로 처리할까요?')) return;
    busy=true; form.querySelector('button[type=submit]').disabled=true; note.textContent='처리 중...';
    try {
      const response=await api().write(action,body);
      if(!response.ok) { note.textContent=response.message; return; }
      selectedBooth=response.data.booth || selectedBooth; selectedRule=response.data.id && action==='rule_save'?response.data.id:selectedRule;
      await refresh();
    } finally { busy=false; if(form.isConnected) form.querySelector('button[type=submit]').disabled=false; }
  }
  async function redeem(e) {
    e.preventDefault(); if(busy) return;
    const form=e.currentTarget, note=form.querySelector('.ops-form-status'), token=form.elements.token.value.trim();
    busy=true;
    try {
      const preview=await api().read('voucher_check',{token});
      if(!preview.ok) { note.textContent=preview.message; return; }
      if(!preview.data.valid) { note.textContent='사용할 수 없거나 만료된 QR이에요.'; return; }
      if(!confirm(`${preview.data.title}\n${preview.data.participant}\n상품을 전달하고 사용 완료로 처리할까요?`)) return;
      const r=await api().write('voucher_redeem',{token});
      if(!r.ok) { note.textContent=r.message; return; }
      form.reset(); await refresh();
    } finally { busy=false; }
  }
  function closeDialog() {
    stream?.getTracks().forEach(t=>t.stop()); stream=null;
    clearTimeout(cameraTimer); clearInterval(qrTimer); cameraTimer=null; qrTimer=null;
    document.querySelector('.ops-dialog')?.remove();
  }
  function dialog(title) {
    closeDialog(); const d=document.createElement('dialog'); d.className='ops-dialog';
    d.innerHTML=`<header><h2>${h(title)}</h2><button class="icon-btn" aria-label="닫기">${icon('close')}</button></header><div class="ops-dialog-content"></div>`;
    d.querySelector('button').onclick=closeDialog; d.addEventListener('cancel',e=>{e.preventDefault();closeDialog();});
    document.body.append(d); d.showModal(); return d;
  }
  async function camera() {
    const note=document.querySelector('#opsRedeem .ops-form-status');
    if(!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) { note.textContent='이 브라우저에서는 QR 스캔을 지원하지 않아요. 참여자의 인증 코드를 입력해 주세요.'; return; }
    const d=dialog('바우처 QR 스캔'), body=d.querySelector('.ops-dialog-content');
    body.innerHTML='<video playsinline muted></video><p role="status">카메라 연결 중...</p>';
    try {
      const capture=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false});
      if(!d.isConnected) { capture.getTracks().forEach(t=>t.stop()); return; }
      stream=capture; const video=body.querySelector('video'); video.srcObject=stream; await video.play();
      const detector=new BarcodeDetector({formats:['qr_code']});
      body.querySelector('p').textContent='바우처 QR을 비춰 주세요.';
      const tick=async()=>{
        if(!d.isConnected) return;
        try {
          const list=await detector.detect(video); const found=list.find(x=>/^fv1\.[0-9a-f]{64}$/.test(x.rawValue));
          if(found) { const f=document.querySelector('#opsRedeem'); if(f){f.elements.token.value=found.rawValue;closeDialog();f.requestSubmit();} return; }
        } catch { /* Try the next camera frame. */ }
        cameraTimer=setTimeout(tick,250);
      }; tick();
    } catch { if(d.isConnected) body.querySelector('p').textContent='카메라 권한을 확인해 주세요.'; }
  }
  async function qr(id) {
    const d=dialog('바우처 사용'), body=d.querySelector('.ops-dialog-content'); body.innerHTML='<p role="status">QR 준비 중...</p>';
    const r=await api().write('voucher_qr',{id}); if(!d.isConnected) return;
    if(!r.ok) { body.textContent=r.message; return; }
    const code=qrcode(0,'M'); code.addData(r.data.token); code.make();
    body.innerHTML=`<div class="ops-qr" role="img" aria-label="바우처 인증 QR">${code.createSvgTag({cellSize:5,margin:16,scalable:true})}</div><p role="status"></p><button class="ghost-btn" data-copy-code>${icon('copy')} 인증 코드 복사</button><button class="ghost-btn" data-new-qr>${icon('refresh')} QR 새로고침</button>`;
    body.querySelector('[data-copy-code]').onclick=async()=>{try{await navigator.clipboard.writeText(r.data.token);}catch{body.querySelector('p').textContent='복사 권한을 확인해 주세요.';}};
    body.querySelector('[data-new-qr]').onclick=()=>qr(id);
    const update=()=>{const left=Math.max(0,Math.ceil((new Date(r.data.expiresAt)-Date.now())/1000)); body.querySelector('p').textContent=left?`${left}초 남음`:'QR이 만료됐어요.'; if(!left){clearInterval(qrTimer);body.querySelector('.ops-qr').replaceChildren();body.querySelector('[data-copy-code]').disabled=true;}};
    update(); qrTimer=setInterval(update,1000);
  }
  function vouchers() {
    const me=snapshot();
    return `<main class="screen web-page">${festivalWeb.header('나의 바우처','축제에서 모은 혜택')}<div class="ops-vouchers">${failure?`<p role="alert">${h(failure)}</p>`:''}${(me?.vouchers || []).map(c=>{const valid=c.state==='available'&&new Date(c.expiresAt)>new Date();return `<article class="ops-voucher"><div>${icon('ticket')}<h2>${h(c.title)}</h2></div><p>${h(time(c.expiresAt))}까지</p>${valid?`<button class="primary-btn" data-ops-qr="${h(c.id)}">QR 보기</button>`:`<strong>${h(c.state==='available'?'만료':statusName(c.state))}</strong>`}</article>`;}).join('') || `<p class="ops-empty">${loaded?'아직 발급된 바우처가 없어요.':'불러오는 중...'}</p>`}${(me?.rules || []).map(r=>`<div class="ops-rule"><span>${h(r.title)} · 스탬프 ${r.target}개</span><button class="ghost-btn" data-ops-claim="${h(r.id)}" ${(me.reviews || []).length<r.target?'disabled':''}>받기</button></div>`).join('')}<p id="opsVoucherStatus" role="status"></p></div>${bottomNav('vouchers')}</main>`;
  }
  function bind() {
    if(!active()) { if(owner) reset(); return; }
    const changed=lastRoute!==state.route; lastRoute=state.route;
    if(owner!==state.user.id || !loaded || (changed && ['admin','map','vouchers','stamps','reviews'].includes(state.route))) queueMicrotask(()=>refresh());
    document.querySelector('#opsTab')?.addEventListener('change',async e=>{tab=e.target.value;offset=0;search='';data=null;await refresh();});
    document.querySelectorAll('[data-ops-refresh]').forEach(b=>b.onclick=()=>refresh());
    document.querySelectorAll('[data-ops-form]').forEach(f=>f.addEventListener('submit',save));
    document.querySelector('#opsBoothSelect')?.addEventListener('change',e=>{selectedBooth=e.target.value;render();});
    document.querySelector('#opsRuleSelect')?.addEventListener('change',e=>{selectedRule=e.target.value;render();});
    document.querySelector('#opsSearch')?.addEventListener('submit',e=>{e.preventDefault();search=e.target.elements.search.value;offset=0;refresh();});
    document.querySelectorAll('[data-ops-page]').forEach(b=>b.onclick=()=>{offset=Math.max(0,offset+Number(b.dataset.opsPage));refresh();});
    document.querySelector('#opsRedeem')?.addEventListener('submit',redeem);
    document.querySelector('[data-ops-camera]')?.addEventListener('click',camera);
    document.querySelectorAll('[data-ops-qr]').forEach(b=>b.onclick=()=>qr(b.dataset.opsQr));
    document.querySelectorAll('[data-ops-claim]').forEach(b=>b.onclick=async()=>{b.disabled=true;const r=await api().write('voucher_claim',{ruleId:b.dataset.opsClaim});if(r.ok)await refresh();else{document.querySelector('#opsVoucherStatus').textContent=r.message;b.disabled=false;}});
    if(!['admin','vouchers'].includes(state.route)) closeDialog();
  }
  return {admin,navigation,refresh,bind,snapshot,vouchers,reset};
})();
