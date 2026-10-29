/* Real operations UI. All authorization and rewards remain in guarded server RPCs. */
const festivalOpsUI = (() => {
  let owner=null, mine=null, catalog=[], event=null, busy=false, loading=false, loaded=false, failure='';
  let tab='dashboard', data=null, offset=0, search='', selectedBooth=null, selectedRule='';
  let stream=null, cameraTimer=null, qrTimer=null;
  let lastRoute=null;
  let refreshQueued=false, queuedRepaint=false, notice='';
  let refreshWaiters=[];
  let visitRecipient=null;
  let visitSyncPending=false, visitSyncGeneration=0;
  const labels={dashboard:'운영 현황',tools:'관리 도구',catalog:'부스 관리',participants:'참여자',visits:'방문 기록',ledger:'포인트',rules:'바우처 설정',vouchers:'발급·사용',audit:'처리 기록',nfc:'NFC 발급','stamp-simulator':'스탬프 모의 발급',settings:'축제 운영 설정'};
  const localTabs=new Set(['tools','nfc','stamp-simulator','settings']);
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
  const participant=(label='처리할 참여자')=>`<div class="ops-recipient"><span id="visitRecipientLabel">${h(label)}</span><input type="hidden" name="userId" value="${h(visitRecipient?.id || '')}"><button type="button" class="ops-recipient-button" data-pick-participant aria-labelledby="visitRecipientLabel visitRecipientName">${icon('user')}<span id="visitRecipientName">${h(visitRecipient?.name || '참여자 선택')}</span>${icon('search')}</button></div>`;
  const visitParticipant=()=>participant('스탬프를 받을 참여자');
  const options=()=>catalog.map(b=>[b.key,b.name]);
  const currentEventReady=()=>Boolean(event?.id && Number.isInteger(event.version) && event.version>0);

  function reset() {
    owner=state.user?.id || null; mine=null; catalog=[]; event=null; data=null; loaded=false; failure=''; notice=''; tab='dashboard'; selectedBooth=null; selectedRule='';
    visitRecipient=null; visitSyncPending=false; visitSyncGeneration++; closeDialog();
  }
  const viewKey=()=>JSON.stringify([state.user?.id,state.route,tab,offset,search]);
  function selectTab(next) {
    if(!Object.hasOwn(labels,next)) return;
    if(owner!==state.user?.id) reset();
    tab=next; offset=0; search=''; data=null; failure=''; notice=''; loaded=localTabs.has(next);
    visitRecipient=null;
    closeDialog();
    render();
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
    if(!active() || !api()) return;
    if(loading) { refreshQueued=true; queuedRepaint ||= repaint; return new Promise(resolve=>refreshWaiters.push(resolve)); }
    const actor=state.user.id;
    if(owner!==actor) reset();
    const requestedView=viewKey(), requestedTab=tab, query={offset,search};
    const requestedGeneration=visitSyncGeneration;
    loading=true;
    try {
      const [a,b,rewards]=await Promise.all(['catalog','me','reward_status'].map(kind=>api().read(kind)));
      if(state.user?.id!==actor || requestedView!==viewKey()) return {ok:false};
      if(!a.ok || !b.ok) { failure=(a.ok?b:a).message; loaded=true; return {ok:false}; }
      if(event?.id!==a.data.event?.id) visitRecipient=null;
      catalog=a.data.items || []; mine=b.data; event=a.data.event || null; failure=''; loaded=true;
      if(requestedGeneration===visitSyncGeneration) visitSyncPending=false;
      const program=rewards.data, kinds=['photo','food'];
      const validProgram=rewards.ok && program?.version===2 && program.eventId===event?.id
        && Number.isInteger(program.firstTarget) && program.firstTarget>=3 && program.firstTarget%6===3
        && program.secondTarget===program.firstTarget+3 && Number.isInteger(program.issuedCount) && program.issuedCount>=0
        && typeof program.ready==='boolean' && Number.isInteger(program.count) && program.count>=0
        && (program.firstChoice===null || kinds.includes(program.firstChoice))
        && typeof program.secondIssued==='boolean' && typeof program.canChoose==='boolean'
        && Array.isArray(program.options) && program.options.every(o=>o && kinds.includes(o.kind) && typeof o.title==='string' && typeof o.available==='boolean')
        && new Set(program.options.map(o=>o.kind)).size===program.options.length
        && (!program.ready || program.options.length===2);
      mine.rewardProgram=validProgram ? {...program,supported:true} : {ready:false,supported:false,legacyRules:rewards.code==='OPS_NOT_READY'};
      mergeCatalog();
      serverMyReviews=new Set((mine.reviews || []).map(x=>x.booth_key));
      for(const r of mine.reviews || []) {
        const before=serverReviews.get(r.booth_key);
        if(before) serverReviews.set(r.booth_key,{...before,myRating:r.rating,reviews:[...before.reviews.filter(x=>!x.mine),{rating:r.rating,content:r.content,mine:true,author:r.author_name || '참여자',createdAt:r.created_at}]});
      }
      if(state.route==='admin' && isAdminUser() && !localTabs.has(requestedTab)) {
        if(requestedTab==='catalog') data=a.data;
        else {
          const r=await api().read(requestedTab,query);
          if(state.user?.id!==actor || requestedView!==viewKey()) return;
          if(r.ok) data=r.data; else failure=r.message;
        }
      }
    } catch {
      if(state.user?.id===actor && requestedView===viewKey()) {
        failure='운영 정보를 불러오지 못했어요. 새로고침해 주세요.'; loaded=true;
      }
    } finally {
      loading=false;
      const again=refreshQueued || requestedView!==viewKey(), paint=repaint || queuedRepaint;
      refreshQueued=false; queuedRepaint=false;
      if(active() && again) await refresh(paint);
      else if(repaint && state.user?.id===actor) {
        if(state.route!=='admin' && document.activeElement?.matches('input,textarea')) {
          updateCatalogDom(); festivalWeb.refreshIndicators();
        } else render();
      }
      const waiters=refreshWaiters; refreshWaiters=[]; waiters.forEach(resolve=>resolve({ok:owner===state.user?.id && loaded && !failure}));
    }
    return {ok:owner===actor && state.user?.id===actor && loaded && !failure};
  }
  function navigation() {
    const group=tab==='dashboard'?'dashboard':tab==='audit'?'audit':'tools';
    return `<nav class="festival-ops-tabs" aria-label="운영자 화면"><div>${[['dashboard','현황'],['tools','관리 도구'],['audit','기록']].map(([id,label])=>`<button type="button" data-ops-tab="${id}" aria-current="${group===id?'page':'false'}">${label}</button>`).join('')}</div><button class="icon-btn" data-ops-refresh aria-label="새로고침" title="새로고침">${icon('refresh')}</button></nav>${!['dashboard','tools','audit'].includes(tab) ? '<button type="button" class="text-link festival-tool-back" data-ops-tab="tools">'+icon('back')+' 관리 도구 목록</button>' : ''}`;
  }
  function toolsMenu() {
    const tools=[['catalog','map','부스 상태·프로그램'],['nfc','scan','NFC 태그 발급'],['visits','stamp','방문 수동 승인'],['participants','user','참여자·동아리 명단'],['ledger','plus','포인트 조정'],['rules','ticket','바우처 지급 기준'],['vouchers','scan','바우처 발급·사용'],['stamp-simulator','stamp','스탬프 모의 발급'],['settings','admin','축제 운영 설정']];
    return `<nav class="festival-ops-tools" aria-label="관리 도구">${tools.map(([id,symbol,label])=>`<button type="button" data-ops-tab="${id}"><span class="festival-tool-icon">${icon(symbol)}</span><strong>${label}</strong>${icon('arrow')}</button>`).join('')}</nav>`;
  }
  function eventForm() {
    if(!currentEventReady()) return '';
    return `<section class="ops-section" aria-label="축제 운영 설정">${form('event_save',
      field('name','축제 이름',event.name, 'required maxlength="100"')+
      select('state','운영 상태',Object.entries({preparing:'준비 중',open:'운영 중',paused:'일시 중지',closed:'종료'}),event.state)+
      field('reviewPoints','글 후기 최초 등록 포인트',event.review_points ?? 0,'required min="0" max="1000" step="1"','number')+
      `<input type="hidden" name="version" value="${event.version}">`,'운영 설정 저장')}</section>`;
  }
  function unavailableEvent() {
    return `<section class="ops-section ops-unavailable" role="status"><h2>축제 정보를 확인할 수 없어요</h2><p>운영 정보를 다시 불러와 주세요. 계속 표시되면 담당자에게 확인해 주세요.</p><button type="button" class="ghost-btn" data-ops-refresh>${icon('refresh')} 다시 불러오기</button></section>`;
  }
  function boothReadiness() {
    const counts={open:0,paused:0,closed:0};
    for(const booth of catalog) if(Object.hasOwn(counts,booth.status)) counts[booth.status]++;
    return `<section class="ops-section ops-readiness"><h2>부스 운영 상태</h2><dl class="ops-booth-counts">${Object.entries(counts).map(([status,count])=>`<div><dt>${statusName(status)}</dt><dd>${count}<span>개</span></dd></div>`).join('')}</dl>${event.state!=='open'?'<p class="ops-alert">축제가 운영 중이 아니어서 방문 인증이 중지돼 있어요.</p>':counts.open===0?'<p class="ops-alert">운영 중인 부스가 없어 방문 인증이 중지돼 있어요.</p>':''}<button type="button" class="ghost-btn" data-ops-tab="catalog">${icon('map')} 부스 상태 관리</button></section>`;
  }
  function table(rows,cols) {
    if(!rows?.length) return '<p class="ops-empty">기록이 없어요.</p>';
    return `<div class="ops-table-wrap" tabindex="0" aria-label="${h(labels[tab])} 목록"><table><thead><tr>${cols.map(([label])=>`<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${cols.map(([,key])=>`<td>${h(typeof key==='function'?key(row):row[key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  function searchForm() {
    return `<form id="opsSearch" class="ops-search"><input class="input" name="search" value="${h(search)}" placeholder="${tab==='visits'?'참여자 이름 검색':'이름 또는 참여자 번호'}" aria-label="검색"><button class="icon-btn" title="검색" aria-label="검색">${icon('search')}</button></form>`;
  }
  function paging() {
    return `<div class="ops-paging"><button class="icon-btn" data-ops-page="-50" ${offset?'':'disabled'} aria-label="이전 페이지">${icon('back')}</button><span>${Math.floor(offset/50)+1}페이지</span><button class="icon-btn" data-ops-page="50" ${(data?.items?.length || 0)<50?'disabled':''} aria-label="다음 페이지">${icon('arrow')}</button></div>`;
  }
  function boothForm() {
    const b=selectedBooth===null ? catalog[0] : catalog.find(x=>x.key===selectedBooth);
    return `<section class="ops-section"><h2>${b?'부스 수정':'부스 추가'}</h2><label>편집할 부스<select id="opsBoothSelect" class="select"><option value="" ${!b?'selected':''}>새 부스</option>${options().map(([key,name])=>`<option value="${h(key)}" ${key===b?.key?'selected':''}>${h(name)}</option>`).join('')}</select></label>${form('booth_save',
      field('name','부스 이름',b?.name,'required maxlength="100"')+field('location','위치',b?.location,'maxlength="200"')+
      select('floor','층',[[1,'1층'],[2,'2층'],[3,'3층'],[4,'4층']],b?.floor || 1)+
      select('status','운영 상태',[['paused','일시 중지'],['open','운영 중'],['closed','마감']],b?.status || 'paused')+
      `<label>프로그램 안내<textarea class="textarea" name="description" maxlength="2000">${h(b?.description)}</textarea></label><input type="hidden" name="booth" value="${h(b?.key)}"><input type="hidden" name="version" value="${b?.version || 0}">`)}</section>`;
  }
  function ruleForm() {
    const rules=(data?.items || []).filter(x=>!x.reward_kind);
    const r=rules.find(x=>x.id===selectedRule);
    return `<section class="ops-section"><h2>${r?'발급 기준 수정':'발급 기준 추가'}</h2><label>편집할 기준<select id="opsRuleSelect" class="select"><option value="">새 발급 기준</option>${rules.map(x=>`<option value="${h(x.id)}" ${x.id===selectedRule?'selected':''}>${h(x.title)}</option>`).join('')}</select></label>${form('rule_save',
      field('title','바우처 이름',r?.title,'required maxlength="100"')+
      field('target','필요한 완성 스탬프',r?.target || 5,'required min="1" max="500" step="1"','number')+
      field('stock','총 발급 한도',r?.stock || 0,'required min="0" max="100000" step="1"','number')+
      field('expiresAt','사용 마감 (한국 시간)',r?.expires_at ? new Date(new Date(r.expires_at).getTime()+9*3600000).toISOString().slice(0,16) : '', 'required','datetime-local')+
      `<label class="ops-checkbox"><input name="enabled" type="checkbox" ${r?.enabled?'checked':''}>자동 발급 활성화</label><input type="hidden" name="id" value="${h(r?.id)}"><input type="hidden" name="version" value="${r?.version || 0}">`)}</section>`;
  }
  function rewardConfigForm() {
    const reward=snapshot()?.rewardProgram;
    const photo=reward?.options?.find(o=>o.kind==='photo'), food=reward?.options?.find(o=>o.kind==='food');
    return `<section class="ops-section"><h2>스탬프 3개마다 바우처</h2>${form('reward_config',
      field('photoStock','포토부스 이용권 총 수량',photo?.stock ?? 0,'required min="0" max="100000" step="1"','number')+
      field('foodStock','푸드트럭 교환권 총 수량',food?.stock ?? 0,'required min="0" max="100000" step="1"','number')+
      field('expiresAt','이용권 사용 마감 (한국 시간)',photo?.expiresAt ? new Date(new Date(photo.expiresAt).getTime()+9*3600000).toISOString().slice(0,16) : '', 'required','datetime-local')+
      `<label class="ops-checkbox"><input name="enabled" type="checkbox" ${reward?.ready?'checked':''}>바우처 실제 지급 활성화</label>`+
      `<input type="hidden" name="eventId" value="${h(event?.id)}"><input type="hidden" name="photoVersion" value="${photo?.version || 0}"><input type="hidden" name="foodVersion" value="${food?.version || 0}">`,'지급 기준 저장')}</section>`;
  }
  async function chooseReward(kind,firstTarget) {
    const actor=state.user?.id, reward=snapshot()?.rewardProgram;
    if(!reward?.ready || !event) return {ok:false,message:'바우처 발급 준비 중이에요.'};
    const response=await api().write('reward_choose',{kind,firstTarget,eventId:event.id});
    if(state.user?.id!==actor) return {ok:false,message:'다시 로그인해 주세요.'};
    await refresh(false);
    return response;
  }
  function manualVoucherForm() {
    const rules=(mine?.rules || []).filter(r=>!r.reward_kind);
    if(!rules.length) return '<p>발급 가능한 바우처 기준이 없어요.</p><button type="button" class="ghost-btn" data-ops-tab="rules">바우처 설정 열기</button>';
    return form('voucher_issue',participant()+select('ruleId','바우처',rules.map(r=>[r.id,r.title]),null)+reason(),'발급 확정');
  }
  function content() {
    if(tab==='tools') return toolsMenu();
    if(!currentEventReady()) return unavailableEvent();
    if(tab==='settings') return eventForm();
    if(tab==='dashboard') return `<div class="festival-op-status ${event.state === 'open' ? '' : 'is-paused'}">${icon(event.state === 'open' ? 'check' : 'notice')}<div><strong>${h(statusName(event.state))}</strong><p>${h(event.name)}</p></div><button type="button" class="icon-btn" data-ops-tab="settings" aria-label="축제 운영 설정" title="축제 운영 설정">${icon('admin')}</button></div><dl class="ops-stats">${[['참여자',data?.participants],['방문',data?.visits],['리뷰',data?.reviews],['바우처 발급',data?.issued],['바우처 사용',data?.used]].map(([k,v])=>`<div><dt>${k}</dt><dd>${v ?? '-'}</dd></div>`).join('')}</dl>${boothReadiness()}<section class="ops-section"><h2>빠른 처리</h2><div class="festival-ops-tools">${[['visits','stamp','수동 방문 승인'],['vouchers','scan','바우처 확인·사용'],['nfc','scan','NFC 태그 발급']].map(([id,symbol,label])=>`<button type="button" data-ops-tab="${id}"><span class="festival-tool-icon">${icon(symbol)}</span><strong>${label}</strong>${icon('arrow')}</button>`).join('')}</div></section>`;
    if(tab==='catalog') return boothForm()+table(catalog,[['부스','name'],['위치','location'],['상태',r=>statusName(r.status)]]);
    if(tab==='participants') return searchForm()+table(data?.items,[['번호','id'],['이름','name'],['방문','visits'],['포인트','points']])+paging()+`<section class="ops-section"><h2>리뷰 실명·소속 확인</h2><form id="reviewRosterLookup" class="ops-form">${select('userId','참여자',(data?.items || []).map(p=>[p.id,`${p.name} (#${p.id})`]),null)}<p role="status"></p><button class="primary-btn" type="submit">명단 확인</button></form></section>`;
    if(tab==='visits') return `<section class="ops-section"><h2>수동 방문 승인</h2>${form('visit_approve',visitParticipant()+select('booth','방문 부스',options().filter(([key])=>catalog.find(b=>b.key===key)?.status==='open'),null)+reason(),'스탬프 1개 승인')}</section>`+table(data?.items,[['시각',r=>time(r.created_at)],['참여자','name'],['부스',r=>catalog.find(b=>b.key===r.booth_key)?.name || r.booth_key],['방식','method'],['사유','reason']])+paging();
    if(tab==='ledger') return `<section class="ops-section"><h2>포인트 조정</h2>${form('points_adjust',participant()+field('delta','변경 포인트 (+지급 / -차감)','','required min="-100000" max="100000" step="1"','number')+reason(),'조정 확정')}</section>`+searchForm()+table(data?.items,[['시각',r=>time(r.created_at)],['참여자',r=>`${r.name} (#${r.user_id})`],['변경','delta'],['사유','reason']])+paging();
    if(tab==='rules') return (mine?.rewardProgram?.supported ? rewardConfigForm() : mine?.rewardProgram?.legacyRules
      ? '<p class="ops-empty">3개마다 반복 지급은 아직 준비 중이에요. 기존 발급 기준은 관리할 수 있어요.</p>'+ruleForm()
      : '<p class="ops-alert" role="alert">반복 지급 설정을 확인하지 못했어요. 새로고침 후 다시 확인해 주세요.</p>')
      +table(data?.items,[['이름','title'],['기준',r=>r.reward_kind?'3개마다 반복 지급':r.target],['발급','issued'],['한도','stock'],['활성',r=>r.enabled?'예':'아니오']]);
    if(tab==='vouchers') return `<section class="ops-section"><h2>바우처 사용</h2><form id="opsRedeem" class="ops-form"><label>QR 인증 코드<input class="input" name="token" autocomplete="off" spellcheck="false" required pattern="fv1\\.[0-9a-f]{64}"></label><p class="ops-form-status" role="status"></p><div class="ops-actions"><button class="icon-btn" type="button" data-ops-camera title="QR 스캔" aria-label="QR 스캔">${icon('scan')}</button><button class="primary-btn" type="submit">바우처 확인</button></div></form></section><section class="ops-section"><h2>수동 발급</h2>${manualVoucherForm()}</section><section class="ops-section"><h2>발급 취소</h2>${form('voucher_void',select('id','취소할 바우처',(data?.items || []).filter(v=>v.state==='available').map(v=>[v.id,`${v.name} · ${v.title}`]),null)+reason(),'취소 확정')}</section>`+searchForm()+table(data?.items,[['참여자','user_id'],['이름','name'],['바우처','title'],['상태',r=>statusName(r.state)],['마감',r=>time(r.expires_at)]])+paging();
    return table(data?.items,[['시각',r=>time(r.created_at)],['처리자','actor_id'],['작업','action'],['대상','target'],['사유','reason']])+paging();
  }
  function admin() {
    if(tab==='nfc') return serverAdminView();
    if(tab==='stamp-simulator') return `<main class="screen ops-screen"><header class="top-bar"><button class="icon-btn" data-route="home" aria-label="홈으로">${icon('back')}</button><div class="top-title"><strong>운영자 도구</strong></div></header>${navigation()}${typeof festivalStampSimulator==='undefined'?'':festivalStampSimulator.view()}${bottomNav('admin')}</main>`;
    return `<main class="screen ops-screen"><header class="top-bar"><button class="icon-btn" data-route="home" aria-label="홈으로">${icon('back')}</button><div class="top-title"><strong>운영자 도구</strong><span>${h(event?.name || '행사 준비')}</span></div></header>${navigation()}<div class="ops-body" aria-busy="${!loaded}"><h1>${labels[tab]}</h1>${notice?`<p class="ops-form-status" data-tone="success" role="status">${h(notice)}</p>`:''}${failure?`<p class="ops-alert" role="alert">${h(failure)}</p>`:''}${!loaded?'<p role="status">불러오는 중...</p>':failure?'':content()}</div>${bottomNav('admin')}</main>`;
  }
  async function save(e) {
    e.preventDefault(); if(busy) return;
    const actor=state.user?.id, requestedView=viewKey();
    const form=e.currentTarget, action=form.dataset.opsForm, body=Object.fromEntries(new FormData(form)), note=form.querySelector('.ops-form-status');
    for(const key of ['version','floor','reviewPoints','delta','userId','stock','target','photoStock','foodStock','photoVersion','foodVersion']) if(key in body) body[key]=Number(body[key]);
    // A positive server version updates the existing festival and cannot enter the creation path.
    if(action==='event_save' && (!currentEventReady() || body.version!==event.version)) {
      note.textContent='축제 정보를 다시 불러온 뒤 저장해 주세요.'; return;
    }
    for(const key of ['id','booth']) if(body[key]==='') body[key]=null;
    if(['visit_approve','points_adjust','voucher_issue'].includes(action)) {
      if(!visitRecipient || body.userId!==visitRecipient.id || !Number.isInteger(body.userId) || body.userId===state.user?.serverUserId) {
        note.textContent='처리할 참여자를 선택해 주세요.'; return;
      }
      if(action==='visit_approve' && !catalog.some(b=>b.key===body.booth && b.status==='open')) {
        note.textContent='운영 중인 부스를 선택해 주세요.'; return;
      }
    }
    if(action==='rule_save') { body.enabled=form.elements.enabled.checked; body.expiresAt=new Date(body.expiresAt+':00+09:00').toISOString(); }
    if(action==='reward_config') { body.expiresAt=new Date(body.expiresAt+':00+09:00').toISOString(); body.enabled=form.elements.enabled.checked; }
    if(['event_save','points_adjust','visit_approve','voucher_issue','voucher_void','reward_config'].includes(action) && !confirm(action==='visit_approve'?`${visitRecipient.name}님에게 ${catalog.find(b=>b.key===body.booth).name} 방문 스탬프 1개를 부여할까요? 이미 방문한 부스는 중복 적립되지 않아요.`:action==='points_adjust'?`${visitRecipient.name}님의 포인트를 ${body.delta>0?'+':''}${body.delta} 조정할까요?`:action==='voucher_issue'?`${visitRecipient.name}님에게 선택한 바우처를 발급할까요?`:action==='reward_config'?(body.enabled?'3개마다 바우처를 반복 지급할까요? 3·9·15개에서 선택하고, 6·12·18개에서 나머지를 지급합니다. 기존 자동 지급 기준은 중지됩니다.':'실제 발급을 중지한 상태로 지급 기준을 저장할까요?'):'입력한 내용으로 처리할까요?')) return;
    busy=true; form.querySelector('button[type=submit]').disabled=true; note.textContent='처리 중...';
    try {
      const response=await api().write(action,body);
      if(state.user?.id!==actor || requestedView!==viewKey() || !form.isConnected) return;
      if(!response.ok) {
        if(['visit_approve','points_adjust','voucher_issue'].includes(action) && response.code==='NOT_FOUND') {
          visitRecipient=null; form.elements.userId.value='';
          form.querySelector('#visitRecipientName').textContent='참여자 다시 선택';
          note.textContent='선택한 참여자 또는 처리 대상을 찾지 못했어요. 새로고침 후 다시 선택해 주세요.';
          return;
        }
        note.textContent=action==='voucher_issue' && response.code==='INVALID_INPUT'
          ? '참여자와 처리 사유를 확인해 주세요. 본인 계정에는 발급할 수 없어요.' : response.message;
        return;
      }
      notice=action==='visit_approve'?(response.data.result==='ALREADY_EARNED'?'이미 적립한 부스예요. 스탬프는 1개만 유지돼요.':`${visitRecipient.name}님에게 스탬프 1개를 적립했어요.`):action==='voucher_issue'?'바우처를 발급했어요.':action==='voucher_void'?'바우처 발급을 취소했어요.':'저장했어요.';
      selectedBooth=response.data.booth || selectedBooth; selectedRule=response.data.id && action==='rule_save'?response.data.id:selectedRule;
      await refresh();
    } finally { busy=false; if(form.isConnected) form.querySelector('button[type=submit]').disabled=false; }
  }

  function pickVisitParticipant(click) {
    if(!isAdminUser() || busy || !currentEventReady()) return;
    const actor=state.user.id, requestedView=viewKey(), eventId=event.id;
    const target=click.currentTarget.closest('[data-ops-form]');
    if(!target || !['visit_approve','points_adjust','voucher_issue'].includes(target.dataset.opsForm)) return;
    const d=dialog(target.dataset.opsForm==='visit_approve'?'스탬프를 받을 참여자':'처리할 참여자'), body=d.querySelector('.ops-dialog-content');
    d.classList.add('ops-participant-dialog');
    body.innerHTML=`<form class="ops-search" data-participant-search><input class="input" name="search" maxlength="100" placeholder="이름 검색" aria-label="참여자 이름" autocomplete="off"><button type="submit" class="icon-btn" aria-label="참여자 검색">${icon('search')}</button></form><p role="status" data-participant-status></p><div class="ops-participant-list" data-participant-list></div><div class="ops-paging"><button type="button" class="icon-btn" data-participant-prev aria-label="이전 참여자">${icon('back')}</button><span data-participant-page></span><button type="button" class="icon-btn" data-participant-next aria-label="다음 참여자">${icon('arrow')}</button></div>`;
    const searchForm=body.querySelector('form'), note=body.querySelector('[role=status]'), list=body.querySelector('[data-participant-list]');
    const prev=body.querySelector('[data-participant-prev]'), next=body.querySelector('[data-participant-next]');
    let start=0, query='', sequence=0;
    const valid=()=>d.isConnected && target.isConnected && state.user?.id===actor && requestedView===viewKey() && event?.id===eventId && isAdminUser();
    const choose=async person=>{
      const seq=++sequence;
      note.textContent='참여자 확인 중...'; list.replaceChildren(); prev.disabled=true; next.disabled=true;
      let response;
      try { response=await festivalAccount.reviewIdentity('get',{eventId,userId:person.id}); }
      catch { response={ok:false}; }
      if(!valid() || seq!==sequence) return;
      const identity=response.ok?response.data:null;
      note.textContent=response.ok?'처리할 학생 본인인지 확인해 주세요.':'참여자 확인에 실패했어요. 다시 찾아 선택해 주세요.';
      list.innerHTML=`<div class="ops-participant-confirm"><strong>${h(person.name)}</strong>${identity?.verified && identity.roster?`<p>${h(identity.roster.studentNumber)} · ${h(identity.roster.realName)}</p><p>${identity.roster.clubs.map(h).join(', ')}</p>`:response.ok?'<p>연결된 동아리 명단 없음</p>':''}<button class="primary-btn" type="button" data-confirm-participant ${response.ok?'':'disabled'}>이 참여자 선택</button><button class="ghost-btn" type="button" data-return-participants>다시 찾기</button></div>`;
      list.querySelector('[data-return-participants]').onclick=()=>load();
      list.querySelector('[data-confirm-participant]').onclick=()=>{
        if(!valid() || !response.ok) return;
        visitRecipient={id:person.id,name:person.name};
        target.elements.userId.value=String(person.id);
        target.querySelector('#visitRecipientName').textContent=person.name;
        target.querySelector('.ops-form-status').textContent='';
        closeDialog(); target.querySelector('[data-pick-participant]').focus();
      };
    };
    const load=async()=>{
      const seq=++sequence;
      note.textContent='참여자 불러오는 중...'; list.replaceChildren(); prev.disabled=true; next.disabled=true;
      body.querySelector('[data-participant-page]').textContent=`${Math.floor(start/50)+1}페이지`;
      try {
        const response=await api().read('participants',{search:query,offset:start});
        if(!valid() || seq!==sequence) return;
        if(!response.ok) { note.textContent=response.message; list.innerHTML='<button class="ghost-btn" type="button" data-participant-retry>다시 불러오기</button>'; list.querySelector('button').onclick=load; return; }
        const people=(response.data.items || []).filter(p=>Number.isInteger(p.id) && p.id>0);
        note.textContent=people.length?'':'검색 결과가 없어요. 이름을 다시 확인해 주세요.';
        list.innerHTML=people.map(p=>`<button type="button" class="ops-participant-row" data-participant-id="${p.id}" ${p.id===state.user.serverUserId?'disabled':''}>${icon('user')}<span><strong>${h(p.name)}</strong><small>${p.id===state.user.serverUserId?'내 계정 · 승인 불가':`방문 ${Number(p.visits)||0}개`}</small></span>${icon('arrow')}</button>`).join('');
        list.querySelectorAll('[data-participant-id]').forEach(b=>b.onclick=()=>choose(people.find(p=>p.id===Number(b.dataset.participantId))));
        prev.disabled=start===0; next.disabled=(response.data.items?.length || 0)<50;
      } catch { if(valid() && seq===sequence) { note.textContent='참여자를 불러오지 못했어요. 이름 검색을 다시 눌러 주세요.'; } }
    };
    searchForm.addEventListener('submit',e=>{e.preventDefault();query=searchForm.elements.search.value.trim();start=0;load();});
    searchForm.elements.search.addEventListener('keydown',e=>{if(e.key==='Enter' && e.isComposing)e.preventDefault();});
    prev.onclick=()=>{start=Math.max(0,start-50);load();}; next.onclick=()=>{start+=50;load();};
    load(); searchForm.elements.search.focus();
  }

  async function reviewRoster(e) {
    e.preventDefault();
    const lookup=e.currentTarget, actor=state.user?.id, userId=Number(lookup.elements.userId.value), requestedView=viewKey();
    if(!Number.isInteger(userId) || !event || !isAdminUser()) return;
    const launch=lookup.querySelector('button[type=submit]');
    if(launch.disabled) return;
    launch.disabled=true;
    const response=await festivalAccount.reviewIdentity('get',{eventId:event.id,userId});
    if(launch.isConnected) launch.disabled=false;
    if(state.user?.id!==actor || !lookup.isConnected || requestedView!==viewKey()) return;
    if(!response.ok) { lookup.querySelector('[role=status]').textContent=response.message; return; }
    const row=response.data, d=dialog('리뷰 실명·소속 확인'), body=d.querySelector('.ops-dialog-content');
    body.innerHTML=`<form class="ops-form" id="reviewRosterForm"><p>${h(row.accountName)} (#${userId})</p>${field('studentNumber','명단 학번',row.roster?.studentNumber || '', 'required inputmode="numeric" pattern="[1-3][0-9]{4}" maxlength="5" autocomplete="off"')}<button class="ghost-btn" type="button" data-roster-find>명단 조회</button><div data-roster-result></div><label class="ops-checkbox"><input name="confirmed" type="checkbox" required>로그인한 학생 본인과 명단이 일치함을 확인했음</label>${reason()}<p class="ops-form-status" role="status"></p><button class="primary-btn" type="submit" disabled>계정에 연결</button>${row.verified?'<button class="ghost-btn" type="button" data-roster-revoke>연결 확인 취소</button>':''}</form>`;
    const f=body.querySelector('form'), button=f.querySelector('button[type=submit]'), note=f.querySelector('[role=status]');
    const find=f.querySelector('[data-roster-find]'), result=f.querySelector('[data-roster-result]');
    let candidate=null, sequence=0, saving=false;
    const valid=()=>state.user?.id===actor && requestedView===viewKey() && d.isConnected && isAdminUser();
    const show=value=>{
      candidate=value; f.elements.confirmed.checked=false;
      button.disabled=!value?.ready || value.linkedElsewhere || userId===Number(actor);
      result.innerHTML=value?`<dl class="ops-roster-summary"><dt>명단 이름</dt><dd>${h(value.realName || '확인 필요')}</dd><dt>동아리</dt><dd>${value.clubs.map(h).join(', ')}</dd><dt>리뷰 제외 부스</dt><dd>${value.boothKeys.length?value.boothKeys.map(h).join(', '):'해당 없음'}</dd></dl><p>${value.linkedElsewhere?'다른 계정에 연결된 명단이에요.':!value.ready?'명단 불일치 또는 부스 연결 확인이 필요해요.':'명단 대조 완료'}</p>`:'';
    };
    show(row.roster);
    f.elements.studentNumber.oninput=()=>{sequence++;show(null);note.textContent='';};
    find.onclick=async()=>{
      if(saving || !f.elements.studentNumber.reportValidity()) return;
      const seq=++sequence, studentNumber=f.elements.studentNumber.value;
      find.disabled=true; show(null); note.textContent='조회 중...';
      try {
        const response=await festivalAccount.reviewIdentity('lookup',{eventId:row.eventId,userId,studentNumber});
        if(!valid() || seq!==sequence) return;
        if(!response.ok) { note.textContent=response.message; return; }
        row.version=response.data.version; show(response.data.roster);
        note.textContent=candidate?'':'명단에 없는 학번이에요.';
      } finally { if(find.isConnected) find.disabled=false; }
    };
    const save=async action=>{
      if(saving || !valid() || (action==='save' && (button.disabled || !f.reportValidity()))) return;
      const why=f.elements.reason.value.trim();
      if(why.length<3) { note.textContent='처리 사유를 3자 이상 입력해 주세요.'; return; }
      saving=true; sequence++; button.disabled=true; find.disabled=true;
      f.elements.studentNumber.disabled=true; note.dataset.tone=''; note.textContent='저장 중...';
      try {
        const response=await festivalAccount.reviewIdentity(action,{eventId:row.eventId,userId,version:row.version,
          studentNumber:candidate?.studentNumber,rosterVersion:candidate?.version,confirmed:f.elements.confirmed.checked,reason:why});
        if(!valid()) return;
        if(!response.ok) { note.textContent=response.message; return; }
        row.version=response.data.version; serverReviews.clear();
        note.dataset.tone='success'; note.textContent=action==='save'?'명단과 계정을 연결했어요.':'확인을 취소했어요.';
        show(action==='save'?response.data.roster:null);
        if(action==='revoke') f.querySelector('[data-roster-revoke]')?.remove();
      } finally {
        saving=false;
        if(f.isConnected) {find.disabled=false;f.elements.studentNumber.disabled=false;button.disabled=!candidate?.ready || candidate.linkedElsewhere || userId===Number(actor);}
      }
    };
    f.onsubmit=ev=>{ev.preventDefault();save('save');};
    f.querySelector('[data-roster-revoke]')?.addEventListener('click',()=>save('revoke'));
  }
  async function redeem(e) {
    e.preventDefault(); if(busy) return;
    const actor=state.user?.id, requestedView=viewKey();
    const form=e.currentTarget, note=form.querySelector('.ops-form-status'), token=form.elements.token.value.trim();
    const button=form.querySelector('button[type=submit]');
    busy=true; button.disabled=true;
    try {
      const preview=await api().read('voucher_check',{token});
      if(state.user?.id!==actor || requestedView!==viewKey() || !form.isConnected) return;
      if(!preview.ok) { note.textContent=preview.message; return; }
      if(!preview.data.valid) { note.textContent='사용할 수 없거나 만료된 QR이에요.'; return; }
      if(!confirm(`${preview.data.title}\n${preview.data.participant}\n상품을 전달하고 사용 완료로 처리할까요?`)) return;
      const r=await api().write('voucher_redeem',{token});
      if(state.user?.id!==actor || requestedView!==viewKey() || !form.isConnected) return;
      if(!r.ok) { note.textContent=r.message; return; }
      notice='바우처를 사용 처리했어요.';
      form.reset(); await refresh();
    } finally { busy=false; if(form.isConnected) button.disabled=false; }
  }
  function closeDialog() {
    stream?.getTracks().forEach(t=>t.stop()); stream=null;
    clearTimeout(cameraTimer); clearInterval(qrTimer); cameraTimer=null; qrTimer=null;
    document.querySelector('.ops-dialog')?.remove();
  }
  function dialog(title) {
    closeDialog(); const d=document.createElement('dialog'); d.className='ops-dialog';
    d.setAttribute('aria-labelledby','opsDialogTitle');
    d.innerHTML=`<header><h2 id="opsDialogTitle">${h(title)}</h2><button class="icon-btn" aria-label="닫기">${icon('close')}</button></header><div class="ops-dialog-content"></div>`;
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
    return festivalWeb.vouchers({loading:!loaded, failure});
  }
  function bind() {
    if(!active()) { if(owner) reset(); return; }
    const changed=lastRoute!==state.route; lastRoute=state.route;
    if(owner!==state.user.id || !loaded || (changed && ['admin','map','vouchers','stamps','reviews'].includes(state.route))) queueMicrotask(()=>refresh());
    document.querySelector('#opsTab')?.addEventListener('change',e=>selectTab(e.target.value));
    document.querySelectorAll('[data-ops-tab]').forEach(b=>b.onclick=()=>selectTab(b.dataset.opsTab));
    document.querySelectorAll('[data-ops-refresh]').forEach(b=>b.onclick=()=>refresh());
    document.querySelectorAll('[data-ops-form]').forEach(f=>f.addEventListener('submit',save));
    document.querySelector('[data-pick-participant]')?.addEventListener('click',pickVisitParticipant);
    document.querySelector('#opsBoothSelect')?.addEventListener('change',e=>{selectedBooth=e.target.value;render();});
    document.querySelector('#opsRuleSelect')?.addEventListener('change',e=>{selectedRule=e.target.value;render();});
    document.querySelector('#opsSearch')?.addEventListener('submit',e=>{e.preventDefault();search=e.target.elements.search.value;offset=0;refresh();});
    document.querySelectorAll('[data-ops-page]').forEach(b=>b.onclick=()=>{offset=Math.max(0,offset+Number(b.dataset.opsPage));refresh();});
    document.querySelector('#opsRedeem')?.addEventListener('submit',redeem);
    document.querySelector('#reviewRosterLookup')?.addEventListener('submit',reviewRoster);
    document.querySelector('[data-ops-camera]')?.addEventListener('click',camera);
    document.querySelectorAll('[data-ops-qr]').forEach(b=>b.onclick=()=>qr(b.dataset.opsQr));
    document.querySelectorAll('[data-ops-claim]').forEach(b=>b.onclick=async()=>{b.disabled=true;const r=await api().write('voucher_claim',{ruleId:b.dataset.opsClaim});if(r.ok)await refresh();else{document.querySelector('#opsVoucherStatus').textContent=r.message;b.disabled=false;}});
    if(!['admin','vouchers'].includes(state.route)) closeDialog();
  }
  function markVisitPending() {
    if(owner!==state.user?.id) reset();
    visitSyncGeneration++; visitSyncPending=true;
  }
  return {admin,navigation,refresh,bind,snapshot,vouchers,reset,chooseReward,markVisitPending,
    visitSyncPending:()=>owner===state.user?.id && visitSyncPending,
    eventId:()=>owner===state.user?.id?event?.id ?? null:null};
})();
