/* Real operations UI. All authorization and rewards remain in guarded server RPCs. */
const festivalOpsUI = (() => {
  let owner=null, mine=null, catalog=[], event=null, busy=false, loading=false, loaded=false, failure='';
  let guardData=null, notices=[], selectedNotice='';
  let tab='dashboard', data=null, offset=0, search='', selectedBooth=null, selectedRule='';
  let stream=null, cameraTimer=null, qrTimer=null, qrPoll=null, walletPoll=null;
  // Seconds between voucher state checks while a voucher is on screen.
  const VOUCHER_POLL_MS=5000;
  const VOUCHER_FINISHED={VOUCHER_USED:['사용이 완료되었어요','이 바우처는 사용 처리되었어요.'],VOUCHER_VOID:['발급이 취소되었어요','운영자가 이 바우처를 취소했어요.'],VOUCHER_EXPIRED:['사용 기한이 지났어요','이 바우처는 더 이상 사용할 수 없어요.'],NOT_FOUND:['바우처를 찾을 수 없어요','바우처 목록을 다시 확인해 주세요.']};
  let lastRoute=null;
  let refreshQueued=false, queuedRepaint=false, notice='', noticeAt=null;
  // A status line: progress ("…중...") is neutral, other text is an error unless a tone is given.
  const tell=(node,text,tone)=>{ if(!node) return; node.dataset.tone=tone || (/중\.\.\.$/.test(text) ? 'info' : 'error'); node.textContent=text; };
  let refreshWaiters=[];
  let visitRecipient=null;
  let visitSyncPending=false, visitSyncGeneration=0;
  let identity=null, identityBusy=false, identityNote='', identityQuery='', identityDraft='';
  const labels={dashboard:'운영 현황',tools:'관리 도구',catalog:'부스 관리',participants:'참여자',visits:'방문 기록',ledger:'포인트',rules:'바우처 설정',vouchers:'발급·사용',audit:'처리 기록',claim_guard:'부정 적립 감지',notice_admin:'공지 관리',identity_overview:'소속 관리',booth_managers:'권한 관리',nfc:'NFC 발급',sun:'보안 NFC 카드','stamp-simulator':'스탬프 모의 발급',settings:'축제 운영 설정'};
  const localTabs=new Set(['tools','nfc','sun','booth_managers','stamp-simulator','settings']);
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
  const form=(action,body,submit='저장',symbol='save')=>`<form class="ops-form" data-ops-form="${action}">${body}${spotMarkup(noticeAt===action?{at:`form:${action}`,text:notice,tone:'success'}:null,`form:${action}`)}<button class="primary-btn" type="submit">${icon(symbol)} ${submit}</button></form>`;
  const reason=()=>field('reason','처리 사유','','required minlength="3" maxlength="300"');
  // A participant is named only by 학번; the operator confirms the student before any write.
  const recipientCard=r=>`<p class="ops-recipient-chosen" role="status">${icon('check')} <strong>${h(person(r.name,r.studentNumber))}</strong>${r.self?' · 내 계정':''}${r.realName?` · ${h(r.realName)}`:''}${r.clubs?.length?` · ${r.clubs.map(h).join(', ')}`:''}</p>`;
  // The student list is searched by name or 학번; the chosen student is sent by 학번 only.
  const participant=(label='처리할 학생')=>`<div class="ops-recipient" data-recipient><span class="ops-recipient-label">${h(label)}</span><input type="hidden" name="studentNumber" value="${h(visitRecipient?.studentNumber || '')}"><input type="hidden" name="email" value="${h(visitRecipient?.email || '')}"><div data-recipient-result>${visitRecipient?recipientCard(visitRecipient)+'<button type="button" class="text-link" data-recipient-change>다른 학생 고르기</button>':''}</div><div class="ops-search" data-recipient-search ${visitRecipient?'hidden':''}><input class="input" name="recipientQuery" maxlength="60" placeholder="이름 또는 학번" aria-label="학생 찾기 (이름 또는 학번)" autocomplete="off"><button type="button" class="icon-btn" data-recipient-find aria-label="학생 찾기">${icon('search')}</button></div><div class="ops-participant-list" data-recipient-list ${visitRecipient?'hidden':''}></div></div>`;
  const visitParticipant=()=>participant('스탬프를 받을 학생');
  const options=()=>catalog.map(b=>[b.key,b.name]);
  const person=(name,sid)=>`${name || '참여자'} (${sid || '학번 없음'})`;
  const currentEventReady=()=>Boolean(event?.id && Number.isInteger(event.version) && event.version>0);

  function reset() {
    owner=state.user?.id || null; mine=null; guardData=null; notices=[]; selectedNotice=''; catalog=[]; event=null; data=null; loaded=false; failure=''; notice='', noticeAt=null; tab='dashboard'; selectedBooth=null; selectedRule='';
    visitRecipient=null; visitSyncPending=false; visitSyncGeneration++; identity=null; identityNote=''; identityDraft=''; closeDialog();
  }
  const viewKey=()=>JSON.stringify([state.user?.id,state.route,tab,offset,search]);
  function selectTab(next) {
    if(!Object.hasOwn(labels,next)) return;
    if(owner!==state.user?.id) reset();
    tab=next; offset=0; search=''; data=null; failure=''; notice='', noticeAt=null; loaded=localTabs.has(next);
    if(next==='settings') guardData=null;
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
      // The bundled club image and floor, kept so a removed photo or location falls back to them.
      if(!('catalogImage' in b)) Object.assign(b,{catalogImage:b.image || null,catalogImageKind:b.imageKind,homeFloor:b.floor});
      const photo=remote.image && typeof festivalAccount!=='undefined' ? festivalAccount.boothImages?.url(remote.image) : '';
      Object.assign(b,{opsKey:remote.key,opsRecord:remote,name:remote.name,status:remote.status,
        description:remote.description || b.description,location:remote.location || '위치 미등록',
        image:photo || b.catalogImage,imageKind:photo ? 'photo' : b.catalogImageKind,mapRoom:remote.room || '',
        placed:Boolean(remote.location || remote.room)});
      // Existing map geometry is not reassigned by an imported default floor.
      if(b.placed || b.category==='additional') b.floor=remote.floor;
      else if(b.homeFloor) b.floor=b.homeFloor;
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
      const [a,b,rewards,news]=await Promise.all(['catalog','me','reward_status','notices'].map(kind=>api().read(kind)));
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
      // Notices are optional: before their migration the home simply shows none.
      notices=news.ok && Array.isArray(news.data.items) ? news.data.items.filter(n=>n && typeof n.title==='string' && typeof n.body==='string' && typeof n.important==='boolean' && !Number.isNaN(Date.parse(n.publishedAt))) : [];
      mine.rewardProgram=validProgram ? {...program,supported:true} : {ready:false,supported:false,legacyRules:rewards.code==='OPS_NOT_READY'};
      mergeCatalog();
      // A direct booth URL may precede the first server catalog response.
      if(['detail','boothReviews'].includes(state.route) && state.selectedBoothId) loadBoothReviews(state.selectedBoothId);
      serverMyReviews=new Set((mine.reviews || []).map(x=>x.booth_key));
      for(const r of mine.reviews || []) {
        const before=serverReviews.get(r.booth_key);
        if(before) serverReviews.set(r.booth_key,{...before,myRating:r.rating,reviews:[...before.reviews.filter(x=>!x.mine),{rating:r.rating,content:r.content,mine:true,author:r.author_name || '참여자',createdAt:r.created_at}]});
      }
      if(state.route==='admin' && isAdminUser() && requestedTab==='settings') {
        const g=await api().read('claim_guard');
        if(state.user?.id!==actor || requestedView!==viewKey()) return;
        guardData=g.ok ? g.data : {error:g.message};
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
    return `<nav class="festival-ops-tabs" aria-label="관리 마법사 화면"><div>${[['dashboard','현황'],['tools','관리 도구'],['audit','기록']].map(([id,label])=>`<button type="button" data-ops-tab="${id}" aria-current="${group===id?'page':'false'}">${label}</button>`).join('')}</div><button class="icon-btn" data-ops-refresh aria-label="새로고침" title="새로고침">${icon('refresh')}</button></nav>${!['dashboard','tools','audit'].includes(tab) ? '<button type="button" class="text-link festival-tool-back" data-ops-tab="tools">'+icon('back')+' 관리 도구 목록</button>' : ''}`;
  }
  function toolsMenu() {
    const tools=[['catalog','map','부스 상태·프로그램'],['nfc','scan','NFC 태그 발급'],['sun','lock','보안 NFC 카드 (NTAG 424)'],['visits','stamp','방문 수동 승인'],['participants','user','참여자'],['identity_overview','check','소속 관리'],['booth_managers','user','권한 관리'],['ledger','plus','포인트 조정'],['rules','ticket','바우처 지급 기준'],['vouchers','scan','바우처 발급·사용'],['claim_guard','notice','부정 적립 감지'],['notice_admin','bell','공지 관리'],['stamp-simulator','stamp','스탬프 모의 발급'],['settings','admin','축제 운영 설정']];
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
    return `<section class="ops-section ops-reset"><h2>참여 기록 초기화</h2><p>이 축제의 리허설 기록만 비워요. 삭제한 기록은 되돌릴 수 없어요.</p><ul class="ops-reset-scope"><li><strong>삭제</strong> 이 축제의 방문·스탬프, 바우처, 리뷰, 포인트</li><li><strong>유지</strong> 공용 퀘스트·잔고·기존 별점, 계정·권한, 부스·바우처 설정, NFC 태그와 인식 횟수, 공식 명단, 처리 기록</li></ul>${form('participation_reset',
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
  function claimGuardView(g=data,withList=true) {
    if(typeof g?.enabled!=='boolean' || !Number.isInteger(g.windowMinutes) || !Number.isInteger(g.maxClaims)) return '<p class="ops-alert" role="alert">부정 적립 감지를 불러오지 못했어요. 서버 업데이트가 필요하거나 연결을 확인해야 해요.</p>';
    const items=Array.isArray(g.items) ? g.items : [];
    return `<section class="ops-section ops-claim-guard"><h2>부정 적립 제한</h2><p>NFC로 새 부스를 짧은 시간에 너무 많이 적립하면 다음 적립을 막아요. 이미 적립한 부스를 다시 찍는 것과 운영자 수동 승인은 막지 않아요.</p>${form('claim_guard_save',
      `<div class="ops-guard-fields">${field('windowMinutes','기간 (분)',g.windowMinutes,'required min="1" max="180" step="1" inputmode="numeric"','number')}${field('maxClaims','최대 적립 수',g.maxClaims,'required min="1" max="100" step="1" inputmode="numeric"','number')}</div>`+
      `<p class="ops-guard-summary" data-guard-summary>${guardSummary(g.windowMinutes,g.maxClaims)}</p>`+
      `<label class="ops-checkbox"><input name="enabled" type="checkbox" ${g.enabled?'checked':''}>적립 제한 사용</label><input type="hidden" name="version" value="${g.version}">`,'기준 저장')}<p class="ops-guard-note">링크를 복사해 붙여 넣은 것과 카드를 직접 찍은 것은 지금 카드로는 구분할 수 없어요. 몰아서 적립하는 것을 막고, 기준에 도달한 참여자를 따로 보여 주는 방식이에요.</p></section>`
      +(withList ? `<section class="ops-section ops-guard-list"><h2>기준에 도달한 참여자 <span>${items.length}명</span></h2><p>${g.windowMinutes}분 안에 NFC로 ${g.maxClaims}개 이상 적립한 적이 있는 참여자예요. 현재 기준으로 다시 계산해요.</p>`
      +(items.length ? table(items,[['참여자',r=>person(r.name,r.studentNumber)],['기간 내 최다',r=>`${r.peak}개`],['NFC',r=>r.nfc],['수동',r=>r.manual],['마지막 적립',r=>time(r.lastAt)]]) : '<p class="ops-empty">아직 기준에 도달한 참여자가 없어요.</p>')+'</section>' : `<button type="button" class="ghost-btn ops-guard-open" data-ops-tab="claim_guard">${icon('notice')} 기준에 도달한 참여자 보기</button>`);
  }
  function noticeAdminView() {
    if(!Array.isArray(data?.items)) return '<p class="ops-alert" role="alert">공지를 불러오지 못했어요. 서버 업데이트가 필요하거나 연결을 확인해야 해요.</p>';
    const items=data.items, n=items.find(x=>x.id===selectedNotice);
    return `<section class="ops-section ops-notice-form"><h2>${n?'공지 수정':'새 공지'}</h2><label>편집할 공지<select id="opsNoticeSelect" class="select"><option value="">새 공지 작성</option>${items.map(x=>`<option value="${h(x.id)}" ${x.id===selectedNotice?'selected':''}>${h(x.title)}${x.published?'':' (숨김)'}</option>`).join('')}</select></label>${form('notice_save',
      field('title','제목',n?.title,'required maxlength="80" autocomplete="off"')+
      `<label>내용<textarea class="textarea" name="body" maxlength="1000" rows="5" placeholder="학생 홈 화면의 축제 소식에 보여요.">${h(n?.body)}</textarea></label>`+
      (typeof festivalNotices==='undefined'?'':festivalNotices.editor(n))+
      `<label class="ops-checkbox"><input name="important" type="checkbox" ${n?.important?'checked':''}>중요 공지 (홈 맨 위 알림 띠에 표시)</label>`+
      `<label class="ops-checkbox"><input name="published" type="checkbox" ${!n || n.published?'checked':''}>학생에게 게시</label>`+
      `<input type="hidden" name="id" value="${h(n?.id)}"><input type="hidden" name="version" value="${n?.version || 0}">`,n?'공지 수정':'공지 등록',n?'save':'plus')}${n?`<button type="button" class="ghost-btn danger ops-notice-delete" data-notice-delete="${h(n.id)}" data-notice-version="${n.version}">${icon('close')} 공지 삭제</button>${spotMarkup(null,'notice-delete')}`:''}</section>`
      +`<section class="ops-section"><h2>등록된 공지 <span class="ops-count">${items.length}개</span></h2>${items.length?`<ul class="ops-notice-list">${items.map(x=>`<li class="${x.published?'':'is-hidden'}"><div><strong>${x.important?'<span class="ops-notice-flag">중요</span>':''}${h(x.title)}</strong>${x.body?`<p>${h(x.body)}</p>`:''}<small>${h(time(x.createdAt))} · ${h(x.author)}${x.images?.length?` · 사진 ${x.images.length}장`:''}${x.published?'':' · 숨김'}</small></div><button type="button" class="ghost-btn" data-notice-edit="${h(x.id)}">수정</button></li>`).join('')}</ul>`:'<p class="ops-empty">아직 등록된 공지가 없어요.</p>'}</section>`;
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
    return `<form id="opsSearch" class="ops-search"><input class="input" name="search" value="${h(search)}" placeholder="이름 또는 학번" aria-label="검색"><button class="icon-btn" title="검색" aria-label="검색">${icon('search')}</button></form>`;
  }
  function paging() {
    return `<div class="ops-paging"><button class="icon-btn" data-ops-page="-50" ${offset?'':'disabled'} aria-label="이전 페이지">${icon('back')}</button><span>${Math.floor(offset/50)+1}페이지</span><button class="icon-btn" data-ops-page="50" ${(data?.items?.length || 0)<50?'disabled':''} aria-label="다음 페이지">${icon('arrow')}</button></div>`;
  }
  function bulkStatusForm() {
    if(!catalog.length) return '';
    const floors=[...new Set(catalog.map(b=>b.floor))].sort();
    const quick=[['all','전체'],['none','선택 해제'],...floors.map(f=>[`floor-${f}`,`${f}층`]),['status-paused','일시 중지만'],['status-open','운영 중만']];
    return `<section class="ops-section ops-bulk-status"><h2>운영 상태 일괄 변경</h2><p>여러 부스를 골라 한 번에 운영 중·일시 중지·마감으로 바꿔요.</p>${form('booth_status_bulk',
      `<div class="ops-bulk-quick" role="group" aria-label="빠른 선택">${quick.map(([id,label])=>`<button type="button" class="ghost-btn" data-bulk-pick="${id}">${label}</button>`).join('')}</div>`+
      `<fieldset class="ops-bulk-list"><legend>부스 선택 <span data-bulk-count>0개 선택</span></legend>${catalog.map(b=>`<label class="ops-checkbox"><input type="checkbox" name="booths" value="${h(b.key)}" data-floor="${h(b.floor)}" data-status="${h(b.status)}"><span>${h(b.name)}<small>${h(b.floor)}층 · ${h(statusName(b.status))}</small></span></label>`).join('')}</fieldset>`+
      select('status','바꿀 운영 상태',[['open','운영 중'],['paused','일시 중지'],['closed','마감']],'open')+
      `<input type="hidden" name="eventId" value="${h(event?.id)}">`,'선택한 부스 상태 변경','check')}</section>`;
  }
  function boothForm() {
    const b=selectedBooth===null ? catalog[0] : catalog.find(x=>x.key===selectedBooth);
    return `<section class="ops-section"><h2>${b?'부스 수정':'부스 추가'}</h2><label>편집할 부스<select id="opsBoothSelect" class="select"><option value="" ${!b?'selected':''}>새 부스</option>${options().map(([key,name])=>`<option value="${h(key)}" ${key===b?.key?'selected':''}>${h(name)}</option>`).join('')}</select></label>${form('booth_save',
      field('name','부스 이름',b?.name,'required maxlength="100"')+field('location','위치',b?.location,'maxlength="200"')+
      select('floor','층',[[1,'1층'],[2,'2층'],[3,'3층'],[4,'4층']],b?.floor || 1)+
      select('status','운영 상태',[['paused','일시 중지'],['open','운영 중'],['closed','마감']],b?.status || 'paused')+
      `<label>부스 소개<textarea class="textarea" name="description" maxlength="2000">${h(b?.description)}</textarea></label><input type="hidden" name="booth" value="${h(b?.key)}"><input type="hidden" name="version" value="${b?.version || 0}">`)}</section>`;
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
    if(tab==='settings') return eventForm()+(!guardData ? '<section class="ops-section"><h2>부정 적립 제한</h2><p role="status">불러오는 중...</p></section>' : guardData.error ? `<section class="ops-section"><h2>부정 적립 제한</h2><p class="ops-alert" role="alert">${h(guardData.error)}</p><button type="button" class="ghost-btn" data-ops-refresh>${icon('refresh')} 다시 불러오기</button></section>` : claimGuardView(guardData,false))+resetForm();
    if(tab==='dashboard') return `<div class="festival-op-status ${event.state === 'open' ? '' : 'is-paused'}">${icon(event.state === 'open' ? 'check' : 'notice')}<div><strong>${h(statusName(event.state))}</strong><p>축제 운영 상태</p></div><button type="button" class="icon-btn" data-ops-tab="settings" aria-label="축제 운영 설정" title="축제 운영 설정">${icon('admin')}</button></div><dl class="ops-stats">${[['참여자',data?.participants],['방문',data?.visits],['리뷰',data?.reviews],['바우처 발급',data?.issued],['바우처 사용',data?.used]].map(([k,v])=>`<div><dt>${k}</dt><dd>${v ?? '-'}</dd></div>`).join('')}</dl>${boothReadiness()}${boothStamps()}<section class="ops-section"><h2>빠른 처리</h2><div class="festival-ops-tools">${[['visits','stamp','수동 방문 승인'],['vouchers','scan','바우처 확인·사용'],['nfc','scan','NFC 태그 발급'],['claim_guard','notice','부정 적립 감지']].map(([id,symbol,label])=>`<button type="button" data-ops-tab="${id}"><span class="festival-tool-icon">${icon(symbol)}</span><strong>${label}</strong>${icon('arrow')}</button>`).join('')}</div></section>`;
    if(tab==='claim_guard') return claimGuardView();
    if(tab==='notice_admin') return noticeAdminView();
    if(tab==='identity_overview') return identityAdminView();
    if(tab==='catalog') return bulkStatusForm()+boothForm()+table(catalog,[['부스','name'],['위치','location'],['상태',r=>statusName(r.status)]]);
    if(tab==='participants') return searchForm()+table(data?.items,[['학번',r=>r.student_number || '-'],['이름','name'],['방문','visits'],['포인트','points']])+paging()+`<section class="ops-section"><h2>리뷰 실명·소속 확인</h2><p>학번으로 계정을 찾아 동아리 명단과 연결하거나 확인을 취소해요.</p>${identityFinder()}<button type="button" class="ghost-btn" data-ops-tab="identity_overview">${icon('check')} 소속 관리 열기</button></section>`;
    if(tab==='visits') return `<section class="ops-section"><h2>수동 방문 승인</h2>${form('visit_approve',visitParticipant()+select('booth','방문 부스',options().filter(([key])=>catalog.find(b=>b.key===key)?.status==='open'),null)+reason(),'스탬프 1개 승인')}</section>`+table(data?.items,[['시각',r=>time(r.created_at)],['참여자',r=>person(r.name,r.student_number)],['부스',r=>catalog.find(b=>b.key===r.booth_key)?.name || r.booth_key],['방식','method'],['사유','reason']])+paging();
    if(tab==='ledger') return `<section class="ops-section"><h2>포인트 조정</h2>${form('points_adjust',participant()+field('delta','변경 포인트 (+지급 / -차감)','','required min="-100000" max="100000" step="1"','number')+reason(),'조정 확정')}</section>`+searchForm()+table(data?.items,[['시각',r=>time(r.created_at)],['참여자',r=>person(r.name,r.student_number)],['변경','delta'],['사유','reason']])+paging();
    if(tab==='rules') return (mine?.rewardProgram?.supported ? rewardConfigForm() : mine?.rewardProgram?.legacyRules
      ? '<p class="ops-empty">3개·6개 지급은 아직 준비 중이에요. 기존 발급 기준은 관리할 수 있어요.</p>'+ruleForm()
      : '<p class="ops-alert" role="alert">바우처 지급 설정을 확인하지 못했어요. 새로고침 후 다시 확인해 주세요.</p>')
      +table(data?.items,[['이름','title'],['기준',r=>r.reward_kind?'3개·6개 지급':r.target],['발급','issued'],['한도',r=>stockText(r.stock)],['마감',r=>time(r.expires_at)],['활성',r=>r.enabled?'예':'아니오']]);
    if(tab==='vouchers') return `<section class="ops-section"><h2>바우처 사용</h2><form id="opsRedeem" class="ops-form"><label>인증키 (8자리)<input class="input ops-code-input" name="token" autocomplete="off" autocapitalize="characters" spellcheck="false" required maxlength="11" placeholder="QR 스캔 또는 직접 입력"></label>${spotMarkup(noticeAt==='redeem'?{at:'form:redeem',text:notice,tone:'success'}:null,'form:redeem')}<div class="ops-actions"><button class="icon-btn" type="button" data-ops-camera title="QR 스캔" aria-label="QR 스캔">${icon('scan')}</button><button class="primary-btn" type="submit">바우처 확인</button></div></form></section><section class="ops-section"><h2>수동 발급</h2>${manualVoucherForm()}</section><section class="ops-section"><h2>발급 취소</h2>${form('voucher_void',select('id','취소할 바우처',(data?.items || []).filter(v=>v.state==='available').map(v=>[v.id,`${v.name} · ${v.title}`]),null)+reason(),'취소 확정')}</section>`+searchForm()+table(data?.items,[['학번',r=>r.student_number || '-'],['이름','name'],['바우처','title'],['상태',r=>statusName(r.state)],['마감',r=>time(r.expires_at)]])+paging();
    return table(data?.items,[['시각',r=>time(r.created_at)],['처리자',r=>person(r.actor_name,r.actor_student_number)],['작업','action'],
      ['대상',r=>r.target_name!==undefined && r.target_name!==null?person(r.target_name,r.target_student_number):r.target],
      ['사유',r=>r.action==='review_identity_self_conflict'?'이미 연결된 학번으로 시도':r.action==='own_club_stamp_remove'?`${r.reason}개 제외`:r.reason]])+paging();
  }
  function admin() {
    if(tab==='nfc') return serverAdminView();
    // Secure cards (NTAG 424 DNA) are managed apart from the signed NFC tags.
    if(tab==='booth_managers') return `<main class="screen ops-screen"><header class="top-bar"><button class="icon-btn" data-route="home" aria-label="홈으로">${icon('back')}</button><div class="top-title"><strong>관리 마법사</strong></div></header>${navigation()}<div class="ops-body"><h1>권한 관리</h1>${typeof festivalBoothManager==='undefined'?'':festivalBoothManager.adminView()}${typeof festivalVoucherManager==='undefined'?'':festivalVoucherManager.adminView()}</div>${bottomNav('admin')}</main>`;
    if(tab==='sun') return `<main class="screen ops-screen"><header class="top-bar"><button class="icon-btn" data-route="home" aria-label="홈으로">${icon('back')}</button><div class="top-title"><strong>관리 마법사</strong></div></header>${navigation()}${typeof festivalSunCards==='undefined'?'':festivalSunCards.view()}${bottomNav('admin')}</main>`;
    if(tab==='stamp-simulator') return `<main class="screen ops-screen"><header class="top-bar"><button class="icon-btn" data-route="home" aria-label="홈으로">${icon('back')}</button><div class="top-title"><strong>관리 마법사</strong></div></header>${navigation()}${typeof festivalStampSimulator==='undefined'?'':festivalStampSimulator.view()}${bottomNav('admin')}</main>`;
    return `<main class="screen ops-screen"><header class="top-bar"><button class="icon-btn" data-route="home" aria-label="홈으로">${icon('back')}</button><div class="top-title"><strong>관리 마법사</strong></div></header>${navigation()}<div class="ops-body" aria-busy="${!loaded}"><h1>${labels[tab]}</h1>${notice && !noticeAt?`<p class="ops-form-status" data-tone="success" role="status">${h(notice)}</p>`:''}${failure?`<p class="ops-alert" role="alert">${h(failure)}</p>`:''}${!loaded?'<p role="status">불러오는 중...</p>':failure?'':content()}</div>${bottomNav('admin')}</main>`;
  }
  async function save(e) {
    e.preventDefault(); if(busy) return;
    const actor=state.user?.id, requestedView=viewKey();
    const form=e.currentTarget, action=form.dataset.opsForm, body=Object.fromEntries(new FormData(form)), note=form.querySelector('.ops-form-status');
    for(const key of ['version','floor','reviewPoints','delta','stock','target','photoStock','foodStock','photoVersion','foodVersion','windowMinutes','maxClaims']) if(key in body) body[key]=Number(body[key]);
    // A positive server version updates the existing festival and cannot enter the creation path.
    if(action==='event_save' && (!currentEventReady() || body.version!==event.version)) {
      tell(note,'축제 정보를 다시 불러온 뒤 저장해 주세요.'); return;
    }
    for(const key of ['id','booth']) if(body[key]==='') body[key]=null;
    if(['visit_approve','points_adjust','voucher_issue'].includes(action)) {
      delete body.recipientQuery;
      if(!visitRecipient || body.studentNumber!==visitRecipient.studentNumber) {
        tell(note,'처리할 학생을 목록에서 골라 주세요.'); return;
      }
      if(!body.email) delete body.email;
      if(action==='visit_approve' && !catalog.some(b=>b.key===body.booth && b.status==='open')) {
        tell(note,'운영 중인 부스를 선택해 주세요.'); return;
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
    if(action==='notice_save') { body.important=form.elements.important.checked; body.published=form.elements.published.checked; }
    if(action==='booth_status_bulk') {
      body.booths=[...form.querySelectorAll('[name=booths]:checked')].map(x=>x.value);
      if(!body.booths.length) { tell(note,'상태를 바꿀 부스를 선택해 주세요.'); return; }
    }
    if(['event_save','points_adjust','visit_approve','voucher_issue','voucher_void','reward_config','participation_reset','claim_guard_save','booth_status_bulk'].includes(action) && !confirm(action==='booth_status_bulk'?`선택한 부스 ${body.booths.length}개를 '${statusName(body.status)}'(으)로 바꿀까요?${body.status==='open'?'':' 이 부스들은 NFC 방문 인증이 중지돼요.'}`:action==='claim_guard_save'?(body.enabled?`${guardSummary(body.windowMinutes,body.maxClaims)} 이 기준을 바로 적용할까요?`:'NFC 적립 제한을 끌까요? 짧은 시간에 몰아서 적립해도 막지 않아요.'):action==='participation_reset'?`이 축제의 방문·스탬프, 바우처, 리뷰와 포인트를 삭제할까요?${body.identities?' 리뷰 실명 확인 연결도 삭제돼요.':''} 공용 퀘스트·잔고·기존 별점과 NFC 태그는 유지돼요. 삭제한 행사 기록은 되돌릴 수 없어요.`:action==='reward_config'&&body.enabled?`스탬프 3개에서 하나를 선택하고, 6개에서 나머지를 지급할까요? 참여자당 최대 2장이에요.\n포토부스 이용권: ${stockText(body.photoStock)} · 푸드트럭 교환권: ${stockText(body.foodStock)} · 사용 기한: ${time(body.expiresAt)}`:action==='visit_approve'?`${visitRecipient.name}님에게 ${catalog.find(b=>b.key===body.booth).name} 방문 스탬프 1개를 부여할까요? 이미 방문한 부스는 중복 적립되지 않아요.`:action==='points_adjust'?`${visitRecipient.name}님의 포인트를 ${body.delta>0?'+':''}${body.delta} 조정할까요?`:action==='voucher_issue'?`${visitRecipient.name}님에게 선택한 바우처를 발급할까요?`:action==='reward_config'?(body.enabled?'스탬프 3개에서 하나를 선택하고, 6개에서 나머지를 지급할까요? 행사당 최대 2장이에요. 기존 자동 지급 기준은 중지됩니다.':'실제 발급을 중지한 상태로 지급 기준을 저장할까요?'):'입력한 내용으로 처리할까요?')) return;
    busy=true; form.querySelector('button[type=submit]').disabled=true; tell(note,'처리 중...');
    try {
      // Notice photos are uploaded first; the notice then stores their paths.
      let uploaded=[];
      if(action==='notice_save' && typeof festivalNotices!=='undefined') {
        tell(note,'사진을 올리는 중...');
        const up=await festivalNotices.uploadDraft(body.id);
        if(!up.ok) { tell(note,up.message); return; }
        if(up.images) body.images=up.images;
        uploaded=up.uploaded;
      }
      const response=await api().write(action,body);
      if(!response.ok && uploaded.length) festivalNotices.discard(uploaded);
      if(state.user?.id!==actor || requestedView!==viewKey() || !form.isConnected) return;
      if(!response.ok) {
        if(['visit_approve','points_adjust','voucher_issue'].includes(action) && ['NOT_FOUND','STUDENT_NOT_FOUND','STUDENT_AMBIGUOUS'].includes(response.code)) {
          resetRecipient(form);
          tell(note,response.code==='NOT_FOUND'?'처리 대상을 찾지 못했어요. 새로고침 후 학생을 다시 확인해 주세요.':response.message);
          return;
        }
        tell(note,action==='voucher_issue' && response.code==='INVALID_INPUT'
          ? '학생과 처리 사유를 확인해 주세요.' : response.message);
        return;
      }
      if(action==='participation_reset') {
        // Local caches mirror the deleted server records until the next profile load.
        serverReviews.clear(); serverMyReviews=null; serverCompletedBooths=[]; form.reset();
      }
      if(action==='notice_save') { selectedNotice=''; if(typeof festivalNotices!=='undefined') festivalNotices.afterSave(); }
      notice=action==='notice_save'?(body.id?'공지를 수정했어요.':body.published?'공지를 등록했어요. 학생 홈에 바로 보여요.':'공지를 숨김 상태로 저장했어요.'):action==='booth_status_bulk'?`부스 ${response.data.selected}개를 '${statusName(response.data.status)}'(으)로 맞췄어요. 바뀐 부스 ${response.data.changed}개.`:action==='participation_reset'?`이 축제의 방문 ${response.data.visits}건, 바우처 ${response.data.vouchers}장, 리뷰 ${response.data.reviews}건을 초기화했어요. 공용 기록은 유지돼요.`:action==='visit_approve'?(response.data.result==='ALREADY_EARNED'?'이미 적립한 부스예요. 스탬프는 1개만 유지돼요.':`${visitRecipient.name}님에게 스탬프 1개를 적립했어요.`):action==='voucher_issue'?'바우처를 발급했어요.':action==='voucher_void'?'바우처 발급을 취소했어요.':'저장했어요.';
      selectedBooth=response.data.booth || selectedBooth; selectedRule=response.data.id && action==='rule_save'?response.data.id:selectedRule;
      noticeAt=action;
      await refresh();
      showNotice();
    } finally { busy=false; if(form.isConnected) form.querySelector('button[type=submit]').disabled=false; }
  }

  // After a save the success sits in that form; when the form is gone it moves to the top.
  function showNotice() {
    if(!noticeAt || showSpot(`form:${noticeAt}`,notice,'success')) return;
    noticeAt=null; render();
  }
  // 처리할 학생 목록: 이름 또는 학번으로 찾고, 고른 학생은 학번으로 확인한다. 같은 학번의 계정이
  // 여럿이면 운영자가 학생 본인의 계정을 고른다. 운영자 본인 계정도 고를 수 있다.
  let recipientSequence=0;
  function resetRecipient(form) {
    visitRecipient=null; form.elements.studentNumber.value=''; form.elements.email.value='';
    form.querySelector('[data-recipient-result]').innerHTML='';
    form.querySelector('[data-recipient-search]').hidden=false; form.querySelector('[data-recipient-list]').hidden=false;
    loadRecipients(form);
  }
  async function loadRecipients(form) {
    const list=form.querySelector('[data-recipient-list]'), query=form.elements.recipientQuery.value.trim();
    if(!list || !isAdminUser() || !currentEventReady()) return;
    const actor=state.user?.id, requestedView=viewKey(), seq=++recipientSequence;
    list.innerHTML='<p role="status">학생 목록을 불러오는 중...</p>';
    const response=await api().read('participants',{search:query,offset:0});
    if(state.user?.id!==actor || requestedView!==viewKey() || !list.isConnected || seq!==recipientSequence) return;
    if(!response.ok) { list.innerHTML=`<p role="status">${h(response.message)}</p><button type="button" class="ghost-btn" data-recipient-retry>다시 불러오기</button>`; list.querySelector('[data-recipient-retry]').onclick=()=>loadRecipients(form); return; }
    // Accounts that never finished sign-up have no 학번 and cannot take part.
    const people=(response.data.items || []).filter(p=>p && typeof p.name==='string' && /^[1-3][0-9]{4}$/.test(p.student_number || ''));
    list.innerHTML=people.length?people.map(p=>`<button type="button" class="ops-participant-row" data-recipient-pick="${h(p.student_number)}">${icon('user')}<span><strong>${h(person(p.name,p.student_number))}</strong><small>방문 ${Number(p.visits)||0}개 · 포인트 ${Number(p.points)||0}</small></span>${icon('arrow')}</button>`).join('')
      :`<p role="status">${query?'찾는 학생이 없어요. 이름이나 학번을 다시 확인해 주세요.':'아직 가입한 학생이 없어요.'}</p>`;
    list.querySelectorAll('[data-recipient-pick]').forEach(b=>b.onclick=()=>pickRecipient(form,b.dataset.recipientPick));
  }
  async function pickRecipient(form,sid) {
    if(!isAdminUser() || busy) return;
    const list=form.querySelector('[data-recipient-list]'), note=form.querySelector('.ops-form-status');
    const actor=state.user?.id, requestedView=viewKey(), seq=++recipientSequence;
    tell(note,''); list.innerHTML='<p role="status">학생 확인 중...</p>';
    const response=await api().read('student_lookup',{studentNumber:sid});
    if(state.user?.id!==actor || requestedView!==viewKey() || !list.isConnected || seq!==recipientSequence) return;
    if(!response.ok) { list.innerHTML=`<p role="status">${h(response.message)}</p>`; return; }
    const accounts=(response.data.accounts || []).filter(a=>a && typeof a.email==='string' && typeof a.name==='string');
    if(!accounts.length) { list.innerHTML='<p role="status">이 학번으로 가입한 계정이 없어요. 다시 찾아 주세요.</p>'; return; }
    const choose=a=>{
      visitRecipient={studentNumber:sid,email:accounts.length>1?a.email:'',name:a.name,realName:a.verified?a.realName:null,clubs:a.verified?a.clubs:[],self:a.self};
      form.elements.studentNumber.value=sid; form.elements.email.value=visitRecipient.email;
      form.querySelector('[data-recipient-result]').innerHTML=recipientCard(visitRecipient)+'<button type="button" class="text-link" data-recipient-change>다른 학생 고르기</button>';
      form.querySelector('[data-recipient-change]').onclick=()=>resetRecipient(form);
      form.querySelector('[data-recipient-search]').hidden=true; list.hidden=true; list.replaceChildren();
    };
    const selected=accounts.find(a=>a.selected);
    if(selected) { choose(selected); return; }
    list.innerHTML=`<p role="status">같은 학번으로 가입한 계정이 여러 개예요. 학생 본인의 계정을 골라 주세요.</p>`+accounts.map((a,i)=>`<button type="button" class="ops-participant-row" data-recipient-choice="${i}">${icon('user')}<span><strong>${h(person(a.name,sid))}</strong><small>${a.self?'내 계정 · ':''}${h(a.email)} · 방문 ${Number(a.visits)||0}개${a.verified?' · 소속 확인됨':''}</small></span>${icon('arrow')}</button>`).join('');
    list.querySelectorAll('[data-recipient-choice]').forEach(b=>b.onclick=()=>choose(accounts[Number(b.dataset.recipientChoice)]));
  }

  // Students confirm their membership: the sign-up student number must be on the roster and the typed
  // name must match it. Operators can revoke or relink any account from 소속 관리.
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
    if(me.verified) return page(`<section class="festival-identity-card" aria-label="확인된 소속"><span class="festival-identity-badge">${icon('check')} 소속 확인 완료</span><dl><div><dt>이름</dt><dd>${h(me.realName)}</dd></div><div><dt>학번</dt><dd>${h(me.studentNumber)}</dd></div><div><dt>소속 동아리</dt><dd>${me.clubs.map(h).join(', ')}</dd></div><div><dt>스탬프·별점 제외 부스</dt><dd>${me.boothKeys.length?boothNames(me.boothKeys).map(h).join(', '):'없음'}</dd></div></dl></section><p class="festival-identity-help">본인 동아리 부스는 스탬프를 적립하거나 별점을 남길 수 없어요. 다른 부스에는 모두 참여할 수 있고, 리뷰에는 위 이름이 표시돼요. 소속이 다르면 운영 부스에 문의해 주세요.</p>`);
    if(!me.eligible) return page('<p class="festival-identity-help">1·2학년 창체 동아리 명단으로 소속을 확인해요. 가입할 때 등록한 학번이 확인 대상이 아니에요.</p>');
    if(me.locked) return page(`<p class="ops-alert" role="alert">${identityMessages.OPERATOR_LOCKED}</p>`);
    return page(`<section class="festival-identity-card"><p class="festival-identity-help">가입할 때 등록한 학번과 창체 동아리 명단의 이름이 같으면 바로 확인돼요. 확인되면 본인 동아리를 제외한 부스에 별점을 남길 수 있어요. 본인 동아리 부스는 스탬프도 적립되지 않아요.</p><form class="ops-form" data-identity-confirm><label>가입할 때 등록한 학번<input class="input" value="${h(me.studentNumber)}" readonly aria-readonly="true"></label><label>이름 (동아리 명단과 같게)<input class="input" name="realName" required maxlength="60" autocomplete="name" spellcheck="false" value="${h(identityDraft)}"></label><p class="ops-form-status" role="status">${h(identityNote)}</p><button class="primary-btn" type="submit" ${identityBusy?'disabled':''}>${icon('check')} ${identityBusy?'확인 중...':'소속 확인'}</button></form><p class="festival-identity-help">학번이 틀렸거나 명단에 없으면 운영 부스에 문의해 주세요. 다른 사람의 학번으로 확인하면 운영자가 취소할 수 있어요.</p></section>`);
  }
  async function loadIdentity(actor,eventId) {
    if(typeof festivalAccount?.reviewIdentitySelf!=='function' || !eventId) return;
    const response=await festivalAccount.reviewIdentitySelf('status');
    if(state.user?.id!==actor || owner!==actor || event?.id!==eventId) return;
    const next=response.ok && response.data.eventId===eventId ? response.data : null;
    const changed=JSON.stringify(next)!==JSON.stringify(identity);
    identity=next;
    if(changed) {
      serverReviews.clear();
      if(['detail','boothReviews'].includes(state.route) && state.selectedBoothId) loadBoothReviews(state.selectedBoothId,{force:true});
    }
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
    identityBusy=true; identityNote=''; identityDraft=form.elements.realName.value; form.querySelector('button[type=submit]').disabled=true; tell(note,'확인 중...');
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
    return `<section class="ops-section"><h2>소속 확인 목록</h2><p>학생이 직접 확인하면 바로 목록에 올라와요. 다른 학생으로 확인됐거나 소속이 틀리면 열어서 취소하거나 바꿔 주세요.</p><p class="ops-identity-counts" data-identity-counts></p><form class="ops-search" data-identity-search><input class="input" name="search" maxlength="100" value="${h(identityQuery)}" placeholder="계정 이름, 실명 또는 학번" aria-label="소속 확인 검색"><button class="icon-btn" aria-label="소속 확인 검색">${icon('search')}</button></form><div class="ops-participant-list" data-identity-list><p role="status">불러오는 중...</p></div></section>`;
  }
  // 계정 찾기: the accounts behind a 학번. Two accounts sharing one are told apart by Google email.
  const identityFinder=()=>`<form class="ops-search" data-identity-find><input class="input" name="search" inputmode="numeric" pattern="[1-3][0-9]{4}" maxlength="5" required placeholder="학번 5자리" aria-label="계정 찾기 (학번)" autocomplete="off"><button class="icon-btn" aria-label="계정 찾기">${icon('search')}</button></form><p class="ops-form-status" role="status" data-identity-find-status></p><div class="ops-participant-list" data-identity-find-list></div>`;
  // 소속 관리: roster coverage, links, duplicate student-number attempts and removed own-club stamps.
  function identityAdminView() {
    const roster=data?.roster || {}, links=data?.links || {};
    const conflicts=Array.isArray(data?.conflicts) ? data.conflicts.filter(c=>typeof c?.email==='string' && typeof c.holderEmail==='string') : [];
    const removals=Array.isArray(data?.removals) ? data.removals.filter(r=>Number.isInteger(r?.count)) : [];
    const who=(name,sid)=>h(person(name,sid));
    const open=(sid,mail)=>`data-identity-open data-identity-sid="${h(sid || '')}" data-identity-email="${h(mail)}"`;
    return `<section class="ops-section ops-identity-overview"><h2>소속 확인 현황</h2><dl class="ops-stats">${[['명단 확정',roster.ready],['본인 확인',links.self],['운영자 확인',links.operator],['확인 취소',links.revoked],['제외한 본인 동아리 스탬프',data?.removedStamps]].map(([k,v])=>`<div><dt>${k}</dt><dd>${v ?? '-'}</dd></div>`).join('')}</dl><p>학생은 가입할 때 등록한 학번과 동아리 명단의 이름이 같으면 직접 소속을 확인해요. 본인 동아리 부스는 스탬프·별점 대상이 아니고, 확인 전이라도 가입 학번이 명단에 있으면 그 동아리 부스는 적립되지 않아요. 이미 받은 본인 동아리 스탬프는 자동으로 제외돼요.${roster.review?` 명단 확인이 필요한 ${roster.review}명은 직접 확인할 수 없어요.`:''}</p></section>`
      +`<section class="ops-section"><h2>학번 중복 확인 시도</h2><p>다른 계정에 이미 연결된 학번으로 확인하려 한 기록이에요. 두 계정 중 실제 학생을 확인해 연결을 바꿔 주세요.</p>${conflicts.length?`<div class="ops-participant-list">${conflicts.map(c=>`<div class="ops-identity-conflict"><button type="button" class="ops-participant-row" ${open(c.studentNumber,c.email)}>${icon('notice')}<span><strong>${who(c.accountName,c.studentNumber)}</strong><small>${h(c.email)} · ${who(c.holderName,c.holderStudentNumber)}에 연결된 학번으로 시도 · ${h(time(c.at))}</small></span>${icon('arrow')}</button><button type="button" class="text-link" ${open(c.holderStudentNumber,c.holderEmail)}>연결된 계정 열기 (${h(c.holderEmail)})</button></div>`).join('')}</div>`:'<p class="ops-empty">중복 시도가 없어요.</p>'}<p class="ops-form-status" role="status" data-identity-open-status></p></section>`
      +`<section class="ops-section"><h2>계정 직접 연결</h2><p>명단 이름이 다르거나 직접 확인이 안 되는 학생은 가입할 때 등록한 학번으로 계정을 찾아 명단과 연결해 주세요.</p>${identityFinder()}</section>`
      +identityList()
      +`<section class="ops-section"><h2>본인 동아리 스탬프 제외 기록</h2>${removals.length?table(removals,[['시각',r=>time(r.at)],['학생',r=>person(r.accountName,r.studentNumber)],['제외',r=>`${r.count}개`]]):'<p class="ops-empty">제외한 스탬프가 없어요.</p>'}</section>`;
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
    document.querySelector('[data-identity-counts]').textContent=`확인 ${counts.linked ?? 0}명 (본인 확인 ${counts.self ?? 0}명) · 취소 ${counts.revoked ?? 0}명`;
    const label=item=>item.state.verified?(item.selfRegistered?'본인 확인':'운영자 확인'):item.state.locked?'운영자 취소':'다시 확인 필요';
    list.innerHTML=response.data.items.length?response.data.items.map(item=>`<button type="button" class="ops-participant-row" data-identity-row data-identity-sid="${h(item.accountStudentNumber || '')}" data-identity-email="${h(item.email)}">${icon('user')}<span><strong>${h(item.accountName)} · ${h(item.realName)} (${h(item.studentNumber)})</strong><small>${item.clubs.map(h).join(', ')} · ${label(item)}</small></span>${icon('arrow')}</button>`).join(''):'<p role="status">확인된 학생이 없어요.</p>';
    list.querySelectorAll('[data-identity-row]').forEach(button=>button.onclick=()=>openRoster({studentNumber:button.dataset.identitySid,email:button.dataset.identityEmail},button,list,()=>button.isConnected,loadIdentityList));
  }
  // 계정 직접 연결: the accounts registered with a 학번.
  async function findIdentityAccount(e) {
    e.preventDefault();
    const form=e.currentTarget, status=form.parentElement.querySelector('[data-identity-find-status]'), list=form.parentElement.querySelector('[data-identity-find-list]');
    const actor=state.user?.id, requestedView=viewKey(), sid=form.elements.search.value.trim();
    if(!form.reportValidity() || !isAdminUser()) return;
    tell(status,'찾는 중...'); list.replaceChildren();
    const response=await api().read('student_lookup',{studentNumber:sid});
    if(state.user?.id!==actor || requestedView!==viewKey() || !list.isConnected) return;
    if(!response.ok) { tell(status,response.message); return; }
    const accounts=(response.data.accounts || []).filter(a=>a && typeof a.email==='string' && typeof a.name==='string');
    tell(status,accounts.length>1?'같은 학번으로 가입한 계정이 여러 개예요. 학생 본인의 계정을 골라 주세요.':accounts.length?'':'이 학번으로 가입한 계정이 없어요. 학번을 다시 확인해 주세요.','info');
    list.innerHTML=accounts.map(a=>`<button type="button" class="ops-participant-row" data-identity-found data-identity-email="${h(a.email)}">${icon('user')}<span><strong>${h(person(a.name,sid))}</strong><small>${accounts.length>1?`${h(a.email)} · `:''}방문 ${Number(a.visits)||0}개${a.verified?` · 소속 확인됨 (${a.selfRegistered?'본인 확인':'운영자 확인'})`:a.locked?' · 운영자 취소':''}</small></span>${icon('arrow')}</button>`).join('');
    list.querySelectorAll('[data-identity-found]').forEach(b=>b.onclick=()=>openRoster({studentNumber:sid,email:b.dataset.identityEmail},b,status,()=>b.isConnected,loadIdentityList));
  }
  async function openRoster(account,launch,status,attached,changed=()=>{}) {
    const actor=state.user?.id, requestedView=viewKey();
    if(!/^[1-3][0-9]{4}$/.test(account?.studentNumber || '') || !event || !isAdminUser()) return;
    if(launch.disabled) return;
    launch.disabled=true;
    const response=await festivalAccount.reviewIdentity('get',{eventId:event.id,account});
    if(launch.isConnected) launch.disabled=false;
    if(state.user?.id!==actor || !attached() || requestedView!==viewKey()) return;
    if(!response.ok) { tell(status,response.message); return; }
    const row=response.data, d=dialog('리뷰 실명·소속 확인'), body=d.querySelector('.ops-dialog-content');
    account=row.account;
    body.innerHTML=`<form class="ops-form" id="reviewRosterForm"><p>${h(person(row.accountName,account.studentNumber))}${row.verified?` · ${row.selfRegistered?'본인 확인':'운영자 확인'}`:''}</p>${field('studentNumber','명단 학번',row.roster?.studentNumber || account.studentNumber || '', 'required inputmode="numeric" pattern="[1-3][0-9]{4}" maxlength="5" autocomplete="off"')}<button class="ghost-btn" type="button" data-roster-find>명단 조회</button><div data-roster-result></div><label class="ops-checkbox"><input name="confirmed" type="checkbox" required>로그인한 학생 본인과 명단이 일치함을 확인했음</label>${reason()}<p class="ops-form-status" role="status"></p><button class="primary-btn" type="submit" disabled>계정에 연결</button>${row.verified?'<button class="ghost-btn" type="button" data-roster-revoke>연결 확인 취소</button>':''}</form>`;
    const f=body.querySelector('form'), button=f.querySelector('button[type=submit]'), note=f.querySelector('[role=status]');
    const find=f.querySelector('[data-roster-find]'), result=f.querySelector('[data-roster-result]');
    let candidate=null, sequence=0, saving=false;
    const valid=()=>state.user?.id===actor && requestedView===viewKey() && d.isConnected && isAdminUser();
    const show=value=>{
      candidate=value; f.elements.confirmed.checked=false;
      button.disabled=!value?.ready || value.linkedElsewhere;
      result.innerHTML=value?`<dl class="ops-roster-summary"><dt>명단 이름</dt><dd>${h(value.realName || '확인 필요')}</dd><dt>동아리</dt><dd>${value.clubs.map(h).join(', ')}</dd><dt>스탬프·리뷰 제외 부스</dt><dd>${value.boothKeys.length?value.boothKeys.map(h).join(', '):'해당 없음'}</dd></dl><p>${value.linkedElsewhere?'다른 계정에 연결된 명단이에요.':!value.ready?'명단 불일치 또는 부스 연결 확인이 필요해요.':'명단 대조 완료'}</p>`:'';
    };
    show(row.roster);
    f.elements.studentNumber.oninput=()=>{sequence++;show(null);tell(note,'');};
    find.onclick=async()=>{
      if(saving || !f.elements.studentNumber.reportValidity()) return;
      const seq=++sequence, studentNumber=f.elements.studentNumber.value;
      find.disabled=true; show(null); tell(note,'조회 중...');
      try {
        const response=await festivalAccount.reviewIdentity('lookup',{eventId:row.eventId,account,studentNumber});
        if(!valid() || seq!==sequence) return;
        if(!response.ok) { tell(note,response.message); return; }
        row.version=response.data.version; show(response.data.roster);
        tell(note,candidate?'':'명단에 없는 학번이에요.');
      } finally { if(find.isConnected) find.disabled=false; }
    };
    const save=async action=>{
      if(saving || !valid() || (action==='save' && (button.disabled || !f.reportValidity()))) return;
      const why=f.elements.reason.value.trim();
      if(why.length<3) { tell(note,'처리 사유를 3자 이상 입력해 주세요.'); return; }
      saving=true; sequence++; button.disabled=true; find.disabled=true;
      f.elements.studentNumber.disabled=true; note.dataset.tone=''; tell(note,'저장 중...');
      try {
        const response=await festivalAccount.reviewIdentity(action,{eventId:row.eventId,account,version:row.version,
          studentNumber:candidate?.studentNumber,rosterVersion:candidate?.version,confirmed:f.elements.confirmed.checked,reason:why});
        if(!valid()) return;
        if(!response.ok) { tell(note,response.message); return; }
        // Linking can change the account's 학번 to the roster's; later actions use the new one.
        account=response.data.account; row.version=response.data.version; serverReviews.clear(); changed();
        tell(note,action==='save'?'명단과 계정을 연결했어요.':'확인을 취소했어요.','success');
        show(action==='save'?response.data.roster:null);
        if(action==='revoke') f.querySelector('[data-roster-revoke]')?.remove();
      } finally {
        saving=false;
        if(f.isConnected) {find.disabled=false;f.elements.studentNumber.disabled=false;button.disabled=!candidate?.ready || candidate.linkedElsewhere;}
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
      if(!VOUCHER_CODE.test(code)) { tell(note,'인증키 8자리를 확인해 주세요.'); return; }
      const preview=await api().read('voucher_code_check',{code});
      if(state.user?.id!==actor || requestedView!==viewKey() || !form.isConnected) return;
      if(!preview.ok) { tell(note,preview.code==='VOUCHER_INVALID'?'맞지 않거나 시간이 지난 인증키예요. 참여자 화면의 새 인증키를 확인해 주세요.':preview.message); return; }
      const p=preview.data;
      if(!p.valid) { tell(note,p.state==='used'?'이미 사용한 바우처예요.':p.state==='void'?'취소된 바우처예요.':p.state==='expired'?'만료된 바우처예요.':!p.eventOpen?'축제가 운영 중이 아니어서 사용할 수 없어요.':'사용할 수 없는 바우처예요.'); return; }
      if(!confirm(`${p.title}\n${p.participant}${p.own?' (내 바우처)':''}\n상품을 전달하고 사용 완료로 처리할까요?`)) return;
      const r=await api().write('voucher_code_redeem',{code});
      if(state.user?.id!==actor || requestedView!==viewKey() || !form.isConnected) return;
      if(!r.ok) { tell(note,r.message); return; }
      notice='바우처를 사용 처리했어요.'; noticeAt='redeem';
      form.reset(); await refresh(); showNotice();
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
    if(!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) { tell(note,'이 브라우저에서는 QR 스캔을 지원하지 않아요. 참여자 화면의 인증키 8자리를 입력해 주세요.'); return; }
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
    // Settings is drawn at once but still reads the rate limit that sits on it.
    if(state.route==='admin' && tab==='settings' && !guardData && !loading && owner===state.user.id) queueMicrotask(()=>refresh());
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
    document.querySelectorAll('[data-recipient]').forEach(box=>{
      const f=box.closest('[data-ops-form]');
      box.querySelector('[data-recipient-find]').onclick=()=>loadRecipients(f);
      // Enter searches instead of submitting; an IME still composing Korean keeps its Enter.
      f.elements.recipientQuery.addEventListener('keydown',ev=>{ if(ev.key==='Enter' && !ev.isComposing) { ev.preventDefault(); loadRecipients(f); } });
      box.querySelector('[data-recipient-change]')?.addEventListener('click',()=>resetRecipient(f));
      if(!visitRecipient) loadRecipients(f);
    });
    document.querySelector('#opsNoticeSelect')?.addEventListener('change',e=>{selectedNotice=e.target.value;render();});
    document.querySelectorAll('[data-notice-edit]').forEach(b=>b.onclick=()=>{selectedNotice=b.dataset.noticeEdit;render();document.querySelector('.ops-notice-form')?.scrollIntoView({block:'start'});});
    document.querySelector('[data-notice-delete]')?.addEventListener('click',async e=>{
      const b=e.currentTarget, n=data?.items?.find(x=>x.id===b.dataset.noticeDelete);
      if(!n || busy || !confirm(`'${n.title}' 공지를 삭제할까요? 학생 홈에서도 바로 사라지고 되돌릴 수 없어요.`)) return;
      busy=true; b.disabled=true;
      try {
        const r=await api().write('notice_delete',{id:n.id,version:n.version});
        if(!r.ok) { showSpot('notice-delete',r.message); b.disabled=false; return; }
        if(typeof festivalNotices!=='undefined') { festivalNotices.reset(); festivalNotices.discard(n.images); }
        selectedNotice=''; notice='공지를 삭제했어요.'; noticeAt='notice_save'; await refresh(); showNotice();
      } finally { busy=false; }
    });
    const bulkForm=document.querySelector('[data-ops-form="booth_status_bulk"]');
    if(bulkForm) {
      const boxes=[...bulkForm.querySelectorAll('[name=booths]')];
      const count=()=>{ bulkForm.querySelector('[data-bulk-count]').textContent=`${boxes.filter(b=>b.checked).length}개 선택`; bulkForm.querySelector('.ops-form-status').textContent=''; };
      bulkForm.addEventListener('change',count);
      bulkForm.querySelectorAll('[data-bulk-pick]').forEach(b=>b.onclick=()=>{
        const pick=b.dataset.bulkPick;
        for(const box of boxes) box.checked=pick==='all' || (pick.startsWith('floor-') && box.dataset.floor===pick.slice(6)) || (pick.startsWith('status-') && box.dataset.status===pick.slice(7));
        count();
      });
    }
    const guardForm=document.querySelector('[data-ops-form="claim_guard_save"]');
    guardForm?.addEventListener('input',()=>{ guardForm.querySelector('[data-guard-summary]').textContent=guardSummary(Number(guardForm.elements.windowMinutes.value),Number(guardForm.elements.maxClaims.value)); });
    document.querySelector('#opsBoothSelect')?.addEventListener('change',e=>{selectedBooth=e.target.value;render();});
    document.querySelector('#opsRuleSelect')?.addEventListener('change',e=>{selectedRule=e.target.value;render();});
    document.querySelector('#opsSearch')?.addEventListener('submit',e=>{e.preventDefault();search=e.target.elements.search.value;offset=0;refresh();});
    document.querySelectorAll('[data-ops-page]').forEach(b=>b.onclick=()=>{offset=Math.max(0,offset+Number(b.dataset.opsPage));refresh();});
    document.querySelector('#opsRedeem')?.addEventListener('submit',redeem);
    document.querySelectorAll('[data-identity-open]').forEach(b=>b.onclick=()=>openRoster({studentNumber:b.dataset.identitySid,email:b.dataset.identityEmail},b,document.querySelector('[data-identity-open-status]'),()=>b.isConnected,loadIdentityList));
    document.querySelectorAll('[data-identity-find]').forEach(f=>f.addEventListener('submit',findIdentityAccount));
    document.querySelector('[data-identity-confirm]')?.addEventListener('submit',confirmIdentity);
    const identitySearch=document.querySelector('[data-identity-search]');
    if(identitySearch) {
      identitySearch.onsubmit=ev=>{ev.preventDefault();identityQuery=identitySearch.elements.search.value.trim();loadIdentityList();};
      if(loaded && !failure) loadIdentityList();
    }
    document.querySelector('[data-ops-camera]')?.addEventListener('click',camera);
    document.querySelectorAll('[data-ops-qr]').forEach(b=>b.onclick=()=>qr(b.dataset.opsQr));
    if(!['admin','vouchers'].includes(state.route)) closeDialog();
    watchWallet();
  }
  function markVisitPending() {
    if(owner!==state.user?.id) reset();
    visitSyncGeneration++; visitSyncPending=true;
  }
  return {admin,navigation,refresh,bind,snapshot,vouchers,reset,chooseReward,markVisitPending,identityView,identityRow,notices:()=>notices,
    identity:()=>owner===state.user?.id?identity:null,
    visitSyncPending:()=>owner===state.user?.id && visitSyncPending,
    eventId:()=>owner===state.user?.id?event?.id ?? null:null};
})();
