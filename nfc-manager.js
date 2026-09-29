/* Local administrator tools. Real tag issuance remains a server-only operation. */
const nfcManagement = (() => {
  let query = "";
  let floor = "all";
  let filter = "all";
  let selectedId = null;
  let drafts = new Map();
  let results = new Map();
  let busy = false;
  const tagPattern = /^NFC-[A-Z0-9-]{1,64}$/;
  const allowed = () => !isServerMode() && isAdminUser();
  const boothById = id => state.db.booths.find(booth => booth.id === id);
  const nameFor = booth => catalogBooth(booth)?.name || booth.name;
  const saved = booth => ({ tag: booth.nfcTagId || "", enabled: booth.nfcEnabled !== false, status: booth.status });
  const draftFor = booth => {
    if (!drafts.has(booth.id)) drafts.set(booth.id, saved(booth));
    return drafts.get(booth.id);
  };
  const dirty = booth => JSON.stringify(draftFor(booth)) !== JSON.stringify(saved(booth));
  const tagState = booth => !booth.nfcTagId ? "missing" : booth.nfcEnabled === false ? "disabled" : "enabled";
  const tagLabels = { missing: "미등록", disabled: "사용 중지", enabled: "사용 중" };
  const demoUrl = booth => {
    const url = new URL(location.href);
    url.search = new URLSearchParams({ demo: "1", nfc: booth.nfcTagId }).toString();
    url.hash = "";
    return url.href;
  };

  function matchingBooths() {
    const term = normalizeSearchText(query);
    return state.db.booths.filter(booth => (floor === "all" || String(booth.floor) === floor)
      && (filter === "all" || tagState(booth) === filter)
      && `${boothSearchText(booth)} ${normalizeSearchText(booth.nfcTagId)}`.includes(term));
  }

  function rows() {
    const booths = matchingBooths();
    return booths.length ? booths.map(booth => `
      <button type="button" class="nfc-booth-row ${selectedId === booth.id ? "selected" : ""}" data-nfc-select="${escapeHtml(booth.id)}" aria-pressed="${selectedId === booth.id}">
        ${clubVisual(booth, "list")}
        <span class="nfc-row-info"><strong>${escapeHtml(nameFor(booth))}</strong><small>${escapeHtml(booth.location)} · ${escapeHtml(booth.nfcTagId || "태그 없음")}</small></span>
        <span class="nfc-tag-state ${tagState(booth)}">${tagLabels[tagState(booth)]}${dirty(booth) ? '<i aria-label="저장 전 변경 있음"></i>' : ""}</span>
      </button>`).join("") : '<p class="nfc-empty">일치하는 부스가 없습니다.</p>';
  }

  function resultView(id) {
    const result = results.get(id);
    if (!result) return "";
    return `<div class="nfc-manager-result ${result.tone || "info"}"><strong>${escapeHtml(result.title)}</strong>
      <p>${escapeHtml(result.body)}</p>${result.checks ? `<ul>${result.checks.map(check => `<li>${icon(check.ok ? "check" : "close")}<span>${escapeHtml(check.label)}</span></li>`).join("")}</ul>` : ""}</div>`;
  }

  function editor() {
    const booth = boothById(selectedId);
    if (!booth) return '<section class="nfc-editor"><p>관리할 부스를 선택해 주세요.</p></section>';
    const draft = draftFor(booth);
    return `<section class="nfc-editor" aria-labelledby="nfcEditorTitle" data-editing-booth="${escapeHtml(booth.id)}">
      <header><div><span class="nfc-eyebrow">선택한 부스 · ${booth.floor}층</span><h2 id="nfcEditorTitle" tabindex="-1">${escapeHtml(nameFor(booth))}</h2><p>${escapeHtml(booth.location)}</p></div>${icon("scan")}</header>
      <form id="nfcSettingsForm" novalidate>
        <label class="field" for="nfcManagerTag">데모 태그 ID
          <div class="nfc-tag-input"><input class="input" id="nfcManagerTag" value="${escapeHtml(draft.tag)}" maxlength="68" autocomplete="off" spellcheck="false" aria-describedby="nfcTagHint" />
            <button type="button" class="icon-btn" data-nfc-action="generate" title="새 데모 태그 ID 생성" aria-label="새 데모 태그 ID 생성">${icon("refresh")}</button></div>
        </label>
        <p class="nfc-field-note" id="nfcTagHint">NFC-로 시작하는 영문·숫자·하이픈. ID 변경 후 카드의 URL도 다시 기록해야 합니다.</p>
        <label class="field" for="nfcManagerStatus">부스 운영 상태<select class="select" id="nfcManagerStatus">${Object.entries(BOOTH_STATUS).map(([value, info]) => `<option value="${value}" ${draft.status === value ? "selected" : ""}>${info.label}</option>`).join("")}</select></label>
        <label class="nfc-enabled-setting" for="nfcManagerEnabled"><span><strong>NFC 적립 허용</strong><small>꺼도 기존 스탬프는 유지됩니다.</small></span><input type="checkbox" id="nfcManagerEnabled" ${draft.enabled ? "checked" : ""} /></label>
        <div class="nfc-save-row"><span id="nfcDraftStatus" role="status">${dirty(booth) ? "저장 전 변경 있음" : "저장된 설정"}</span>
          <button type="button" class="icon-btn" data-nfc-action="discard" title="변경 취소" aria-label="저장 전 변경 취소" ${dirty(booth) ? "" : "disabled"}>${icon("back")}</button>
          <button type="submit" class="primary-btn" id="nfcManagerSave" ${dirty(booth) ? "" : "disabled"}>${icon("save")} 변경 저장</button></div>
      </form>
      <section class="nfc-saved-tools" aria-label="저장된 태그 점검">
        <div class="nfc-section-title"><h3>저장된 태그 점검</h3><span>현재 관리자 데모 계정</span></div>
        <div class="nfc-tool-actions"><button type="button" class="ghost-btn" data-nfc-action="check">${icon("check")} 설정 점검</button>
          <button type="button" class="ghost-btn" data-nfc-action="simulate">${icon("scan")} 모의 적립</button></div>
        <label class="field" for="nfcDemoUrl">방문 인증 데모 웹 URL<div class="nfc-tag-input"><input id="nfcDemoUrl" class="input" value="${booth.nfcTagId ? escapeHtml(demoUrl(booth)) : ""}" readonly />
          <button type="button" class="icon-btn" data-nfc-action="copy" aria-label="데모 태그 URL 복사" title="데모 태그 URL 복사" ${booth.nfcTagId ? "" : "disabled"}>${icon("copy")}</button></div></label>
        <p class="nfc-field-note">현재 웹의 모의 방문 인증용입니다. localhost 주소는 이 컴퓨터에서만 열립니다. 다른 기기와 설정이 자동 동기화되지 않습니다.</p>
      </section>
      <div id="nfcManagerResult" role="status" aria-live="polite">${resultView(booth.id)}</div>
    </section>`;
  }

  function view() {
    if (!allowed()) return '<section class="nfc-manager"><h2>NFC 관리</h2><p>서버 관리자 권한·태그 발급 기능은 아직 연결되지 않았습니다.</p></section>';
    if (!boothById(selectedId)) selectedId = state.db.booths[0]?.id || null;
    const booths = state.db.booths;
    return `<section id="nfcManager" class="nfc-manager">
      <header class="nfc-manager-heading"><div><h1>NFC 관리</h1><p>부스별 등록 · 설정 · 점검</p></div><span class="nfc-demo-badge">로컬 데모</span></header>
      <p class="nfc-scope-note">이 기기에만 저장됩니다. 실제 서버 태그 발급·중지는 아직 연결되지 않았습니다.</p>
      <dl class="nfc-summary">${[["전체 부스", booths.length], ["사용 중", booths.filter(booth => tagState(booth) === "enabled").length], ["사용 중지", booths.filter(booth => tagState(booth) === "disabled").length], ["미등록", booths.filter(booth => tagState(booth) === "missing").length]].map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl>
      <div class="nfc-manager-search">${icon("search")}<input class="input" id="nfcManagerSearch" type="search" aria-label="부스명, 위치 또는 태그 ID 검색" placeholder="부스명, 위치, 태그 ID 검색" value="${escapeHtml(query)}" autocomplete="off" /></div>
      <div class="nfc-manager-filters"><label for="nfcManagerFloor">층<select class="select" id="nfcManagerFloor"><option value="all">전체 층</option>${[1, 2, 3, 4].map(value => `<option value="${value}" ${floor === String(value) ? "selected" : ""}>${value}층</option>`).join("")}</select></label>
        <label for="nfcManagerFilter">태그 상태<select class="select" id="nfcManagerFilter">${Object.entries({ all: "전체 상태", ...tagLabels }).map(([value, label]) => `<option value="${value}" ${filter === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><span id="nfcMatchCount" role="status">${matchingBooths().length}개</span></div>
      <div class="nfc-booth-list" id="nfcBoothList" aria-label="NFC 관리 부스 목록">${rows()}</div>
      ${editor()}
    </section>`;
  }

  function updateList() {
    const list = document.querySelector("#nfcBoothList");
    if (list) list.innerHTML = rows();
    const count = document.querySelector("#nfcMatchCount");
    if (count) count.textContent = `${matchingBooths().length}개`;
  }

  function updateDirty() {
    const booth = boothById(selectedId);
    if (!booth) return;
    const changed = dirty(booth);
    const status = document.querySelector("#nfcDraftStatus");
    if (status) status.textContent = changed ? "저장 전 변경 있음" : "저장된 설정";
    const save = document.querySelector("#nfcManagerSave");
    const discard = document.querySelector('[data-nfc-action="discard"]');
    if (save) save.disabled = !changed;
    if (discard) discard.disabled = !changed;
  }

  function showResult(id, result) {
    results.set(id, result);
    if (selectedId === id) {
      const region = document.querySelector("#nfcManagerResult");
      if (region) region.innerHTML = resultView(id);
    }
  }

  function refresh() {
    const root = document.querySelector("#nfcManager");
    if (!root) return;
    root.outerHTML = view();
    bind();
  }

  function save() {
    if (!allowed()) return false;
    const booth = boothById(selectedId);
    if (!booth) return false;
    const draft = draftFor(booth);
    const tag = draft.tag.trim().toUpperCase();
    const duplicate = state.db.booths.find(item => item.id !== booth.id && String(item.nfcTagId || "").toUpperCase() === tag);
    let error = !tagPattern.test(tag) ? "NFC- 다음에 영문, 숫자, 하이픈을 1~64자 입력해 주세요." : "";
    if (duplicate) error = `${nameFor(duplicate)}에 이미 등록된 태그입니다. 다른 ID를 사용해 주세요.`;
    if (!BOOTH_STATUS[draft.status]) error = "부스 운영 상태를 확인해 주세요.";
    if (error) { showResult(booth.id, { tone: "error", title: "저장하지 못했습니다", body: error }); return false; }
    const nextDb = { ...state.db, booths: state.db.booths.map(item => item.id === booth.id
      ? { ...item, nfcTagId: tag, nfcEnabled: draft.enabled, status: draft.status } : item) };
    if (!persistDb(nextDb)) {
      showResult(booth.id, { tone: "error", title: "기기 저장 공간을 확인해 주세요", body: "변경 내용을 저장하지 못했습니다. 기존 설정과 입력값을 유지합니다." });
      return false;
    }
    state.db = nextDb;
    drafts.delete(booth.id);
    showResult(booth.id, { tone: "success", title: "데모 설정을 저장했습니다", body: tag !== booth.nfcTagId
      ? "태그 ID가 변경되었습니다. 카드의 테스트 URL도 다시 기록해 주세요. 기존 스탬프는 유지됩니다."
      : "이 기기의 데모에 반영했습니다. 기존 스탬프는 유지됩니다." });
    refresh();
    return true;
  }

  function check(id) {
    if (!allowed()) return null;
    const booth = boothById(id);
    if (!booth) return null;
    if (dirty(booth)) { showResult(id, { tone: "error", title: "변경 내용을 먼저 저장해 주세요", body: "점검과 모의 적립은 저장된 설정으로 진행합니다." }); return null; }
    const checks = [
      { ok: tagPattern.test(booth.nfcTagId || ""), label: "태그 ID 형식" },
      { ok: state.db.booths.filter(item => String(item.nfcTagId || "").toUpperCase() === String(booth.nfcTagId || "").toUpperCase()).length === 1, label: "부스와 태그가 1:1로 연결됨" },
      { ok: booth.nfcEnabled !== false, label: "NFC 적립 허용" },
      { ok: booth.status === "open", label: "부스 운영 중" },
      { ok: ["active", "rehearsal"].includes(state.db.event.status) && !state.db.event.emergencyMode, label: "행사 적립 가능" },
    ];
    const ok = checks.every(item => item.ok);
    showResult(id, { tone: ok ? "success" : "error", title: ok ? "설정 점검 통과" : "확인이 필요한 설정이 있습니다", body: "스탬프는 추가하지 않았습니다. 실물 카드 인식 검사는 별도입니다.", checks });
    return { ok, checks };
  }

  async function simulate(id) {
    if (!allowed() || busy || !check(id)?.ok) return;
    const booth = boothById(id);
    const actor = state.user.id;
    busy = true;
    const button = document.querySelector('[data-nfc-action="simulate"]');
    if (button) button.disabled = true;
    try {
      const result = await nfcAdapter.scan(createNfcClaim(mockNfcTokenForTagId(booth.nfcTagId), "mock-panel"));
      if (!allowed() || state.user.id !== actor) return;
      showResult(id, { tone: result.ok ? "success" : "error", title: result.ok
        ? result.result === "ALREADY_EARNED" ? "중복 방지 확인" : "모의 적립 성공"
        : "모의 적립 실패", body: result.ok ? "현재 관리자 데모 계정으로 확인했습니다. 학생 기록과 서버에는 반영하지 않았습니다." : result.message });
    } catch {
      if (allowed() && state.user.id === actor) showResult(id, { tone: "error", title: "점검을 완료하지 못했습니다", body: "결과를 확인한 뒤 다시 시도해 주세요." });
    } finally { busy = false; if (button?.isConnected) button.disabled = false; }
  }

  async function copyUrl(id) {
    if (!allowed()) return;
    const booth = boothById(id);
    if (!booth?.nfcTagId) return;
    if (dirty(booth)) { showResult(id, { tone: "error", title: "변경 내용을 먼저 저장해 주세요", body: "복사할 URL은 저장된 태그 ID를 사용합니다." }); return; }
    try {
      await navigator.clipboard.writeText(demoUrl(booth));
      showResult(id, { tone: "success", title: "데모 URL 복사 완료", body: "실제 서버용 태그가 아닙니다. 같은 설정의 개인 웹 데모에서 사용하세요." });
    } catch {
      const input = document.querySelector("#nfcDemoUrl");
      input?.focus(); input?.select();
      showResult(id, { tone: "info", title: "URL을 선택했습니다", body: "자동 복사를 사용할 수 없습니다. 선택한 URL을 직접 복사해 주세요." });
    }
  }

  function bind() {
    const root = document.querySelector("#nfcManager");
    if (!root || root.dataset.bound || !allowed()) return;
    root.dataset.bound = "true";
    const search = root.querySelector("#nfcManagerSearch");
    let composing = false;
    search.addEventListener("compositionstart", () => { composing = true; });
    search.addEventListener("compositionend", () => { composing = false; query = search.value; updateList(); });
    search.addEventListener("input", event => { if (!composing && !event.isComposing) { query = search.value; updateList(); } });
    root.addEventListener("input", event => {
      const booth = boothById(selectedId);
      if (booth && event.target.id === "nfcManagerTag") { draftFor(booth).tag = event.target.value; updateDirty(); }
    });
    root.addEventListener("change", event => {
      if (event.target.id === "nfcManagerFloor") { floor = event.target.value; updateList(); }
      if (event.target.id === "nfcManagerFilter") { filter = event.target.value; updateList(); }
      const booth = boothById(selectedId);
      if (!booth) return;
      if (event.target.id === "nfcManagerStatus") draftFor(booth).status = event.target.value;
      if (event.target.id === "nfcManagerEnabled") draftFor(booth).enabled = event.target.checked;
      updateDirty();
    });
    root.addEventListener("submit", event => { event.preventDefault(); save(); });
    root.addEventListener("click", event => {
      const select = event.target.closest("[data-nfc-select]");
      if (select) {
        selectedId = select.dataset.nfcSelect;
        refresh();
        document.querySelector(".nfc-editor")?.scrollIntoView({ block: "start", behavior: "auto" });
        document.querySelector("#nfcEditorTitle")?.focus({ preventScroll: true });
        return;
      }
      const action = event.target.closest("[data-nfc-action]")?.dataset.nfcAction;
      const booth = boothById(selectedId);
      if (!booth || !allowed()) return;
      if (action === "generate") {
        draftFor(booth).tag = `NFC-${makeId().replace(/[^A-Za-z0-9]/g, "").slice(0, 16).toUpperCase()}`;
        const input = root.querySelector("#nfcManagerTag"); input.value = draftFor(booth).tag; input.focus(); updateDirty();
      }
      if (action === "discard") { drafts.delete(booth.id); results.delete(booth.id); refresh(); }
      if (action === "check") check(booth.id);
      if (action === "simulate") simulate(booth.id);
      if (action === "copy") copyUrl(booth.id);
    });
  }

  return { view, bind, save, check, simulate,
    hasDrafts: () => allowed() && state.db.booths.some(booth => drafts.has(booth.id) && dirty(booth)),
    clear: () => { query = ""; floor = "all"; filter = "all"; selectedId = null; drafts = new Map(); results = new Map(); },
  };
})();
