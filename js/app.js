/* app.js — 画面遷移とクイズの進行 */
(function () {
  'use strict';

  const TYPE_LABEL = {
    choice: '四択・選択',
    multi: '複数選択',
    order: '並び替え',
    tf: '正誤(○×)',
    flash: 'カード(自己採点)',
  };

  const state = {
    decks: [],     // {file, deck}
    session: null, // {deckEntry, questions, index, results, startedAt, mode}
  };

  const $ = sel => document.querySelector(sel);

  function show(viewId) {
    ['view-home', 'view-quiz', 'view-result'].forEach(id => {
      document.getElementById(id).hidden = (id !== viewId);
    });
    window.scrollTo(0, 0);
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------- データ読み込み ----------

  async function loadDecks() {
    const res = await fetch('data/index.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`data/index.json を取得できません (${res.status})`);
    const manifest = await res.json();
    const files = manifest.decks || [];
    const decks = [];
    for (const file of files) {
      try {
        const r = await fetch(file, { cache: 'no-cache' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const deck = LXParser.parseDeck(await r.text());
        deck.warnings.forEach(w => console.warn(`[${file}] ${w}`));
        if (deck.questions.length > 0) decks.push({ file, deck });
        else console.warn(`[${file}] 問題が1問も見つかりませんでした`);
      } catch (e) {
        console.error(`デッキ読み込み失敗: ${file}`, e);
      }
    }
    return decks;
  }

  // ---------- ホーム画面 ----------

  function renderHome() {
    const container = $('#deck-list');
    if (state.decks.length === 0) {
      container.innerHTML =
        '<div class="card empty-card"><p>デッキが見つかりません。</p>' +
        '<p><code>data/</code> に Markdown ファイルを置き、<code>data/index.json</code> に追記してください。</p></div>';
      return;
    }

    container.innerHTML = '';
    for (const entry of state.decks) {
      const { file, deck } = entry;
      const stats = LXStore.getStats(file);
      const wrongIds = LXStore.getWrongIds(file);
      const wrongCount = deck.questions.filter(q => wrongIds.has(q.id)).length;

      const typeCounts = {};
      deck.questions.forEach(q => { typeCounts[q.type] = (typeCounts[q.type] || 0) + 1; });
      const typeBadges = Object.entries(typeCounts)
        .map(([t, n]) => `<span class="badge">${TYPE_LABEL[t]} ${n}</span>`).join('');

      // 章(カテゴリ)一覧
      const catCounts = {};
      deck.questions.forEach(q => { if (q.category) catCounts[q.category] = (catCounts[q.category] || 0) + 1; });
      const cats = Object.keys(catCounts);

      const card = document.createElement('div');
      card.className = 'card deck-card';
      card.innerHTML = `
        <h2 class="deck-title">${LXParser.inlineMd(deck.title)}</h2>
        <div class="deck-desc">${deck.descriptionHtml}</div>
        <div class="deck-meta">
          <span class="badge badge-count">全 ${deck.questions.length} 問</span>
          ${typeBadges}
        </div>
        <div class="deck-stats">
          ${stats.attempts > 0
            ? `挑戦 ${stats.attempts} 回 ／ 前回 ${stats.last}% ／ 自己ベスト ${stats.best}%`
            : 'まだ挑戦していません'}
        </div>
        <div class="deck-filter"></div>
        <div class="deck-actions"></div>`;

      // 章フィルタ(章が2つ以上あるデッキのみ)
      let select = null;
      if (cats.length > 1) {
        const filter = card.querySelector('.deck-filter');
        const lbl = document.createElement('label');
        lbl.className = 'chapter-label';
        lbl.textContent = '出題範囲: ';
        select = document.createElement('select');
        select.className = 'chapter-select';
        select.innerHTML = `<option value="">全範囲 (${deck.questions.length}問)</option>` +
          cats.map(c => `<option value="${c.replace(/"/g, '&quot;')}">${c} (${catCounts[c]}問)</option>`).join('');
        lbl.appendChild(select);
        filter.appendChild(lbl);
      }
      const currentCategory = () => (select ? select.value : '');
      const filteredCount = () => {
        const c = currentCategory();
        return c ? catCounts[c] : deck.questions.length;
      };

      const actions = card.querySelector('.deck-actions');
      const mkBtn = (label, cls, handler) => {
        const b = document.createElement('button');
        b.className = cls;
        b.textContent = label;
        b.addEventListener('click', handler);
        actions.appendChild(b);
        return b;
      };
      mkBtn('▶ 順番に解く', 'btn btn-primary', () => startQuiz(entry, 'normal', { category: currentCategory() }));
      mkBtn('🔀 シャッフル', 'btn', () => startQuiz(entry, 'shuffle', { category: currentCategory() }));

      // 大きいデッキはランダム抜き出しモード
      const randomBtn = mkBtn('🎲 ランダム20問', 'btn', () => startQuiz(entry, 'shuffle', { category: currentCategory(), limit: 20 }));
      const syncRandom = () => { randomBtn.hidden = filteredCount() <= 20; };
      syncRandom();
      if (select) select.addEventListener('change', syncRandom);

      if (wrongCount > 0) {
        mkBtn(`🔁 間違いを復習 (${wrongCount})`, 'btn btn-review', () => startQuiz(entry, 'review', {}));
      }
      container.appendChild(card);
    }
  }

  // ---------- クイズの準備 ----------

  function prepareQuestion(q) {
    const p = { src: q };
    if (q.type === 'choice' || q.type === 'multi') {
      p.choices = shuffle(q.choices.map((c, i) => ({ html: c.html, correct: c.correct, srcIndex: i })));
      p.selected = new Set();
    } else if (q.type === 'order') {
      const idx = q.items.map((_, i) => i);
      let arranged = shuffle(idx);
      for (let tries = 0; tries < 10 && arranged.every((v, i) => v === i); tries++) {
        arranged = shuffle(idx);
      }
      p.arranged = arranged;
    } else if (q.type === 'flash') {
      p.revealed = false;
    }
    return p;
  }

  function startQuiz(deckEntry, mode, opts) {
    opts = opts || {};
    let questions = deckEntry.deck.questions.slice();

    if (mode === 'review') {
      const wrongIds = LXStore.getWrongIds(deckEntry.file);
      questions = shuffle(questions.filter(q => wrongIds.has(q.id)));
    } else {
      if (opts.category) questions = questions.filter(q => q.category === opts.category);
      if (mode === 'shuffle') questions = shuffle(questions);
      if (opts.limit && questions.length > opts.limit) questions = questions.slice(0, opts.limit);
    }
    if (questions.length === 0) return;

    state.session = {
      deckEntry,
      mode,
      opts,
      questions: questions.map(prepareQuestion),
      index: 0,
      results: [],
      startedAt: Date.now(),
    };
    show('view-quiz');
    renderQuestion();
  }

  // ---------- 出題 ----------

  function renderQuestion() {
    const s = state.session;
    const p = s.questions[s.index];
    const q = p.src;

    $('#progress-label').textContent = `${s.index + 1} / ${s.questions.length}`;
    $('#progress-fill').style.width = `${(s.index / s.questions.length) * 100}%`;

    const area = $('#question-area');
    area.innerHTML = `
      <div class="card question-card">
        <div class="q-badges">
          <span class="q-type-badge badge">${TYPE_LABEL[q.type]}</span>
          ${q.category ? `<span class="badge badge-cat">${LXParser.inlineMd(q.category)}</span>` : ''}
        </div>
        <h2 class="q-prompt">${q.promptHtml}</h2>
        ${q.bodyHtml ? `<div class="q-body">${q.bodyHtml}</div>` : ''}
        <div class="q-answers" id="q-answers"></div>
        <div class="q-feedback" id="q-feedback" hidden></div>
        <div class="q-actions" id="q-actions"></div>
      </div>`;

    const answers = $('#q-answers');
    const actions = $('#q-actions');

    if (q.type === 'choice') {
      p.choices.forEach((c, i) => {
        const b = document.createElement('button');
        b.className = 'choice-btn';
        b.dataset.index = i;
        b.innerHTML = `<span class="choice-key">${i + 1}</span><span class="choice-text">${c.html}</span>`;
        b.addEventListener('click', () => judgeChoice(i));
        answers.appendChild(b);
      });
    } else if (q.type === 'multi') {
      p.choices.forEach((c, i) => {
        const label = document.createElement('label');
        label.className = 'choice-btn choice-check';
        label.innerHTML = `<input type="checkbox" data-index="${i}"><span class="choice-key">${i + 1}</span><span class="choice-text">${c.html}</span>`;
        label.querySelector('input').addEventListener('change', ev => {
          if (ev.target.checked) p.selected.add(i); else p.selected.delete(i);
          label.classList.toggle('selected', ev.target.checked);
        });
        answers.appendChild(label);
      });
      const submit = document.createElement('button');
      submit.className = 'btn btn-primary';
      submit.textContent = '回答する';
      submit.addEventListener('click', judgeMulti);
      actions.appendChild(submit);
    } else if (q.type === 'tf') {
      const wrap = document.createElement('div');
      wrap.className = 'tf-buttons';
      [['○', true], ['×', false]].forEach(([label, val]) => {
        const b = document.createElement('button');
        b.className = 'tf-btn ' + (val ? 'tf-true' : 'tf-false');
        b.textContent = label;
        b.addEventListener('click', () => judgeTf(val));
        wrap.appendChild(b);
      });
      answers.appendChild(wrap);
    } else if (q.type === 'order') {
      renderOrderList(p, answers);
      const submit = document.createElement('button');
      submit.className = 'btn btn-primary';
      submit.textContent = 'この順番で回答する';
      submit.addEventListener('click', judgeOrder);
      actions.appendChild(submit);
    } else if (q.type === 'flash') {
      renderFlash(p, answers, actions);
    }
  }

  function renderFlash(p, answers, actions) {
    answers.innerHTML = `<div class="flash-back" id="flash-back" hidden>
      <div class="flash-back-label">答え</div>${p.src.backHtml}</div>`;
    const reveal = document.createElement('button');
    reveal.className = 'btn btn-primary';
    reveal.textContent = '答えを見る';
    reveal.addEventListener('click', () => revealFlash(p));
    actions.appendChild(reveal);
  }

  function revealFlash(p) {
    if (p.revealed) return;
    p.revealed = true;
    $('#flash-back').hidden = false;
    const actions = $('#q-actions');
    actions.innerHTML = `<span class="flash-ask">正解できた?</span>`;
    const mk = (label, cls, correct) => {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = label;
      b.addEventListener('click', () => { if (!p.answered) finishJudge(correct, ''); });
      actions.appendChild(b);
    };
    mk('⭕ できた', 'btn btn-grade-ok', true);
    mk('❌ できなかった', 'btn btn-grade-ng', false);
  }

  function renderOrderList(p, container) {
    container.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'order-list';
    p.arranged.forEach((srcIdx, pos) => {
      const row = document.createElement('div');
      row.className = 'order-item';
      row.innerHTML = `
        <span class="order-num">${pos + 1}</span>
        <span class="order-text">${p.src.items[srcIdx]}</span>
        <span class="order-controls">
          <button class="icon-btn" ${pos === 0 ? 'disabled' : ''} aria-label="上へ">▲</button>
          <button class="icon-btn" ${pos === p.arranged.length - 1 ? 'disabled' : ''} aria-label="下へ">▼</button>
        </span>`;
      const [up, down] = row.querySelectorAll('button');
      up.addEventListener('click', () => {
        [p.arranged[pos - 1], p.arranged[pos]] = [p.arranged[pos], p.arranged[pos - 1]];
        renderOrderList(p, container);
      });
      down.addEventListener('click', () => {
        [p.arranged[pos + 1], p.arranged[pos]] = [p.arranged[pos], p.arranged[pos + 1]];
        renderOrderList(p, container);
      });
      list.appendChild(row);
    });
    container.appendChild(list);
  }

  // ---------- 判定 ----------

  function judgeChoice(selectedIdx) {
    const p = currentQuestion();
    if (p.answered) return;
    const correct = p.choices[selectedIdx].correct;
    document.querySelectorAll('.choice-btn').forEach((btn, i) => {
      btn.disabled = true;
      if (p.choices[i].correct) btn.classList.add('correct');
      else if (i === selectedIdx) btn.classList.add('wrong');
    });
    finishJudge(correct, `あなたの回答: ${p.choices[selectedIdx].html}`);
  }

  function judgeMulti() {
    const p = currentQuestion();
    if (p.answered) return;
    const correctSet = new Set(p.choices.map((c, i) => c.correct ? i : -1).filter(i => i >= 0));
    const correct = p.selected.size === correctSet.size && [...p.selected].every(i => correctSet.has(i));
    document.querySelectorAll('.choice-btn').forEach((el, i) => {
      el.querySelector('input').disabled = true;
      if (p.choices[i].correct) el.classList.add('correct');
      else if (p.selected.has(i)) el.classList.add('wrong');
    });
    $('#q-actions').innerHTML = '';
    finishJudge(correct, `正解は ${correctSet.size} 個の選択肢です`);
  }

  function judgeTf(answer) {
    const p = currentQuestion();
    if (p.answered) return;
    const correct = answer === p.src.answer;
    document.querySelectorAll('.tf-btn').forEach(b => {
      b.disabled = true;
      const isTrue = b.classList.contains('tf-true');
      if (isTrue === p.src.answer) b.classList.add('correct');
      else if (isTrue === answer) b.classList.add('wrong');
    });
    finishJudge(correct, `正解: ${p.src.answer ? '○' : '×'}`);
  }

  function judgeOrder() {
    const p = currentQuestion();
    if (p.answered) return;
    const correct = p.arranged.every((v, i) => v === i);
    document.querySelectorAll('.order-item').forEach((row, pos) => {
      row.classList.add(p.arranged[pos] === pos ? 'correct' : 'wrong');
      row.querySelectorAll('button').forEach(b => b.disabled = true);
    });
    $('#q-actions').innerHTML = '';
    const correctOrder = p.src.items.map((t, i) => `${i + 1}. ${t}`).join('<br>');
    finishJudge(correct, `<details ${correct ? '' : 'open'}><summary>正しい順番</summary><div class="order-answer">${correctOrder}</div></details>`);
  }

  function currentQuestion() {
    return state.session.questions[state.session.index];
  }

  function finishJudge(correct, detailHtml) {
    const s = state.session;
    const p = currentQuestion();
    p.answered = true;
    s.results.push({ q: p.src, correct });

    const fb = $('#q-feedback');
    fb.hidden = false;
    fb.className = 'q-feedback ' + (correct ? 'fb-correct' : 'fb-wrong');
    fb.innerHTML = `
      <div class="fb-verdict">${correct ? '⭕ 正解！' : '❌ 不正解…'}</div>
      ${detailHtml ? `<div class="fb-detail">${detailHtml}</div>` : ''}
      ${p.src.explanationHtml ? `<div class="fb-explanation"><div class="fb-exp-label">💡 解説</div>${p.src.explanationHtml}</div>` : ''}`;

    const actions = $('#q-actions');
    actions.innerHTML = '';
    const next = document.createElement('button');
    next.className = 'btn btn-primary btn-next';
    next.textContent = s.index + 1 < s.questions.length ? '次の問題へ →' : '結果を見る';
    next.addEventListener('click', nextQuestion);
    actions.appendChild(next);
    next.focus();
    next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function nextQuestion() {
    const s = state.session;
    if (s.index + 1 < s.questions.length) {
      s.index += 1;
      renderQuestion();
    } else {
      finishSession();
    }
  }

  // ---------- 結果 ----------

  function finishSession() {
    const s = state.session;
    const total = s.results.length;
    const correctCount = s.results.filter(r => r.correct).length;
    const score = Math.round((correctCount / total) * 100);
    const elapsed = Math.round((Date.now() - s.startedAt) / 1000);
    const deckId = s.deckEntry.file;

    LXStore.recordResult(deckId, correctCount, total);
    LXStore.updateWrong(
      deckId,
      s.results.filter(r => !r.correct).map(r => r.q.id),
      s.results.filter(r => r.correct).map(r => r.q.id)
    );

    const msg = score === 100 ? '🎉 パーフェクト！'
      : score >= 80 ? '🌟 すばらしい！'
      : score >= 60 ? '👍 あと少し！'
      : '💪 復習して再挑戦しよう';

    const reviewRows = s.results.map((r, i) => `
      <details class="result-row ${r.correct ? 'row-correct' : 'row-wrong'}">
        <summary><span class="row-mark">${r.correct ? '○' : '×'}</span> ${i + 1}. ${r.q.promptHtml}</summary>
        <div class="row-detail">
          ${r.q.bodyHtml || ''}
          ${r.q.backHtml ? `<div class="fb-explanation"><div class="fb-exp-label">答え</div>${r.q.backHtml}</div>` : ''}
          ${r.q.explanationHtml ? `<div class="fb-explanation"><div class="fb-exp-label">💡 解説</div>${r.q.explanationHtml}</div>` : (r.q.backHtml ? '' : '<p class="muted">(解説なし)</p>')}
        </div>
      </details>`).join('');

    const wrongRemain = LXStore.getWrongIds(deckId);
    const wrongCount = s.deckEntry.deck.questions.filter(q => wrongRemain.has(q.id)).length;

    $('#result-area').innerHTML = `
      <div class="card result-card">
        <h2>結果 — ${LXParser.inlineMd(s.deckEntry.deck.title)}</h2>
        <div class="score-circle ${score >= 80 ? 'score-high' : score >= 60 ? 'score-mid' : 'score-low'}">
          <span class="score-num">${score}</span><span class="score-unit">%</span>
        </div>
        <p class="score-msg">${msg}</p>
        <p class="score-detail">${correctCount} / ${total} 問正解 ・ 所要時間 ${Math.floor(elapsed / 60)}分${elapsed % 60}秒</p>
        <div class="result-actions">
          ${wrongCount > 0 ? `<button class="btn btn-review" id="btn-retry-wrong">🔁 間違いを復習 (${wrongCount})</button>` : ''}
          <button class="btn btn-primary" id="btn-retry">もう一度</button>
          <button class="btn" id="btn-home">ホームへ</button>
        </div>
      </div>
      <div class="card">
        <h3>問題の振り返り</h3>
        ${reviewRows}
      </div>`;

    const entry = s.deckEntry;
    const mode = s.mode;
    const opts = s.opts;
    $('#btn-retry').addEventListener('click', () => startQuiz(entry, mode === 'review' ? 'shuffle' : mode, opts));
    $('#btn-home').addEventListener('click', goHome);
    const retryWrong = $('#btn-retry-wrong');
    if (retryWrong) retryWrong.addEventListener('click', () => startQuiz(entry, 'review', {}));

    state.session = null;
    show('view-result');
  }

  function goHome() {
    state.session = null;
    renderHome();
    show('view-home');
  }

  // ---------- キーボードショートカット ----------

  function onKeydown(ev) {
    if (!state.session || document.getElementById('view-quiz').hidden) return;
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
    const p = currentQuestion();

    if (p.answered && ev.key === 'Enter') { ev.preventDefault(); nextQuestion(); return; }
    if (p.answered) return;

    if (p.src.type === 'flash') {
      if (!p.revealed && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); revealFlash(p); }
      else if (p.revealed && (ev.key === 'o' || ev.key === '1')) finishJudge(true, '');
      else if (p.revealed && (ev.key === 'x' || ev.key === '2')) finishJudge(false, '');
    } else if (p.src.type === 'choice' && /^[1-9]$/.test(ev.key)) {
      const idx = parseInt(ev.key, 10) - 1;
      if (idx < p.choices.length) judgeChoice(idx);
    } else if (p.src.type === 'tf') {
      if (ev.key === 'o' || ev.key === '1') judgeTf(true);
      if (ev.key === 'x' || ev.key === '2') judgeTf(false);
    }
  }

  // ---------- テーマ ----------

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('#btn-theme').textContent = theme === 'dark' ? '☀️' : '🌙';
  }

  function initTheme() {
    const saved = LXStore.getTheme();
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(saved || (prefersDark ? 'dark' : 'light'));
    $('#btn-theme').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      LXStore.setTheme(next);
      applyTheme(next);
    });
  }

  // ---------- 起動 ----------

  async function init() {
    initTheme();
    $('#btn-quit').addEventListener('click', () => {
      if (confirm('クイズを中断してホームに戻りますか？')) goHome();
    });
    $('#app-title').addEventListener('click', goHome);
    document.addEventListener('keydown', onKeydown);

    try {
      state.decks = await loadDecks();
      renderHome();
    } catch (e) {
      $('#deck-list').innerHTML =
        `<div class="card empty-card"><p>データの読み込みに失敗しました: ${e.message}</p>` +
        '<p>ローカルで確認する場合は <code>python3 -m http.server</code> などで配信してください(file:// では動きません)。</p></div>';
    }
  }

  init();
})();
