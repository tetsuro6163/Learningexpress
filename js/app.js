/* app.js — 画面遷移とクイズの進行 */
(function () {
  'use strict';

  // ---------- 用語ツールチップ ----------

  let tooltipEl = null;
  let activeGlossary = {};

  function initTooltip() {
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'glossary-tooltip';
    tooltipEl.className = 'glossary-tooltip';
    tooltipEl.hidden = true;
    tooltipEl.setAttribute('role', 'tooltip');
    tooltipEl.innerHTML =
      '<div class="gt-header">' +
        '<span class="gt-term"></span>' +
        '<button class="gt-close icon-btn" aria-label="閉じる">×</button>' +
      '</div>' +
      '<div class="gt-def"></div>';
    tooltipEl.querySelector('.gt-close').addEventListener('click', hideTooltip);
    document.body.appendChild(tooltipEl);

    document.addEventListener('click', ev => {
      const termEl = ev.target.closest('.glossary-term');
      if (termEl) {
        ev.stopPropagation();
        const term = termEl.dataset.term;
        if (!tooltipEl.hidden && tooltipEl.querySelector('.gt-term').textContent === term) {
          hideTooltip();
        } else {
          showTooltip(term, termEl);
        }
        return;
      }
      if (!tooltipEl.hidden && !tooltipEl.contains(ev.target)) hideTooltip();
    });

    document.addEventListener('keydown', ev => {
      if (ev.key === 'Escape' && !tooltipEl.hidden) { hideTooltip(); ev.preventDefault(); }
    });
  }

  function showTooltip(term, anchorEl) {
    if (!activeGlossary[term]) return;
    tooltipEl.querySelector('.gt-term').textContent = term;
    tooltipEl.querySelector('.gt-def').innerHTML = activeGlossary[term];
    tooltipEl.style.top = '-9999px';
    tooltipEl.style.left = '-9999px';
    tooltipEl.hidden = false;

    const rect = anchorEl.getBoundingClientRect();
    const tw = tooltipEl.offsetWidth;
    const th = tooltipEl.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 7;

    let top = rect.bottom + gap;
    if (top + th > vh - 8) top = rect.top - th - gap;
    if (top < 8) top = 8;

    let left = rect.left;
    if (left + tw > vw - 8) left = vw - tw - 8;
    if (left < 8) left = 8;

    tooltipEl.style.top = top + 'px';
    tooltipEl.style.left = left + 'px';
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.hidden = true;
  }

  function highlightGlossaryTerms(root, glossary) {
    if (!root || !glossary) return;
    const terms = Object.keys(glossary);
    if (terms.length === 0) return;
    activeGlossary = glossary;

    terms.sort((a, b) => b.length - a.length);
    const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const regex = new RegExp('(' + escaped.join('|') + ')', 'g');

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let el = node.parentElement;
        while (el && el !== root) {
          const tag = el.tagName;
          if (tag === 'CODE' || tag === 'PRE' || tag === 'SCRIPT' || tag === 'STYLE') {
            return NodeFilter.FILTER_REJECT;
          }
          if (el.classList.contains('glossary-term') || el.classList.contains('flash-term')) {
            return NodeFilter.FILTER_REJECT;
          }
          el = el.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const nodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (regex.test(node.textContent)) nodes.push(node);
      regex.lastIndex = 0;
    }

    for (const textNode of nodes) {
      const parts = textNode.textContent.split(regex);
      if (parts.length <= 1) continue;
      const frag = document.createDocumentFragment();
      for (const part of parts) {
        if (part === '') continue;
        if (glossary[part] !== undefined) {
          const span = document.createElement('span');
          span.className = 'glossary-term';
          span.textContent = part;
          span.dataset.term = part;
          frag.appendChild(span);
        } else {
          frag.appendChild(document.createTextNode(part));
        }
      }
      textNode.parentNode.replaceChild(frag, textNode);
    }
  }

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
      const el = document.getElementById(id);
      el.hidden = (id !== viewId);
      if (id === viewId) { // 表示時にフェードインを再生
        el.classList.remove('view-enter');
        void el.offsetWidth;
        el.classList.add('view-enter');
      }
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

  // 学習ステータス(連続日数・今日の学習量・通算成績・目標)
  function renderDashboard() {
    const container = $('#home-dash');
    let answered = 0, correct = 0;
    state.decks.forEach(({ file }) => {
      const st = LXStore.getStats(file);
      answered += st.answered;
      correct += st.correct;
    });
    if (answered === 0) { container.innerHTML = ''; return; }

    const study = LXAdvice.studyStreak();
    const profile = LXStore.getProfile();
    const accuracy = Math.round((correct / answered) * 100);

    let goalHtml = '';
    if (profile.goal || profile.examDate) {
      let countdown = '';
      if (profile.examDate) {
        const diff = Math.ceil((new Date(profile.examDate) - new Date()) / 86400000);
        countdown = diff >= 0 ? `<span class="dash-countdown">あと <strong>${diff}</strong> 日</span>` : '';
      }
      goalHtml = `<div class="dash-goal"><span class="dash-goal-text">🎯 ${profile.goal ? LXParser.inlineMd(profile.goal) : '試験日'}</span>${countdown}</div>`;
    }

    container.innerHTML = `
      <div class="card dash-card">
        ${goalHtml}
        <div class="dash-grid">
          <div class="dash-item">
            <span class="dash-num">${study.streak > 0 ? '🔥 ' : ''}${study.streak}<small>日</small></span>
            <span class="dash-label">連続学習</span>
          </div>
          <div class="dash-item">
            <span class="dash-num">${study.today[0]}<small>問</small></span>
            <span class="dash-label">今日の解答</span>
          </div>
          <div class="dash-item">
            <span class="dash-num">${answered}<small>問</small></span>
            <span class="dash-label">累計解答</span>
          </div>
          <div class="dash-item">
            <span class="dash-num">${accuracy}<small>%</small></span>
            <span class="dash-label">通算正答率</span>
          </div>
        </div>
      </div>`;
  }

  function masteryBarHtml(file, deck) {
    const m = LXAdvice.computeMastery(file, deck);
    if (m.mastered + m.learning + m.review === 0) return '';
    const seg = (n, cls) => n > 0 ? `<span class="m-seg ${cls}" style="width:${(n / m.total) * 100}%"></span>` : '';
    return `
      <div class="deck-mastery">
        <div class="mastery-bar">
          ${seg(m.mastered, 'm-mastered')}${seg(m.learning, 'm-learning')}${seg(m.review, 'm-review')}${seg(m.unseen, 'm-unseen')}
        </div>
        <div class="mastery-legend">
          <span class="m-dot m-mastered"></span>習得 ${m.mastered}
          <span class="m-dot m-learning"></span>学習中 ${m.learning}
          <span class="m-dot m-review"></span>要復習 ${m.review}
          <span class="m-dot m-unseen"></span>未学習 ${m.unseen}
        </div>
      </div>`;
  }

  function renderHome() {
    renderDashboard();
    LXAdvice.renderPanel($('#home-advice'), state.decks);
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
        ${masteryBarHtml(file, deck)}
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
      mkBtn('🧠 おまかせ特訓', 'btn btn-smart', () => startQuiz(entry, 'smart', { category: currentCategory() }));
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
    let prepared;

    if (mode === 'smart') {
      // 学習状況に適応した出題(間違えた問題・苦手・復習どきを優先)
      prepared = LXTrainer.select(deckEntry, { limit: opts.limit || 20, category: opts.category })
        .map(({ q, reason, focused }) => Object.assign(prepareQuestion(q), { reason, focused }));
    } else {
      let questions = deckEntry.deck.questions.slice();
      if (mode === 'review') {
        const wrongIds = LXStore.getWrongIds(deckEntry.file);
        questions = shuffle(questions.filter(q => wrongIds.has(q.id)));
      } else {
        if (opts.category) questions = questions.filter(q => q.category === opts.category);
        if (mode === 'shuffle') questions = shuffle(questions);
        if (opts.limit && questions.length > opts.limit) questions = questions.slice(0, opts.limit);
      }
      prepared = questions.map(prepareQuestion);
    }
    if (prepared.length === 0) return;

    activeGlossary = deckEntry.deck.glossary || {};
    state.session = {
      deckEntry,
      mode,
      opts,
      questions: prepared,
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
          ${p.reason ? `<span class="badge badge-reason">${LXTrainer.REASON_LABEL[p.reason] || ''}${p.focused ? ' ・🤖重点' : ''}</span>` : ''}
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
    highlightGlossaryTerms(area, activeGlossary);
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
    const flashBack = $('#flash-back');
    flashBack.hidden = false;
    highlightGlossaryTerms(flashBack, activeGlossary);
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
    highlightGlossaryTerms(fb, activeGlossary);

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
    LXStore.recordQuestionResults(deckId, s.results.map(r => ({ id: r.q.id, correct: r.correct })));
    LXStore.recordDailyActivity(total, correctCount);

    // 分野別・形式別の内訳を集計して履歴に残す
    const catBreak = {};
    const typeBreak = {};
    s.results.forEach(r => {
      const cat = r.q.category || '(分野なし)';
      (catBreak[cat] = catBreak[cat] || [0, 0])[1] += 1;
      if (r.correct) catBreak[cat][0] += 1;
      (typeBreak[r.q.type] = typeBreak[r.q.type] || [0, 0])[1] += 1;
      if (r.correct) typeBreak[r.q.type][0] += 1;
    });
    LXStore.recordSession(deckId, {
      at: Date.now(),
      mode: s.mode,
      category: s.opts.category || '',
      total, correct: correctCount, score,
      elapsedSec: elapsed,
      cats: catBreak,
      types: typeBreak,
    });

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

    // 今回のセッションの分野別正答率(分野が2つ以上ある場合のみ表示)
    const catEntries = Object.entries(catBreak);
    const catBars = catEntries.length > 1
      ? `<div class="card">
          <h3>分野別の成績(今回)</h3>
          ${catEntries.map(([cat, [ok, all]]) => {
            const rate = Math.round((ok / all) * 100);
            const cls = rate >= 80 ? 'bar-high' : rate >= 60 ? 'bar-mid' : 'bar-low';
            return `<div class="cat-row">
              <div class="cat-row-head"><span class="cat-name">${LXParser.inlineMd(cat)}</span><span class="cat-rate">${ok}/${all} (${rate}%)</span></div>
              <div class="cat-bar"><div class="cat-bar-fill ${cls}" style="width:${rate}%"></div></div>
            </div>`;
          }).join('')}
        </div>`
      : '';

    $('#result-area').innerHTML = `
      <div class="card result-card">
        <h2>結果 — ${LXParser.inlineMd(s.deckEntry.deck.title)}</h2>
        <div class="score-circle ${score >= 80 ? 'score-high' : score >= 60 ? 'score-mid' : 'score-low'}" style="--p:${score}">
          <div class="score-inner"><span class="score-num">${score}</span><span class="score-unit">%</span></div>
        </div>
        <p class="score-msg">${msg}</p>
        <p class="score-detail">${correctCount} / ${total} 問正解 ・ 所要時間 ${Math.floor(elapsed / 60)}分${elapsed % 60}秒</p>
        <div class="result-actions">
          ${wrongCount > 0 ? `<button class="btn btn-review" id="btn-retry-wrong">🔁 間違いを復習 (${wrongCount})</button>` : ''}
          <button class="btn btn-primary" id="btn-retry">もう一度</button>
          <button class="btn" id="btn-home">ホームへ</button>
        </div>
      </div>
      ${catBars}
      <div id="result-advice"></div>
      <div class="card">
        <h3>問題の振り返り</h3>
        ${reviewRows}
      </div>`;

    LXAdvice.renderPanel($('#result-advice'), state.decks);

    const entry = s.deckEntry;
    const mode = s.mode;
    const opts = s.opts;
    const resultGlossary = s.deckEntry.deck.glossary || {};
    $('#btn-retry').addEventListener('click', () => startQuiz(entry, mode === 'review' ? 'shuffle' : mode, opts));
    $('#btn-home').addEventListener('click', goHome);
    const retryWrong = $('#btn-retry-wrong');
    if (retryWrong) retryWrong.addEventListener('click', () => startQuiz(entry, 'review', {}));

    state.session = null;
    show('view-result');
    activeGlossary = resultGlossary;
    highlightGlossaryTerms($('#result-area'), resultGlossary);
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
    initTooltip();
    $('#btn-quit').addEventListener('click', () => {
      if (confirm('クイズを中断してホームに戻りますか？')) goHome();
    });
    $('#app-title').addEventListener('click', goHome);
    $('#btn-settings').addEventListener('click', () => LXAdvice.openSettings());
    document.addEventListener('lx:settings-changed', () => {
      if (!document.getElementById('view-home').hidden) renderHome();
    });
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
