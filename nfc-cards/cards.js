(async () => {
  const select = document.getElementById('clubSelect');
  const sheets = document.getElementById('cardSheets');
  const print = document.getElementById('printCards');
  const escape = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  print.disabled = true;
  try {
    const response = await fetch('/assets/stamps/catalog.json');
    if (!response.ok) throw new Error('CARD_CATALOG_UNAVAILABLE');
    const clubs = await response.json();
    select.insertAdjacentHTML('beforeend', clubs.map((club, i) => `<option value="${i}">${escape(club.name)}</option>`).join(''));
    function render() {
      const selected = select.value === 'all' ? clubs : [clubs[Number(select.value)]];
      const pages = [];
      for (let i = 0; i < selected.length; i += 8) {
        pages.push(`<section class="card-sheet">${selected.slice(i, i + 8).map(club => `<article class="nfc-print-card" aria-label="${escape(club.name)} NFC 카드"><header><strong>판교고 축제</strong><span>방문 스탬프</span></header><div class="card-club"><img src="/assets/stamps/${escape(club.file)}" alt="${escape(club.name)} 스탬프" width="256" height="256"><h2>${escape(club.name)}</h2></div><footer><span>휴대폰을 카드에 대 주세요</span>${FestivalIcons.scan}</footer></article>`).join('')}</section>`);
      }
      sheets.innerHTML = pages.join('');
    }
    select.addEventListener('change', render);
    print.innerHTML = FestivalIcons.external + ' 인쇄';
    print.addEventListener('click', () => window.print());
    render();
    print.disabled = false;
  } catch {
    sheets.innerHTML = '<p role="alert">카드를 불러오지 못했어요. 새로고침해 주세요.</p>';
  }
})();
