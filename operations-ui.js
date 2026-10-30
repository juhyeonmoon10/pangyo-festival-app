/* Real operations UI. All authorization and rewards remain in guarded server RPCs. */
const festivalOpsUI = (() => {
  let owner=null, mine=null, catalog=[], event=null, busy=false, loading=false, loaded=false, failure='';
  let tab='dashboard', data=null, offset=0, search='', selectedBooth=null, selectedRule='';
  let stream=null, cameraTimer=null, qrTimer=null, qrPoll=null, walletPoll=null;
  // Seconds between voucher state checks while a voucher is on screen.
  const VOUCHER_POLL_MS=5000;
  const VOUCHER_FINISHED={VOUCHER_USED:['사용이 완료되었어요','이 바우처는 사용 처리되었어요.'],VOUCHER_VOID:['발급이 취소되었어요','운영자가 이 바우처를 취소했어요.'],VOUCHER_EXPIRED:['사용 기한이 지났어요','이 바우처는 더 이상 사용할 수 없어요.'],NOT_FOUND:['바우처를 찾을 수 없어요','바우처 목록을 다시 확인해 주세요.']};
  let lastRoute=null;
  let refreshQueued=false, queuedRepaint=false, notice='';
  let refreshWaiters=[];
  let visitRecipient=null;
  let visitSyncPending=false, visitSyncGeneration=0;
  let identity=null, identityBusy=false, identityNote='', identityQuery='', identityDraft='';
  const labels={dashboard:'운영 현황',tools:'관리 도구',catalog:'부스 관리',participants:'참여자',visits:'방문 기록',ledger:'포인트',rules:'바우처 설정',vouchers:'발급·사용',audit:'처리 기록',claim_guard:'부정 적립 감지',nfc:'NFC 발급','stamp-simulator':'스탬프 모의 발급',settings:'축제 운영 설정'};
  const localTabs=new Set(['tools','nfc','stamp-simulator','settings']);
  const h=value=>escapeHtml(String(value ?? ''));
  const VOUCHER_CODE=/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/;
  const api=()=>festivalAccount?.operations;
  const active=()=>isServerMode() && !!state.user;
  const snapshot=()=>owner===state.user?.id ? mine : null;
  const statusName=value=>({preparing:'준비 중',open:'운영 중',paused:'일시 중지',closed:'종료',available:'사용 가능',used:'사용 완료',void:'취소'})[value] || value;
  const time=value=>value==='infinity' ? '기한 없음' : value ? new Date(value).toLocaleString('ko-KR') : '-';
  // datetime-local values are Korean wall-clock time; 'infinity' (no deadline) has no input value.
  const kstInput=value=>value && value!=='infinity' ? new Date(new Date(value).getTime()+9*3600000).toISOString().slice(0,16) : '';
  const fromKst=value=>new Date(String(value).slice(0,16)+':00+09:00').toISOString();
  const stockText=stock=>stock===null || stock===undefined ? '제한 없음' : `${stock}장`;
  const field=(name,label,value='',extra='',type='text')=>`<label>${h(label)}<input class="input" name="${name}" type="${type}" value="${h(value)}" ${extra}></label>`;
  const select=(name,label,options,value)=>`<label>${h(label)}<select class="select" name="${name}">${options.map(([id,text])=>`<option value="${h(id)}" ${String(id)===String(value)?'selected':''}>${h(text)}</option>`).join('')}</select></label>`;
  const form=(action,body,submit='저장',symbol='save')=>`<form class="ops-form" data-ops-form="${action}">${body}<p class="ops-form-status" role="status"></p><button class="primary-btn" type="submit">${icon(symbol)} ${submit}</button></form>`;
  const reason=()=>field('reason','처리 사유','','required minlength="3" maxlength="300"');
  const participant=(label='처리할 참여자')=>`<div class="ops-recipient"><span id="visitRecipientLabel">${h(label)}</span><input type="hidden" name="userId" value="${h(visitRecipient?.id || '')}"><button type="button" class="ops-recipient-button" data-pick-participant aria-labelledby="visitRecipientLabel visitRecipientName">${icon('user')}<span id="visitRecipientName">${h(visitRecipient?.name || '참여자 선택')}</span>${icon('search')}</button></div>`;
  const visitParticipant=()=>participant('스탬프를 받을 참여자');
  const options=()=>catalog.map(b=>[b.key,b.name]);
  const currentEventReady=()=>Boolean(event?.id && Number.isInteger(event.version) && event.version>0);

  function reset() {
    owner=state.user?.id || null; mine=null; catalog=[]; event=null; data=null; loaded=false; failure=''; notice=''; tab='dashboard'; selectedBooth=null; selectedRule='';
    visitRecipient=null; visitSyncPending=false; visitSyncGeneration++; identity=null; identityNote=''; identityDraft=''; closeDialog();
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
      // Optional and independent: a failed identity read never blocks the operations data.
      loadIdentity(actor,event?.id);
      if(requestedGeneration===visitSyncGeneration) visitSyncPending=false;
      const program=rewards.data, kinds=['photo','food'];
      const validProgram=rewards.ok && program?.version===2 && program.eventId===event?.id
        && program.firstTarget===3 && program.secondTarget===6
        && Number.isInteger(program.issuedCount) && program.issuedCount>=0 && program.issuedCount<=2
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
          // Per-booth stamp counts are optional: the dashboard still loads without them.
          const [r,stamps]=await Promise.all([api().read(requestedTab,query),requestedTab==='dashboard'?api().read('booth_stamps'):null]);
          if(state.user?.id!==actor || requestedView!==viewKey()) return;
          if(r.ok) data=r.data; else failure=r.message;
          if(r.ok && stamps) data={...data,boothStamps:stamps.ok && Array.isArray(stamps.data.items) ? stamps.data.items.filter(x=>x && typeof x.booth==='string' && Number.isInteger(x.stamps) && Number.isInteger(x.nfc) && Number.isInteger(x.manual)) : null};
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
    const tools=[['catalog','map','부스 상태·프로그램'],['nfc','scan','NFC 태그 발급'],['visits','stamp','방문 수동 승인'],['participants','user','참여자·동아리 명단'],['ledger','plus','포인트 조정'],['rules','ticket','바우처 지급 기준'],['vouchers','scan','바우처 발급·사용'],['claim_guard','notice','부정 적립 감지'],['stamp-simulator','stamp','스탬프 모의 발급'],['settings','admin','축제 운영 설정']];
    return `<nav class="festival-ops-tools" aria-label="관리 도구">${tools.map(([id,symbol,label])=>`<button type="button" data-ops-tab="${id}"><span class="festival-tool-icon">${icon(symbol)}</span><strong>${label}</strong>${icon('arrow')}</button>`).join('')}</nav>`;
  }
  function eventForm() {
    if(!currentEventReady()) return '';
    // Single-festival platform: the stored name is kept as-is and never edited or shown.
    return `<section class="ops-section" aria-label="축제 운영 설정">${form('event_save',
      `<input type="hidden" name="name" value="${h(event.name)}">`+
      select('state','운영 상태',Object.entries({preparing:'준비 중',open:'운영 중',paused:'일시 중지',closed:'종료'}),event.state)+
      field('reviewPoints','글 후기 최초 등록 포인트',event.review_points ?? 0,'required min="0" max="1000" step="1"','number')+
      `<input type="hidden" name="version" value="${event.version}">`,'운영 설정 저장')}</section>`;
  }
  function resetForm() {
    return `<section class="ops-section ops-reset"><h2>참여 기록 초기화</h2><p>축제 시작 전에 리허설 기록을 비울 때 사용해요. 삭제한 기록은 되돌릴 수 없어요.</p><ul class="ops-reset-scope"><li><strong>삭제</strong> 방문·스탬프, 바우처, 리뷰·별점, 포인트, 부스 평점 순위</li><li><strong>유지</strong> 운영자 권한, 계정, 부스 설정, 바우처 지급 기준, NFC 태그, 공식 명단, 처리 기록</li></ul>${form('participation_reset',
      `<label class="ops-checkbox"><input name="identities" type="checkbox" checked>리뷰 실명 확인 연결도 초기화</label>`+
      field('confirm','확인 문구 (초기화)','','required autocomplete="off" pattern="초기화" placeholder="초기화"')+
      `<input type="hidden" name="eventId" value="${h(event?.id)}">`,'참여 기록 초기화','refresh')}</section>`;
  }
  function unavailableEvent() {
    return `<section class="ops-section ops-unavailable" role="status"><h2>축제 정보를 확인할 수 없어요</h2><p>운영 정보를 다시 불러와 주세요. 계속 표시되면 담당자에게 확인해 주세요.</p><button type="button" class="ghost-btn" data-ops-refresh>${icon('refresh')} 다시 불러오기</button></section>`;
  }
  function boothReadiness() {
    const counts={open:0,paused:0,closed:0};
    for(const booth of catalog) if(Object.hasOwn(counts,booth.status)) counts[booth.status]++;
    return `<section class="ops-section ops-readiness"><h2>부스 운영 상태</h2><dl class="ops-booth-counts">${Object.entries(counts).map(([status,count])=>`<div><dt>${statusName(status)}</dt><dd>${count}<span>개</span></dd></div>`).join('')}</dl>${event.state!=='open'?'<p class="ops-alert">축제가 운영 중이 아니어서 방문 인증이 중지돼 있어요.</p>':counts.open===0?'<p class="ops-alert">운영 중인 부스가 없어 방문 인증이 중지돼 있어요.</p>':''}<button type="button" class="ghost-btn" data-ops-tab="catalog">${icon('map')} 부스 상태 관리</button></section>`;
  }
  function boothStamps() {
    const rows=data?.boothStamps;
    if(!rows) return '<section class="ops-section ops-booth-stamps"><h2>부스별 스탬프 완료</h2><p class="ops-empty">부스별 완료 인원을 불러오지 못했어요. 새로고침해 주세요.</p></section>';
    const max=Math.max(1,...rows.map(r=>r.stamps)), total=rows.reduce((sum,r)=>sum+r.stamps,0);
    const name=r=>catalog.find(b=>b.key===r.booth)?.name || r.name || r.booth;
    return `<section class="ops-section ops-booth-stamps"><h2>부스별 스탬프 완료</h2><p>부스를 완료한 참여자 수예요. 한 사람은 부스마다 한 번만 세요. 전체 ${total}건</p>${rows.length?`<ol class="ops-stamp-list">${rows.map(r=>`<li data-booth-stamps="${h(r.booth)}"><div class="ops-stamp-row"><strong>${h(name(r))}</strong><span><b>${r.stamps}</b>명</span></div><span class="ops-stamp-bar" aria-hidden="true"><i style="width:${Math.round(r.stamps/max*100)}%"></i></span><small>NFC ${r.nfc} · 수동 ${r.manual}${r.status==='open'?'':` · ${h(statusName(r.status))}`}</small></li>`).join('')}</ol>`:'<p class="ops-empty">등록된 부스가 없어요.</p>'}</section>`;
  }
  function claimGuardView() {
    const g=data;
    if(typeof g?.enabled!=='boolean' || !Number.isInteger(g.windowMinutes) || !Number.isInteger(g.maxClaims)) return '<p class="ops-alert" role="alert">부정 적립 감지를 불러오지 못했어요. 서버 업데이트가 필요하거나 연결을 확인해야 해요.</p>';
    const items=Array.isArray(g.items) ? g.items : [];
    return `<section class="ops-section ops-claim-guard"><h2>적립 제한 기준</h2><p>NFC로 새 부스를 짧은 시간에 너무 많이 적립하면 다음 적립을 막아요. 이미 적립한 부스를 다시 찍는 것과 운영자 수동 승인은 막지 않아요.</p>${form('claim_guard_save',
      `<div class="ops-guard-fields">${field('windowMinutes','기간 (분)',g.windowMinutes,'required min="1" max="180" step="1" inputmode="numeric"','number')}${field('maxClaims','최대 적립 수',g.maxClaims,'required min="1" max="100" step="1" inputmode="numeric"','number')}</div>`+
      `<p class="ops-guard-summary" data-guard-summary>${guardSummary(g.windowMinutes,g.maxClaims)}</p>`+
      `<label class="ops-checkbox"><input name="enabled" type="checkbox" ${g.enabled?'checked':''}>적립 제한 사용</label><input type="hidden" name="version" value="${g.version}">`,'기준 저장')}<p class="ops-guard-note">링크를 복사해 붙여 넣은 것과 카드를 직접 찍은 것은 지금 카드로는 구분할 수 없어요. 몰아서 적립하는 것을 막고 아래 목록으로 찾아내는 방식이에요.</p></section>`
      +`<section class="ops-section ops-guard-list"><h2>기준에 도달한 참여자 <span>${items.length}명</span></h2><p>${g.windowMinutes}분 안에 NFC로 ${g.maxClaims}개 이상 적립한 적이 있는 참여자예요. 현재 기준으로 다시 계산해요.</p>`
      +(items.length ? table(items,[['참여자',r=>`${r.name} (#${r.userId})`],['기간 내 최다',r=>`${r.peak}개`],['NFC',r=>r.nfc],['수동',r=>r.manual],['마지막 적립',r=>time(r.lastAt)]]) : '<p class="ops-empty">아직 기준에 도달한 참여자가 없어요.</p>')+'</section>';
  }
  function guardSummary(minutes,count) {
    return Number.isInteger(minutes) && Number.isInteger(count) && minutes>0 && count>0
      ? `${minutes}분 안에 새 부스 ${count}개까지 적립할 수 있어요. ${count+1}번째부터 막아요.` : '기간과 최대 적립 수를 1 이상으로 입력해 주세요.';
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
      field('expiresAt','사용 마감 (한국 시간)',kstInput(r?.expires_at), 'required','datetime-local')+
      `<label class="ops-checkbox"><input name="enabled" type="checkbox" ${r?.enabled?'checked':''}>자동 발급 활성화</label><input type="hidden" name="id" value="${h(r?.id)}"><input type="hidden" name="version" value="${r?.version || 0}">`)}</section>`;
  }
  function rewardConfigForm() {
    const reward=snapshot()?.rewardProgram;
    const option=kind=>reward?.options?.find(o=>o.kind===kind);
    const photo=option('photo'), food=option('food');
    // Before the first save both limits default to "none"; a stored rule shows its own values.
    const noDeadline=!photo || photo.expiresAt==='infinity';
    const stockField=(kind,title)=>{
      const o=option(kind), unlimited=!o || o.stock===null, issued=o?.issued ?? 0;
      return `<fieldset class="ops-reward-stock"><legend>${h(title)}</legend><p class="ops-reward-usage" data-reward-usage="${kind}">발급 <b>${issued}장</b> · 남은 수량 <b>${unlimited?'제한 없음':`${Math.max(0,o.stock-issued)}장`}</b></p>`
        +field(`${kind}Stock`,'총 수량',unlimited?'':o.stock,`min="${issued}" max="100000" step="1" ${unlimited?'disabled':'required'}`,'number')
        +`<label class="ops-checkbox"><input type="checkbox" data-unlimited="${kind}Stock" ${unlimited?'checked':''}>수량 제한 없음</label></fieldset>`;
    };
    return `<section class="ops-section"><h2>스탬프 3개·6개 바우처</h2><p>스탬프 3개에서 하나를 고르고, 6개에서 나머지 하나를 받아요. 참여자당 최대 2장이에요.</p>${form('reward_config',
      stockField('photo','포토부스 이용권')+stockField('food','푸드트럭 교환권')+
      field('expiresAt','이용권 사용 마감 (한국 시간)',kstInput(photo?.expiresAt),noDeadline?'disabled':'required','datetime-local')+
      `<label class="ops-checkbox"><input type="checkbox" data-unlimited="expiresAt" ${noDeadline?'checked':''}>사용 기한 없음</label>`+
      `<label class="ops-checkbox"><input name="enabled" type="checkbox" ${reward?.ready?'checked':''}>바우처 실제 지급 활성화</label>`+
      `<input type="hidden" name="eventId" value="${h(event?.id)}"><input type="hidden" name="photoVersion" value="${photo?.version || 0}"><input type="hidden" name="foodVersion" value="${food?.version || 0}">`,'지급 기준 저장')}</section>`;
  }
  async function chooseReward(kind,firstTarget) {
    const actor=state.user?.id, reward=snapshot()?.rewardProgram;
    if(firstTarget!==3) return {ok:false,message:'바우처는 스탬프 3개와 6개에서만 지급돼요.'};
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
    if(tab==='settings') return eventForm()+resetForm();
    if(tab==='dashboard') return `<div class="festival-op-status ${event.state === 'open' ? '' : 'is-paused'}">${icon(event.state === 'open' ? 'check' : 'notice')}<div><strong>${h(statusName(event.state))}</strong><p>축제 운영 상태</p></div><button type="button" class="icon-btn" data-ops-tab="settings" aria-label="축제 운영 설정" title="축제 운영 설정">${icon('admin')}</button></div><dl class="ops-stats">${[['참여자',data?.participants],['방문',data?.visits],['리뷰',data?.reviews],['바우처 발급',data?.issued],['바우처 사용',data?.used]].map(([k,v])=>`<div><dt>${k}</dt><dd>${v ?? '-'}</dd></div>`).join('')}</dl>${boothReadiness()}${boothStamps()}<section class="ops-section"><h2>빠른 처리</h2><div class="festival-ops-tools">${[['visits','stamp','수동 방문 승인'],['vouchers','scan','바우처 확인·사용'],['nfc','scan','NFC 태그 발급']].map(([id,symbol,label])=>`<button type="button" data-ops-tab="${id}"><span class="festival-tool-icon">${icon(symbol)}</span><strong>${label}</strong>${icon('arrow')}</button>`).join('')}</div></section>`;
    if(tab==='claim_guard') return claimGuardView();
    if(tab==='catalog') return boothForm()+table(catalog,[['부스','name'],['위치','location'],['상태',r=>statusName(r.status)]]);
    if(tab==='participants') return searchForm()+table(data?.items,[['번호','id'],['이름','name'],['방문','visits'],['포인트','points']])+paging()+`<section class="ops-section"><h2>리뷰 실명·소속 확인</h2><form id="reviewRosterLookup" class="ops-form">${select('userId','참여자',(data?.items || []).map(p=>[p.id,`${p.name} (#${p.id})`]),null)}<p role="status"></p><button class="primary-btn" type="submit">명단 확인</button></form></section>`+identityList();
    if(tab==='visits') return `<section class="ops-section"><h2>수동 방문 승인</h2>${form('visit_approve',visitParticipant()+select('booth','방문 부스',options().filter(([key])=>catalog.find(b=>b.key===key)?.status==='open'),null)+reason(),'스탬프 1개 승인')}</section>`+table(data?.items,[['시각',r=>time(r.created_at)],['참여자','name'],['부스',r=>catalog.find(b=>b.key===r.booth_key)?.name || r.booth_key],['방식','method'],['사유','reason']])+paging();
    if(tab==='ledger') return `<section class="ops-section"><h2>포인트 조정</h2>${form('points_adjust',participant()+field('delta','변경 포인트 (+지급 / -차감)','','required min="-100000" max="100000" step="1"','number')+reason(),'조정 확정')}</section>`+searchForm()+table(data?.items,[['시각',r=>time(r.created_at)],['참여자',r=>`${r.name} (#${r.user_id})`],['변경','delta'],['사유','reason']])+paging();
    if(tab==='rules') return (mine?.rewardProgram?.supported ? rewardConfigForm() : mine?.rewardProgram?.legacyRules
      ? '<p class="ops-empty">3개·6개 지급은 아직 준비 중이에요. 기존 발급 기준은 관리할 수 있어요.</p>'+ruleForm()
      : '<p class="ops-alert" role="alert">바우처 지급 설정을 확인하지 못했어요. 새로고침 후 다시 확인해 주세요.</p>')
      +table(data?.items,[['이름','title'],['기준',r=>r.reward_kind?'3개·6개 지급':r.target],['발급','issued'],['한도',r=>stockText(r.stock)],['마감',r=>time(r.expires_at)],['활성',r=>r.enabled?'예':'아니오']]);
    if(tab==='vouchers') return `<section class="ops-section"><h2>바우처 사용</h2><form id="opsRedeem" class="ops-form"><label>인증키 (8자리)<input class="input ops-code-input" name="token" autocomplete="off" autocapitalize="characters" spellcheck="false" required maxlength="11" placeholder="QR 스캔 또는 직접 입력"></label><p class="ops-form-status" role="status"></p><div class="ops-actions"><button class="icon-btn" type="button" data-ops-camera title="QR 스캔" aria-label="QR 스캔">${icon('scan')}</button><button class="primary-btn" type="submit">바우처 확인</button></div></form></section><section class="ops-section"><h2>수동 발급</h2>${manualVoucherForm()}</section><section class="ops-section"><h2>발급 취소</h2>${form('voucher_void',select('id','취소할 바우처',(data?.items || []).filter(v=>v.state==='available').map(v=>[v.id,`${v.name} · ${v.title}`]),null)+reason(),'취소 확정')}</section>`+searchForm()+table(data?.items,[['참여자','user_id'],['이름','name'],['바우처','title'],['상태',r=>statusName(r.state)],['마감',r=>time(r.expires_at)]])+paging();
    return table(data?.items,[['시각',r=>time(r.created_at)],['처리자','actor_id'],['작업','action'],['대상','target'],['사유','reason']])+paging();
  }
  function admin() {
    if(tab==='nfc') return serverAdminView();
    if(tab==='stamp-simulator') return `<main class="screen ops-screen"><header class="top-bar"><button class="icon-btn" data-route="home" aria-label="홈으로">${icon('back')}</button><div class="top-title"><strong>운영자 도구</strong></div></header>${navigation()}${typeof festivalStampSimulator==='undefined'?'':festivalStampSimulator.view()}${bottomNav('admin')}</main>`;
    return `<main class="screen ops-screen"><header class="top-bar"><button class="icon-btn" data-route="home" aria-label="홈으로">${icon('back')}</button><div class="top-title"><strong>운영자 도구</strong></div></header>${navigation()}<div class="ops-body" aria-busy="${!loaded}"><h1>${labels[tab]}</h1>${notice?`<p class="ops-form-status" data-tone="success" role="status">${h(notice)}</p>`:''}${failure?`<p class="ops-alert" role="alert">${h(failure)}</p>`:''}${!loaded?'<p role="status">불러오는 중...</p>':failure?'':content()}</div>${bottomNav('admin')}</main>`;
  }
  async function save(e) {
    e.preventDefault(); if(busy) return;
    const actor=state.user?.id, requestedView=viewKey();
    const form=e.currentTarget, action=form.dataset.opsForm, body=Object.fromEntries(new FormData(form)), note=form.querySelector('.ops-form-status');
    for(const key of ['version','floor','reviewPoints','delta','userId','stock','target','photoStock','foodStock','photoVersion','foodVersion','windowMinutes','maxClaims']) if(key in body) body[key]=Number(body[key]);
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
    if(action==='rule_save') { body.enabled=form.elements.enabled.checked; body.expiresAt=fromKst(body.expiresAt); }
    if(action==='reward_config') {
      // Disabled inputs are absent from FormData; null stock and 'infinity' are the server's "no limit" values.
      for(const key of ['photoStock','foodStock']) body[key]=form.querySelector(`[data-unlimited="${key}"]`).checked ? null : Number(body[key]);
      body.expiresAt=form.querySelector('[data-unlimited="expiresAt"]').checked ? 'infinity' : fromKst(body.expiresAt);
      body.enabled=form.elements.enabled.checked;
    }
    if(action==='participation_reset') body.identities=form.elements.identities.checked;
    if(action==='claim_guard_save') body.enabled=form.elements.enabled.checked;
    if(['event_save','points_adjust','visit_approve','voucher_issue','voucher_void','reward_config','participation_reset','claim_guard_save'].includes(action) && !confirm(action==='claim_guard_save'?(body.enabled?`${guardSummary(body.windowMinutes,body.maxClaims)} 이 기준을 바로 적용할까요?`:'NFC 적립 제한을 끌까요? 짧은 시간에 몰아서 적립해도 막지 않아요.'):action==='participation_reset'?`모든 참여자의 방문·스탬프, 바우처, 리뷰·별점, 포인트와 부스 평점 순위를 삭제할까요?${body.identities?' 리뷰 실명 확인 연결도 삭제돼요.':''} 운영자 권한과 부스·바우처 설정은 유지돼요. 되돌릴 수 없어요.`:action==='reward_config'&&body.enabled?`스탬프 3개에서 하나를 선택하고, 6개에서 나머지를 지급할까요? 참여자당 최대 2장입니다.\n포토부스 이용권: ${stockText(body.photoStock)} · 푸드트럭 교환권: ${stockText(body.foodStock)} · 사용 기한: ${time(body.expiresAt)}`:action==='visit_approve'?`${visitRecipient.name}님에게 ${catalog.find(b=>b.key===body.booth).name} 방문 스탬프 1개를 부여할까요? 이미 방문한 부스는 중복 적립되지 않아요.`:action==='points_adjust'?`${visitRecipient.name}님의 포인트를 ${body.delta>0?'+':''}${body.delta} 조정할까요?`:action==='voucher_issue'?`${visitRecipient.name}님에게 선택한 바우처를 발급할까요?`:action==='reward_config'?(body.enabled?'스탬프 3개에서 하나를 선택하고, 6개에서 나머지를 지급할까요? 행사당 최대 2장입니다. 기존 자동 지급 기준은 중지됩니다.':'실제 발급을 중지한 상태로 지급 기준을 저장할까요?'):'입력한 내용으로 처리할까요?')) return;
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
      if(action==='participation_reset') {
        // Local caches mirror the deleted server records until the next profile load.
        serverReviews.clear(); serverMyReviews=null; serverCompletedBooths=[]; form.reset();
      }
      notice=action==='participation_reset'?`참여 기록을 초기화했어요. 방문 ${response.data.visits}건, 바우처 ${response.data.vouchers}장, 리뷰 ${response.data.reviews}건, 부스 평점 ${response.data.ratings}건을 삭제했어요.`:action==='visit_approve'?(response.data.result==='ALREADY_EARNED'?'이미 적립한 부스예요. 스탬프는 1개만 유지돼요.':`${visitRecipient.name}님에게 스탬프 1개를 적립했어요.`):action==='voucher_issue'?'바우처를 발급했어요.':action==='voucher_void'?'바우처 발급을 취소했어요.':'저장했어요.';
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

  // Student self-confirmation: the server matches the sign-up student number and the typed roster name.
  const identityMessages={IDENTITY_MISMATCH:'동아리 명단의 이름과 달라요. 이름을 다시 확인해 주세요.',
    ROSTER_NOT_FOUND:'가입할 때 등록한 학번이 동아리 명단에 없어요. 운영 부스에 문의해 주세요.',
    ROSTER_ALREADY_LINKED:'이 학번은 다른 계정에서 이미 확인됐어요. 운영 부스에 문의해 주세요.',
    OPERATOR_LOCKED:'운영자가 소속 확인을 취소했어요. 운영 부스에 문의해 주세요.',
    TOO_MANY_ATTEMPTS:'확인 시도가 너무 많아요. 1시간 뒤 다시 시도하거나 운영 부스에 문의해 주세요.'};
  const boothNames=keys=>keys.map(key=>catalog.find(b=>b.key===key)?.name || key);
  function identityView() {
    const page=body=>`<main class="screen web-page festival-identity">${festivalWeb.header('본인 소속 확인')}${body}${bottomNav('identity')}</main>`;
    if(!active()) return page('<p class="web-muted">로그인한 뒤 확인할 수 있어요.</p>');
    if(!loaded) return page('<p role="status">불러오는 중이에요.</p>');
    const me=identity;
    if(!me) return page(`<p class="ops-alert" role="alert">소속 확인 정보를 불러오지 못했어요.</p><button type="button" class="ghost-btn" data-ops-refresh>${icon('refresh')} 다시 불러오기</button>`);
    if(me.verified) return page(`<section class="festival-identity-card" aria-label="확인된 소속"><span class="festival-identity-badge">${icon('check')} 소속 확인 완료</span><dl><div><dt>이름</dt><dd>${h(me.realName)}</dd></div><div><dt>학번</dt><dd>${h(me.studentNumber)}</dd></div><div><dt>소속 동아리</dt><dd>${me.clubs.map(h).join(', ')}</dd></div><div><dt>별점 제외 부스</dt><dd>${me.boothKeys.length?boothNames(me.boothKeys).map(h).join(', '):'없음'}</dd></div></dl></section><p class="festival-identity-help">본인 동아리 부스를 제외한 모든 부스에 별점을 남길 수 있어요. 리뷰에는 위 이름이 표시돼요. 소속이 다르면 운영 부스에 문의해 주세요.</p>`);
    if(!me.eligible) return page('<p class="festival-identity-help">1·2학년 창체 동아리 명단으로 소속을 확인해요. 가입할 때 등록한 학번이 확인 대상이 아니에요.</p>');
    if(me.locked) return page(`<p class="ops-alert" role="alert">${identityMessages.OPERATOR_LOCKED}</p>`);
    return page(`<section class="festival-identity-card"><p class="festival-identity-help">창체 동아리 명단과 같은 이름을 입력하면 바로 확인돼요. 확인되면 본인 동아리 부스를 제외한 부스에 별점을 남길 수 있어요.</p><form class="ops-form" data-identity-confirm><label>가입할 때 등록한 학번<input class="input" value="${h(me.studentNumber)}" readonly aria-readonly="true"></label><label>이름 (동아리 명단과 같게)<input class="input" name="realName" required maxlength="60" autocomplete="name" spellcheck="false" value="${h(identityDraft)}"></label><p class="ops-form-status" role="status">${h(identityNote)}</p><button class="primary-btn" type="submit" ${identityBusy?'disabled':''}>${icon('check')} ${identityBusy?'확인 중...':'소속 확인'}</button></form><p class="festival-identity-help">학번이 틀렸거나 명단에 없으면 운영 부스에 문의해 주세요. 운영자가 확인 결과를 취소하거나 바꿀 수 있어요.</p></section>`);
  }
  async function loadIdentity(actor,eventId) {
    if(typeof festivalAccount?.reviewIdentitySelf!=='function' || !eventId) return;
    const response=await festivalAccount.reviewIdentitySelf('status');
    if(state.user?.id!==actor || owner!==actor || event?.id!==eventId) return;
    const next=response.ok && response.data.eventId===eventId ? response.data : null;
    const changed=JSON.stringify(next)!==JSON.stringify(identity);
    identity=next;
    if(changed && ['home','identity','profile'].includes(state.route) && !document.activeElement?.matches('input,textarea')) render();
  }
  function identityRow() {
    const me=identity;
    if(!me) return '';
    const text=me.verified?`확인됨 · ${me.clubs.join(', ')}`:me.eligible?'확인 필요':'확인 대상 아님';
    return `<button type="button" class="profile-identity-row" data-route="identity"><span>소속 확인</span><strong>${h(text)}</strong>${icon('arrow')}</button>`;
  }
  async function confirmIdentity(e) {
    e.preventDefault();
    const form=e.currentTarget, actor=state.user?.id, note=form.querySelector('[role=status]');
    if(identityBusy || !event || !form.reportValidity()) return;
    identityBusy=true; identityNote=''; identityDraft=form.elements.realName.value; form.querySelector('button[type=submit]').disabled=true; note.textContent='확인 중...';
    try {
      const response=await festivalAccount.reviewIdentitySelf('confirm',{eventId:event.id,realName:form.elements.realName.value.trim()});
      if(state.user?.id!==actor) return;
      if(!response.ok) { identityNote=response.message; return; }
      identity=response.data;
      identityNote=response.data.result==='CONFIRMED'?'':identityMessages[response.data.result] || '';
      if(identity.verified) identityDraft='';
      // Booth review permissions depend on the identity; drop cached policies.
      if(identity.verified) serverReviews.clear();
    } finally { identityBusy=false; if(state.user?.id===actor) render(); }
  }
  function identityList() {
    return `<section class="ops-section"><h2>소속 확인 목록</h2><p>학생이 직접 등록하면 바로 확인돼요. 다른 학생으로 등록됐거나 소속이 틀리면 열어서 취소하거나 바꿔 주세요.</p><p class="ops-identity-counts" data-identity-counts></p><form class="ops-search" data-identity-search><input class="input" name="search" maxlength="100" value="${h(identityQuery)}" placeholder="계정 이름, 실명 또는 학번" aria-label="소속 확인 검색"><button class="icon-btn" aria-label="소속 확인 검색">${icon('search')}</button></form><div class="ops-participant-list" data-identity-list><p role="status">불러오는 중...</p></div></section>`;
  }
  async function loadIdentityList() {
    const list=document.querySelector('[data-identity-list]');
    if(!list || !event || !isAdminUser()) return;
    if(typeof festivalAccount?.reviewIdentityList!=='function') { list.innerHTML='<p role="status">소속 확인 목록을 불러올 수 없어요.</p>'; return; }
    const actor=state.user.id, requestedView=viewKey(), query=identityQuery;
    const response=await festivalAccount.reviewIdentityList({eventId:event.id,search:query,offset:0});
    if(state.user?.id!==actor || requestedView!==viewKey() || !list.isConnected || query!==identityQuery) return;
    if(!response.ok) { list.innerHTML=`<p role="status">${h(response.message)}</p>`; return; }
    const counts=response.data.counts || {};
    document.querySelector('[data-identity-counts]').textContent=`확인 ${counts.linked ?? 0}명 (본인 등록 ${counts.self ?? 0}명) · 취소 ${counts.revoked ?? 0}명`;
    const label=item=>item.state.verified?(item.selfRegistered?'본인 등록':'운영자 확인'):item.state.locked?'운영자 취소':'다시 확인 필요';
    list.innerHTML=response.data.items.length?response.data.items.map(item=>`<button type="button" class="ops-participant-row" data-identity-user="${item.userId}">${icon('user')}<span><strong>${h(item.accountName)} · ${h(item.realName)} (${h(item.studentNumber)})</strong><small>${item.clubs.map(h).join(', ')} · ${label(item)}</small></span>${icon('arrow')}</button>`).join(''):'<p role="status">확인된 학생이 없어요.</p>';
    list.querySelectorAll('[data-identity-user]').forEach(button=>button.onclick=()=>openRoster(Number(button.dataset.identityUser),button,list,()=>button.isConnected,loadIdentityList));
  }
  async function reviewRoster(e) {
    e.preventDefault();
    const lookup=e.currentTarget;
    await openRoster(Number(lookup.elements.userId.value),lookup.querySelector('button[type=submit]'),lookup.querySelector('[role=status]'),()=>lookup.isConnected);
  }
  async function openRoster(userId,launch,status,attached,changed=()=>{}) {
    const actor=state.user?.id, requestedView=viewKey();
    if(!Number.isInteger(userId) || !event || !isAdminUser()) return;
    if(launch.disabled) return;
    launch.disabled=true;
    const response=await festivalAccount.reviewIdentity('get',{eventId:event.id,userId});
    if(launch.isConnected) launch.disabled=false;
    if(state.user?.id!==actor || !attached() || requestedView!==viewKey()) return;
    if(!response.ok) { status.textContent=response.message; return; }
    const row=response.data, d=dialog('리뷰 실명·소속 확인'), body=d.querySelector('.ops-dialog-content');
    body.innerHTML=`<form class="ops-form" id="reviewRosterForm"><p>${h(row.accountName)} (#${userId})${row.verified?` · ${row.selfRegistered?'본인 등록':'운영자 확인'}`:''}</p>${field('studentNumber','명단 학번',row.roster?.studentNumber || '', 'required inputmode="numeric" pattern="[1-3][0-9]{4}" maxlength="5" autocomplete="off"')}<button class="ghost-btn" type="button" data-roster-find>명단 조회</button><div data-roster-result></div><label class="ops-checkbox"><input name="confirmed" type="checkbox" required>로그인한 학생 본인과 명단이 일치함을 확인했음</label>${reason()}<p class="ops-form-status" role="status"></p><button class="primary-btn" type="submit" disabled>계정에 연결</button>${row.verified?'<button class="ghost-btn" type="button" data-roster-revoke>연결 확인 취소</button>':''}</form>`;
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
        row.version=response.data.version; serverReviews.clear(); changed();
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
      const code=token.toUpperCase().replace(/[\s-]/g,'');
      if(!VOUCHER_CODE.test(code)) { note.textContent='인증키 8자리를 확인해 주세요.'; return; }
      const preview=await api().read('voucher_code_check',{code});
      if(state.user?.id!==actor || requestedView!==viewKey() || !form.isConnected) return;
      if(!preview.ok) { note.textContent=preview.code==='VOUCHER_INVALID'?'맞지 않거나 시간이 지난 인증키예요. 참여자 화면의 새 인증키를 확인해 주세요.':preview.message; return; }
      const p=preview.data;
      if(!p.valid) { note.textContent=p.state==='used'?'이미 사용한 바우처예요.':p.state==='void'?'취소된 바우처예요.':p.state==='expired'?'만료된 바우처예요.':!p.eventOpen?'축제가 운영 중이 아니어서 사용할 수 없어요.':'사용할 수 없는 바우처예요.'; return; }
      if(!confirm(`${p.title}\n${p.participant}${p.own?' (내 바우처)':''}\n상품을 전달하고 사용 완료로 처리할까요?`)) return;
      const r=await api().write('voucher_code_redeem',{code});
      if(state.user?.id!==actor || requestedView!==viewKey() || !form.isConnected) return;
      if(!r.ok) { note.textContent=r.message; return; }
      notice='바우처를 사용 처리했어요.';
      form.reset(); await refresh();
    } finally { busy=false; if(form.isConnected) button.disabled=false; }
  }
  function closeDialog() {
    stream?.getTracks().forEach(t=>t.stop()); stream=null;
    clearTimeout(cameraTimer); clearTimeout(qrTimer); clearInterval(qrPoll); cameraTimer=null; qrTimer=null; qrPoll=null;
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
    if(!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) { note.textContent='이 브라우저에서는 QR 스캔을 지원하지 않아요. 참여자 화면의 인증키 8자리를 입력해 주세요.'; return; }
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
          const list=await detector.detect(video); const found=list.find(x=>VOUCHER_CODE.test(x.rawValue));
          if(found) { const f=document.querySelector('#opsRedeem'); if(f){f.elements.token.value=found.rawValue;closeDialog();f.requestSubmit();} return; }
        } catch { /* Try the next camera frame. */ }
        cameraTimer=setTimeout(tick,250);
      }; tick();
    } catch { if(d.isConnected) body.querySelector('p').textContent='카메라 권한을 확인해 주세요.'; }
  }
  // Copies inside the open modal dialog: a selection outside the top layer cannot be copied.
  async function copyText(text,container) {
    try { if(window.isSecureContext && navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } }
    catch { /* In-app browsers often block the async clipboard; fall back to a selection copy. */ }
    const area=document.createElement('textarea');
    area.value=text; area.readOnly=true; area.setAttribute('aria-hidden','true');
    area.style.cssText='position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
    (container || document.body).append(area);
    area.focus(); area.select(); area.setSelectionRange(0,text.length);
    let copied=false;
    try { copied=document.execCommand('copy'); } catch { copied=false; }
    area.remove();
    return copied;
  }
  async function qr(id) {
    const d=dialog('바우처 사용'), body=d.querySelector('.ops-dialog-content'); body.innerHTML='<p role="status">인증키 준비 중...</p>';
    let shown=null, checking=false;
    // A used, cancelled or expired voucher replaces the code at once and updates the wallet.
    const finish=code=>{
      clearTimeout(qrTimer); clearInterval(qrPoll); qrTimer=null; qrPoll=null;
      const [title,text]=VOUCHER_FINISHED[code];
      body.innerHTML=`<div class="ops-voucher-done ${code==='VOUCHER_USED'?'used':''}" role="status" aria-live="assertive">${icon(code==='VOUCHER_USED'?'check':'notice')}<strong>${title}</strong><p>${text}</p></div><button type="button" class="primary-btn" data-voucher-done>확인</button>`;
      body.querySelector('[data-voucher-done]').onclick=closeDialog;
      refresh();
    };
    const check=async()=>{
      if(!d.isConnected) { clearInterval(qrPoll); return; }
      if(checking || document.hidden) return;
      checking=true;
      try {
        const r=await api().read('voucher_code',{id}); if(!d.isConnected) return;
        if(!r.ok) { if(VOUCHER_FINISHED[r.code]) finish(r.code); return; }
        if(shown && r.data.code!==shown) await show();
      } finally { checking=false; }
    };
    const show=async()=>{
      clearTimeout(qrTimer);
      const r=await api().read('voucher_code',{id}); if(!d.isConnected) return;
      if(!r.ok) { if(VOUCHER_FINISHED[r.code]) finish(r.code); else body.innerHTML=`<p role="alert">${h(r.message)}</p>`; return; }
      const current=r.data;
      shown=current.code;
      const offset=new Date(current.serverTime)-Date.now();
      const code=qrcode(0,'M'); code.addData(current.code); code.make();
      body.innerHTML=`<div class="ops-qr" role="img" aria-label="바우처 인증 QR">${code.createSvgTag({cellSize:5,margin:16,scalable:true})}</div><p class="ops-voucher-code" aria-label="인증키 ${h(current.code.split('').join(' '))}">${h(current.code.slice(0,4))} ${h(current.code.slice(4))}</p><p class="ops-code-timer" role="timer"></p><button type="button" class="ghost-btn" data-copy-code>${icon('copy')} 인증키 복사</button><p class="ops-copy-status" role="status" aria-live="polite"></p><p class="ops-code-help">카메라가 안 되면 운영자에게 인증키 8자리를 보여 주세요. 인증키는 30초마다 바뀌어요.</p>`;
      body.querySelector('[data-copy-code]').onclick=async()=>{
        const ok=await copyText(current.code,d);
        if(d.isConnected) body.querySelector('.ops-copy-status').textContent=ok?'인증키를 복사했어요.':'복사하지 못했어요. 화면의 인증키를 직접 알려 주세요.';
      };
      const timer=body.querySelector('.ops-code-timer');
      const tick=()=>{
        if(!d.isConnected) return;
        // validUntil is the server's step end; correct for this device's clock.
        const left=Math.max(0,Math.ceil((new Date(current.validUntil)-offset-Date.now())/1000));
        // A short pause avoids back-to-back requests when the new step has not started yet.
        if(left<=0) { timer.textContent='새 인증키를 받는 중...'; qrTimer=setTimeout(show,1000); return; }
        timer.textContent=`${left}초 후 새 인증키로 바뀌어요`;
        qrTimer=setTimeout(tick,1000);
      };
      tick();
    };
    clearInterval(qrPoll); qrPoll=setInterval(check,VOUCHER_POLL_MS);
    await show();
  }
  // The wallet re-reads voucher states while an available voucher is on screen, so a voucher
  // redeemed on another device (or by an operator) turns into "사용 완료" without a reload.
  function watchWallet() {
    const wanted=state.route==='vouchers' && active() && (mine?.vouchers || []).some(v=>v.state==='available');
    if(!wanted) { clearInterval(walletPoll); walletPoll=null; return; }
    if(walletPoll) return;
    let checking=false;
    walletPoll=setInterval(async()=>{
      if(state.route!=='vouchers' || !active()) { clearInterval(walletPoll); walletPoll=null; return; }
      if(checking || loading || document.hidden || document.querySelector('.ops-dialog')) return;
      checking=true;
      try {
        const actor=state.user.id, r=await api().read('me');
        if(!r.ok || state.user?.id!==actor) return;
        const key=list=>JSON.stringify((list || []).map(v=>[v.id,v.state]).sort());
        if(key(r.data.vouchers)!==key(mine?.vouchers)) await refresh();
      } finally { checking=false; }
    },VOUCHER_POLL_MS);
  }
  function vouchers() {
    return festivalWeb.vouchers({loading:!loaded, failure});
  }
  function bind() {
    if(!active()) { if(owner) reset(); return; }
    const changed=lastRoute!==state.route; lastRoute=state.route;
    if(owner!==state.user.id || !loaded || (changed && ['admin','map','vouchers','stamps','reviews','home','identity'].includes(state.route))) queueMicrotask(()=>refresh());
    document.querySelector('#opsTab')?.addEventListener('change',e=>selectTab(e.target.value));
    document.querySelectorAll('[data-ops-tab]').forEach(b=>b.onclick=()=>selectTab(b.dataset.opsTab));
    document.querySelectorAll('[data-ops-refresh]').forEach(b=>b.onclick=()=>refresh());
    document.querySelectorAll('[data-ops-form]').forEach(f=>f.addEventListener('submit',save));
    document.querySelectorAll('[data-unlimited]').forEach(box=>box.onchange=()=>{
      const input=box.form.elements[box.dataset.unlimited];
      input.disabled=box.checked; input.required=!box.checked;
      if(!box.checked) input.focus();
    });
    document.querySelector('[data-pick-participant]')?.addEventListener('click',pickVisitParticipant);
    const guardForm=document.querySelector('[data-ops-form="claim_guard_save"]');
    guardForm?.addEventListener('input',()=>{ guardForm.querySelector('[data-guard-summary]').textContent=guardSummary(Number(guardForm.elements.windowMinutes.value),Number(guardForm.elements.maxClaims.value)); });
    document.querySelector('#opsBoothSelect')?.addEventListener('change',e=>{selectedBooth=e.target.value;render();});
    document.querySelector('#opsRuleSelect')?.addEventListener('change',e=>{selectedRule=e.target.value;render();});
    document.querySelector('#opsSearch')?.addEventListener('submit',e=>{e.preventDefault();search=e.target.elements.search.value;offset=0;refresh();});
    document.querySelectorAll('[data-ops-page]').forEach(b=>b.onclick=()=>{offset=Math.max(0,offset+Number(b.dataset.opsPage));refresh();});
    document.querySelector('#opsRedeem')?.addEventListener('submit',redeem);
    document.querySelector('#reviewRosterLookup')?.addEventListener('submit',reviewRoster);
    document.querySelector('[data-identity-confirm]')?.addEventListener('submit',confirmIdentity);
    const identitySearch=document.querySelector('[data-identity-search]');
    if(identitySearch) {
      identitySearch.onsubmit=ev=>{ev.preventDefault();identityQuery=identitySearch.elements.search.value.trim();loadIdentityList();};
      if(loaded && !failure) loadIdentityList();
    }
    document.querySelector('[data-ops-camera]')?.addEventListener('click',camera);
    document.querySelectorAll('[data-ops-qr]').forEach(b=>b.onclick=()=>qr(b.dataset.opsQr));
    document.querySelectorAll('[data-ops-claim]').forEach(b=>b.onclick=async()=>{b.disabled=true;const r=await api().write('voucher_claim',{ruleId:b.dataset.opsClaim});if(r.ok)await refresh();else{document.querySelector('#opsVoucherStatus').textContent=r.message;b.disabled=false;}});
    if(!['admin','vouchers'].includes(state.route)) closeDialog();
    watchWallet();
  }
  function markVisitPending() {
    if(owner!==state.user?.id) reset();
    visitSyncGeneration++; visitSyncPending=true;
  }
  return {admin,navigation,refresh,bind,snapshot,vouchers,reset,chooseReward,markVisitPending,identityView,identityRow,
    identity:()=>owner===state.user?.id?identity:null,
    visitSyncPending:()=>owner===state.user?.id && visitSyncPending,
    eventId:()=>owner===state.user?.id?event?.id ?? null:null};
})();
