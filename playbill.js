(() => {
  const key = 'festival-stage-demo-2026';
  const empty = () => ({shows: ['밴드 공연','댄스 공연','보컬 공연'].map((title,i)=>({
    id:`demo-stage-${i+1}`,title:`[예시] ${title}`, starts_at:`2026-01-01T0${i}:00:00Z`, ends_at:`2026-01-01T0${i}:30:00Z`
  })), ballots: {}});
  const load = () => JSON.parse(localStorage.getItem(key) || 'null') || empty();
  const kst = date => new Date(+new Date(date) + 9 * 3600000).toISOString().slice(0,16);
  const ended = row => Date.parse(row.ends_at) <= Date.now();
  const esc = s => escapeHtml(String(s));
  customElements.define('festival-playbill', class extends HTMLElement {
    async connectedCallback() {
      this.manage = this.hasAttribute('manage');
      this.actor = String(state.user?.id || '');
      this.innerHTML = '<section class="stage-paper"><h2>공연 순서지</h2><p>일정을 불러오는 중…</p></section>';
      try {
        if (isServerMode()) {
          const [s,b] = await Promise.all([festivalAccount.stage.list(), festivalAccount.stage.ballot()]);
          if ([s.error,b.error].some(err=>['PGRST205','42P01'].includes(err?.code))) {
            this.innerHTML = `<section class="stage-paper"><header><h2>공연 순서지</h2><small>판교고 축제</small></header><p>${this.manage?'공연 관리와 투표는 서버 연결 후 열립니다.':'공연 일정 준비 중'}</p></section>`;
            return;
          }
          if (s.error || b.error) throw Error();
          this.shows = s.data; this.ballot = b.data && [b.data.first,b.data.second,b.data.third];
        } else {
          const db = load(); this.shows = db.shows; this.ballot = db.ballots[this.actor];
        }
        if (this.isConnected) this.draw();
      } catch {
        this.innerHTML = '<section class="stage-paper"><h2>공연 순서지</h2><p>공연 일정을 불러올 수 없어요.</p><button type="button">다시 시도</button></section>';
        this.querySelector('button').onclick = () => this.connectedCallback();
      }
    }
    draw() {
      this.shows.sort((a,b) => Date.parse(a.starts_at)-Date.parse(b.starts_at) || a.id.localeCompare(b.id));
      const options = rows => rows.map(s=>`<option value="${esc(s.id)}">${esc(s.title)}</option>`).join('');
      const eligible = this.shows.filter(ended);
      const editor = `<form><label>공연 선택<select name="id"><option value="">새 공연</option>${options(this.shows)}</select></label><label>공연명<input name="title" maxlength="120" required></label><label>시작 (한국 시간)<input type="datetime-local" name="start" required></label><label>종료 (한국 시간)<input type="datetime-local" name="end" required></label><button>저장</button><button type="button" data-remove hidden>삭제</button></form>`;
      const receipt = this.ballot?.map((id,i)=>`<p>${i+1}순위 · ${esc(this.shows.find(x=>x.id===id)?.title || '공연')}</p>`).join('');
      const voter = this.ballot ? `<strong>투표 완료</strong>${receipt}` : eligible.length < 3 ? '<p>세 공연 이상 종료되면 투표할 수 있어요.</p>' : `<form>${[1,2,3].map(i=>`<label>${i}순위<select required name="rank${i}"><option value="">공연 선택</option>${options(eligible)}</select></label>`).join('')}<button disabled>최종 투표</button></form>`;
      this.innerHTML = `<section class="stage-paper"><header><h2>${this.manage?'공연 관리':'공연 순서지'}</h2><small>판교고 축제</small></header>${this.shows.length?`<ol>${this.shows.map(s=>`<li><time>${kst(s.starts_at).slice(5,10).replace('-','/')} · ${kst(s.starts_at).slice(11)}</time><strong>${esc(s.title)}</strong></li>`).join('')}</ol>`:'<p>아직 등록된 공연이 없어요.</p>'}<details ${this.manage||this.reopen?'open':''}><summary>${this.manage?'공연 등록·수정':this.ballot?'내 투표':'공연 투표'}</summary>${this.manage?editor:voter}</details><p role="status"></p></section>`;
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
