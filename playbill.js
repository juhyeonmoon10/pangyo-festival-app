(() => {
  const key = 'festival-stage-demo-2026';
  const empty = () => ({shows: ['밴드 공연','댄스 공연','보컬 공연'].map((title,i)=>({
    id:`demo-stage-${i+1}`,title:`[예시] ${title}`, starts_at:`2026-01-01T0${i}:00:00Z`, ends_at:`2026-01-01T0${i}:30:00Z`
  })), ballots: {}});
  const load = () => JSON.parse(localStorage.getItem(key) || 'null') || empty();
  const kst = date => new Date(+new Date(date) + 9 * 3600000).toISOString().slice(0,16);
  const ended = row => Date.parse(row.ends_at) <= Date.now();
  const esc = s => escapeHtml(String(s));
  const dayLabel = new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul', month:'long',day:'numeric',weekday:'short'});
  function sheet(manage, content, count) {
    return `<section class="stage-paper"><header class="stage-heading"><span class="stage-symbol">${icon('list')}</span><h2>${manage?'공연 관리':'공연 순서지'}</h2>${count ? `<small>공연 ${count}개</small>` : ''}</header>${content}</section>`;
  }
  function program(rows) {
    if (!rows.length) return '<p class="stage-note">아직 등록된 공연이 없어요.</p>';
    const days = new Map();
    for (const row of rows) {
      const date = kst(row.starts_at).slice(0,10);
      if (!days.has(date)) days.set(date,[]);
      days.get(date).push(row);
    }
    return [...days.values()].map(group => `<div class="stage-day"><h3>${dayLabel.format(new Date(group[0].starts_at))}</h3><ol>${group.map(s=>`<li><time datetime="${esc(s.starts_at)}">${kst(s.starts_at).slice(11)}</time><strong>${esc(s.title)}</strong></li>`).join('')}</ol></div>`).join('');
  }
  customElements.define('festival-playbill', class extends HTMLElement {
    async connectedCallback() {
      this.manage = this.hasAttribute('manage');
      this.actor = String(state.user?.id || '');
      this.innerHTML = sheet(this.manage,'<p class="stage-note" role="status">일정을 불러오는 중…</p>');
      try {
        if (isServerMode()) {
          const [s,b] = await Promise.all([festivalAccount.stage.list(), festivalAccount.stage.ballot()]);
          if ([s.error,b.error].some(err=>['PGRST205','42P01'].includes(err?.code))) {
            this.innerHTML = sheet(this.manage,`<p class="stage-note">${this.manage?'공연 관리와 투표는 서버 연결 후 열립니다.':'공연 일정 준비 중'}</p>`);
            return;
          }
          if (s.error || b.error) throw Error();
          this.shows = s.data; this.ballot = b.data && [b.data.first,b.data.second,b.data.third];
        } else {
          const db = load(); this.shows = db.shows; this.ballot = db.ballots[this.actor];
        }
        if (this.isConnected) this.draw();
      } catch {
        this.innerHTML = sheet(this.manage,'<p class="stage-note">공연 일정을 불러올 수 없어요.</p><button class="ghost-btn" type="button">다시 시도</button>');
        this.querySelector('button').onclick = () => this.connectedCallback();
      }
    }
    draw() {
      this.shows.sort((a,b) => Date.parse(a.starts_at)-Date.parse(b.starts_at) || a.id.localeCompare(b.id));
      const options = rows => rows.map(s=>`<option value="${esc(s.id)}">${esc(s.title)}</option>`).join('');
      const eligible = this.shows.filter(ended);
      const editor = `<form><label>공연 선택<select class="select" name="id"><option value="">새 공연</option>${options(this.shows)}</select></label><label>공연명<input class="input" name="title" maxlength="120" required></label><label>시작 (한국 시간)<input class="input" type="datetime-local" name="start" required></label><label>종료 (한국 시간)<input class="input" type="datetime-local" name="end" required></label><div class="stage-actions"><button class="primary-btn">저장</button><button type="button" class="danger-btn" data-remove hidden>삭제</button></div></form>`;
      const receipt = this.ballot?.map((id,i)=>`<li><span>${i+1}순위</span><strong>${esc(this.shows.find(x=>x.id===id)?.title || '공연')}</strong></li>`).join('');
      const voter = this.ballot ? `<p class="stage-confirmed">${icon('check')} 투표 완료</p><ol class="stage-receipt">${receipt}</ol>` : eligible.length < 3 ? '<p class="stage-note">세 공연 이상 종료되면 투표할 수 있어요.</p>' : `<form>${[1,2,3].map(i=>`<label class="stage-rank"><span>${i}순위</span><select class="select" required name="rank${i}"><option value="">공연 선택</option>${options(eligible)}</select></label>`).join('')}<button class="primary-btn" disabled>최종 투표</button></form>`;
      this.innerHTML = sheet(this.manage,`${program(this.shows)}<details ${this.manage||this.reopen?'open':''}><summary>${this.manage?'공연 등록·수정':this.ballot?'내 투표':'공연 투표'}${icon('plus')}${icon('minus')}</summary>${this.manage?editor:voter}</details><p class="stage-note" role="status"></p>`,this.shows.length);
      const form = this.querySelector('form');
      if (!form) return;
      const fields = form.elements;
      if (this.manage) {
        fields.id.onchange = () => {
          const row = this.shows.find(s=>s.id===fields.id.value);
          fields.title.value=row?.title||''; fields.start.value=row?kst(row.starts_at):''; fields.end.value=row?kst(row.ends_at):'';
          form.querySelector('[data-remove]').hidden=!row;
        };
        form.querySelector('[data-remove]').onclick = () => { if(fields.id.value && confirm('이 공연을 삭제할까요?')) this.write(form,'remove'); };
      } else form.onchange = () => {
        const picks = [...form.querySelectorAll('select')].map(s=>s.value);
        for(const select of form.querySelectorAll('select')) for(const opt of select.options) opt.disabled=!!opt.value && opt.value!==select.value && picks.includes(opt.value);
        form.querySelector('button').disabled=picks.includes('') || new Set(picks).size!==3;
      };
      form.onsubmit = e => {e.preventDefault(); this.write(form,this.manage?'save':'vote');};
    }
    async write(form,action) {
      if(this.busy)return;
      this.busy=true;
      const status=this.querySelector('[role=status]');
      try {
        const f=Object.fromEntries(new FormData(form));
        const store=isServerMode()?null:load();
        const api=isServerMode()?festivalAccount.stage:null;
        let result;
        if(action==='vote') {
          const picks=[f.rank1,f.rank2,f.rank3];
          if(new Set(picks).size!==3 || !picks.every(id=>(store?.shows||this.shows).some(s=>s.id===id && ended(s)))) throw Error('종료된 서로 다른 공연 세 개를 선택해 주세요.');
          if(api) result=await api.vote(picks);
          else { if(store.ballots[this.actor]) throw Error('이미 투표했어요.'); store.ballots[this.actor]=picks; }
        } else if(action==='save') {
          if(!f.title.trim() || !f.start || !f.end || f.end<=f.start) throw Error('공연명과 시작 이후의 종료 시간을 입력해 주세요.');
          const row={title:f.title.trim(),starts_at:new Date(f.start+':00+09:00').toISOString(),ends_at:new Date(f.end+':00+09:00').toISOString()};
          if(api) result=await api.save(f.id,row);
          else if(f.id) Object.assign(store.shows.find(s=>s.id===f.id),row); else store.shows.push({...row,id:crypto.randomUUID()});
        } else if(api) result=await api.remove(f.id);
        else { if(Object.values(store.ballots).some(b=>b.includes(f.id))) throw Error('이미 투표를 받은 공연은 삭제할 수 없어요.'); store.shows=store.shows.filter(s=>s.id!==f.id); }
        if(result?.error) throw Error(result.error.code==='23503'?'이미 투표를 받은 공연은 삭제할 수 없어요.':result.error.code==='23505'?'이미 투표했어요.':'저장하지 못했어요. 새로고침 후 다시 시도해 주세요.');
        if(store)localStorage.setItem(key,JSON.stringify(store));
        this.reopen=true; await this.connectedCallback();
        const note=this.querySelector('[role=status]'); if(note)note.textContent=action==='vote'?'투표를 제출했어요.':action==='remove'?'삭제했어요.':'저장했어요.';
      } catch(e) {status.textContent=e.message;} finally {this.busy=false;}
    }
  });
})();
