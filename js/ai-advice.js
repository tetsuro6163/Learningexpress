/* ai-advice.js — 学習データの集計と LLM(Claude API)によるアドバイス生成 */
(function () {
  'use strict';

  const API_URL = 'https://api.anthropic.com/v1/messages';
  const DEFAULT_MODEL = 'claude-opus-4-8';
  const MODELS = [
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8(高品質・推奨)' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6(バランス)' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5(高速・低コスト)' },
  ];

  // ---------- 共通ヘルパー ----------

  function stripHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return (div.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function truncate(text, len) {
    return text.length > len ? text.slice(0, len) + '…' : text;
  }

  function pct(correct, total) {
    return total > 0 ? Math.round((correct / total) * 100) : 0;
  }

  function dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  const TYPE_LABEL = {
    choice: '四択・選択', multi: '複数選択', order: '並び替え',
    tf: '正誤(○×)', flash: 'カード(自己採点)',
  };

  // ---------- 習得度の判定 ----------

  // 1問ごとの状態: mastered(2連続正解) / review(間違えたまま) / learning(学習中) / unseen(未学習)
  function questionState(q, qstats, wrongIds) {
    const st = qstats[q.id];
    if (!st || st.a === 0) return 'unseen';
    if (wrongIds.has(q.id)) return 'review';
    if (st.s >= 2) return 'mastered';
    return 'learning';
  }

  // デッキ全体の習得状況 {mastered, learning, review, unseen, total}
  function computeMastery(file, deck) {
    const qstats = LXStore.getQuestionStats(file);
    const wrongIds = LXStore.getWrongIds(file);
    const m = { mastered: 0, learning: 0, review: 0, unseen: 0, total: deck.questions.length };
    deck.questions.forEach(q => { m[questionState(q, qstats, wrongIds)] += 1; });
    return m;
  }

  // 学習ペース {streak: 連続学習日数, days30: 直近30日の学習日数, today: [解答数, 正解数]}
  function studyStreak() {
    const days = LXStore.getDailyActivity();
    const today = new Date();
    const todayKey = dateKey(today);

    let streak = 0;
    const cursor = new Date(today);
    if (!days[todayKey]) cursor.setDate(cursor.getDate() - 1); // 今日まだ未学習なら昨日から数える
    while (days[dateKey(cursor)]) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }

    let days30 = 0;
    const d = new Date(today);
    for (let i = 0; i < 30; i++) {
      if (days[dateKey(d)]) days30 += 1;
      d.setDate(d.getDate() - 1);
    }

    return { streak, days30, today: days[todayKey] || [0, 0] };
  }

  // ---------- 学習データの集計 ----------

  // decks: [{file, deck}] — 学習実績をAIに渡すテキストにまとめる
  function buildSummary(decks) {
    const lines = [];
    let hasData = false;

    // 全体: 目標・学習ペース
    const profile = LXStore.getProfile();
    const study = studyStreak();
    const headerLines = [];
    if (profile.goal) headerLines.push(`- 学習の目標: ${profile.goal}`);
    if (profile.examDate) {
      const diff = Math.ceil((new Date(profile.examDate) - new Date()) / 86400000);
      headerLines.push(`- 試験日: ${profile.examDate}${diff >= 0 ? `(あと${diff}日)` : ''}`);
    }
    if (study.days30 > 0) {
      headerLines.push(`- 学習ペース: 直近30日で${study.days30}日学習 / 現在${study.streak}日連続 / 今日${study.today[0]}問解答`);
    }
    if (headerLines.length > 0) {
      lines.push('■ 学習者プロフィール');
      lines.push(...headerLines, '');
    }

    for (const { file, deck } of decks) {
      const stats = LXStore.getStats(file);
      if (stats.attempts === 0) continue;
      hasData = true;

      const history = LXStore.getHistory(file);
      const qstats = LXStore.getQuestionStats(file);
      const wrongIds = LXStore.getWrongIds(file);
      const mastery = computeMastery(file, deck);

      lines.push(`■ デッキ「${stripHtml(LXParser.inlineMd(deck.title))}」(全${deck.questions.length}問)`);
      lines.push(`- 挑戦${stats.attempts}回 / 通算正答率 ${pct(stats.correct, stats.answered)}% (${stats.correct}/${stats.answered}) / 自己ベスト ${stats.best}% / 前回 ${stats.last}%`);
      lines.push(`- 習得状況: 習得済み${mastery.mastered}問 / 学習中${mastery.learning}問 / 要復習${mastery.review}問 / 未学習${mastery.unseen}問`);

      const recent = history.slice(-5);
      if (recent.length > 0) {
        const trend = recent.map(h => {
          const d = new Date(h.at);
          const scope = h.category ? `「${h.category}」` : (h.mode === 'review' ? '復習' : '全範囲');
          return `${d.getMonth() + 1}/${d.getDate()} ${scope} ${h.score}%`;
        }).join(' → ');
        lines.push(`- 直近のセッション: ${trend}`);
      }

      // 分野別の通算正答率(問題ごとの統計から集計)
      const catAgg = {};   // {cat: [正解, 解答]}
      const typeAgg = {};  // {type: [正解, 解答]}
      for (const q of deck.questions) {
        const st = qstats[q.id];
        if (!st) continue;
        const cat = q.category || '(分野なし)';
        (catAgg[cat] = catAgg[cat] || [0, 0])[0] += st.c;
        catAgg[cat][1] += st.a;
        (typeAgg[q.type] = typeAgg[q.type] || [0, 0])[0] += st.c;
        typeAgg[q.type][1] += st.a;
      }
      const cats = Object.entries(catAgg).filter(([, v]) => v[1] > 0)
        .sort((a, b) => pct(a[1][0], a[1][1]) - pct(b[1][0], b[1][1]));
      if (cats.length > 1) {
        lines.push('- 分野別正答率(低い順):');
        cats.forEach(([c, [ok, all]]) => lines.push(`  - ${c}: ${pct(ok, all)}% (${ok}/${all})`));
      }
      const types = Object.entries(typeAgg).filter(([, v]) => v[1] > 0);
      if (types.length > 1) {
        lines.push('- 形式別正答率: ' + types.map(([t, [ok, all]]) =>
          `${TYPE_LABEL[t] || t} ${pct(ok, all)}% (${ok}/${all})`).join('、'));
      }

      // 間違えている問題の中身(復習リスト ∪ 正答率50%未満)を正答率の低い順に
      const struggling = deck.questions
        .map(q => ({ q, st: qstats[q.id] }))
        .filter(({ q, st }) => st && st.a > 0 &&
          (wrongIds.has(q.id) || st.c / st.a < 0.5))
        .sort((a, b) => (a.st.c / a.st.a) - (b.st.c / b.st.a));
      if (struggling.length > 0) {
        lines.push('- 間違えている・苦手な問題(正答率の低い順):');
        struggling.slice(0, 15).forEach(({ q, st }) => {
          const cat = q.category ? `[${q.category}] ` : '';
          const repeat = st.a - st.c >= 2 ? ' ※繰り返し間違え' : '';
          lines.push(`  - ${cat}「${truncate(stripHtml(q.promptHtml), 60)}」(${st.a}回中${st.c}回正解)${repeat}`);
        });
        if (struggling.length > 15) lines.push(`  - …ほか${struggling.length - 15}問`);
      }

      // 安定して正解できている分野(得意の把握用)
      const strong = cats.filter(([, [ok, all]]) => all >= 3 && ok / all >= 0.8);
      if (strong.length > 0) {
        lines.push('- 安定して正解できている分野: ' +
          strong.map(([c, [ok, all]]) => `${c} (${pct(ok, all)}%)`).join('、'));
      }
      lines.push('');
    }

    return hasData ? lines.join('\n').trim() : null;
  }

  function buildPrompt(summary) {
    const profile = LXStore.getProfile();
    return [
      'あなたは資格試験・学習指導の経験豊富なコーチです。',
      '以下はクイズ学習アプリに記録された、私の学習データです。',
      '',
      '---',
      summary,
      '---',
      '',
      'このデータをもとに、日本語で次の4点をアドバイスしてください:',
      '1. **総評** — 現在の習熟度と伸びている点',
      '2. **弱点と間違いの傾向** — 「間違えている問題」のリストから共通点(分野・論点・問題形式)を読み取り、なぜ間違えやすいかの仮説を立てる',
      '3. **おすすめの学習順序** — どの分野・どの問題から優先的に取り組むべきか',
      `4. **次の学習プラン** — ${profile.examDate ? '試験日から逆算した' : '今後1週間の'}具体的な進め方(1日あたりの目安も)`,
      '',
      profile.goal || profile.examDate
        ? '学習者プロフィール(目標・試験日・学習ペース)を踏まえて、現実的なプランにしてください。'
        : '',
      '出力はMarkdownで、見出しと箇条書きを使って簡潔に。励ましの一言も添えてください。',
    ].filter(Boolean).join('\n');
  }

  // ---------- Claude API 呼び出し(ブラウザ直接・ユーザー自身のAPIキー) ----------

  async function requestAdvice(prompt) {
    const settings = LXStore.getAiSettings();
    if (!settings.apiKey) {
      throw new Error('APIキーが未設定です。右上の ⚙️ から設定してください。');
    }

    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': settings.apiKey,
          'anthropic-version': '2023-06-01',
          // ブラウザから直接呼び出すためのCORSオプトイン(キーは利用者自身のもの)
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: settings.model || DEFAULT_MODEL,
          max_tokens: 8000,
          thinking: { type: 'adaptive' },
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } catch (e) {
      throw new Error('通信に失敗しました。ネットワーク接続を確認してください。');
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error.message; } catch (e) { /* ignore */ }
      const msg = {
        401: 'APIキーが無効です。⚙️ 設定を確認してください。',
        403: 'このAPIキーには権限がありません。',
        429: 'レート制限中です。しばらく待ってから再試行してください。',
        529: 'APIが混雑しています。しばらく待ってから再試行してください。',
      }[res.status];
      throw new Error(msg || `APIエラー (${res.status})${detail ? ': ' + detail : ''}`);
    }

    const data = await res.json();
    if (data.stop_reason === 'refusal') {
      throw new Error('AIがこのリクエストへの回答を控えました。');
    }
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');
    if (!text) throw new Error('AIから有効な応答が得られませんでした。');
    return text;
  }

  // ---------- アドバイス(Markdown)の安全なHTML化 ----------

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function inline(s) {
    return escapeHtml(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  }

  function mdToHtml(md) {
    const out = [];
    let listType = null; // 'ul' | 'ol' | null
    const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };

    for (const raw of md.split('\n')) {
      const line = raw.trimEnd();
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (h) {
        closeList();
        const level = Math.min(h[1].length + 2, 5); // # → h3 に格下げ(カード内見出し)
        out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      } else if (ul) {
        if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
        out.push(`<li>${inline(ul[1])}</li>`);
      } else if (ol) {
        if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
        out.push(`<li>${inline(ol[1])}</li>`);
      } else if (line.trim() === '') {
        closeList();
      } else {
        closeList();
        out.push(`<p>${inline(line)}</p>`);
      }
    }
    closeList();
    return out.join('\n');
  }

  function formatDateTime(ts) {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // ---------- アドバイスパネルのUI ----------

  // container にアドバイスUIを描画。decks は [{file, deck}]
  function renderPanel(container, decks) {
    if (!container) return;
    const summary = buildSummary(decks);
    container.innerHTML = '';

    const card = document.createElement('div');
    card.className = 'card advice-card';

    if (!summary) {
      card.innerHTML = `
        <h3><span class="advice-icon">🤖</span> AI学習アドバイス</h3>
        <p class="muted">クイズに挑戦すると、正解状況や間違いの傾向をもとにAIが学習アドバイスを生成できます。</p>`;
      container.appendChild(card);
      return;
    }

    const hasKey = !!LXStore.getAiSettings().apiKey;
    card.innerHTML = `
      <h3><span class="advice-icon">🤖</span> AI学習アドバイス</h3>
      <p class="muted advice-lead">これまでの正解状況・間違いの傾向・分野別の成績をもとに、弱点分析と学習順序のアドバイスを生成します。</p>
      <div class="advice-actions">
        <button class="btn btn-primary" id="btn-advice-generate">✨ アドバイスを生成</button>
        <button class="btn" id="btn-advice-copy" title="APIキーなしでも、プロンプトをコピーして ChatGPT や Claude に貼り付ければ同じアドバイスが得られます">📋 プロンプトをコピー</button>
      </div>
      ${hasKey ? '' : '<p class="advice-hint muted">「生成」には Anthropic APIキーが必要です(右上の ⚙️ から設定)。キーがなくても「プロンプトをコピー」して ChatGPT / Claude に貼り付ければ利用できます。</p>'}
      <div class="advice-output" id="advice-output" hidden></div>`;
    container.appendChild(card);

    const output = card.querySelector('#advice-output');
    const genBtn = card.querySelector('#btn-advice-generate');
    const copyBtn = card.querySelector('#btn-advice-copy');

    // 前回のアドバイスがあれば表示しておく
    const last = LXStore.getLastAdvice();
    if (last && last.text) {
      output.hidden = false;
      output.innerHTML = `
        <p class="advice-meta">前回のアドバイス(${formatDateTime(last.at)}生成)</p>
        <div class="advice-md">${mdToHtml(last.text)}</div>`;
    }

    genBtn.addEventListener('click', async () => {
      output.hidden = false;
      output.innerHTML = '<p class="muted advice-loading"><span class="spinner"></span> 学習データを分析中… (10〜60秒ほどかかります)</p>';
      genBtn.disabled = true;
      try {
        const advice = await requestAdvice(buildPrompt(buildSummary(decks)));
        LXStore.setLastAdvice({ at: Date.now(), text: advice });
        output.innerHTML = `<div class="advice-md">${mdToHtml(advice)}</div>`;
      } catch (e) {
        output.innerHTML = `<p class="advice-error">⚠️ ${escapeHtml(e.message)}</p>`;
      } finally {
        genBtn.disabled = false;
      }
    });

    copyBtn.addEventListener('click', async () => {
      const prompt = buildPrompt(buildSummary(decks));
      try {
        await navigator.clipboard.writeText(prompt);
        copyBtn.textContent = '✅ コピーしました';
      } catch (e) {
        // クリップボードAPIが使えない場合はテキストエリアで表示
        output.hidden = false;
        output.innerHTML = `<p class="muted">以下を選択してコピーし、ChatGPT や Claude に貼り付けてください:</p>
          <textarea class="advice-prompt-text" readonly rows="10"></textarea>`;
        output.querySelector('textarea').value = prompt;
      }
      setTimeout(() => { copyBtn.textContent = '📋 プロンプトをコピー'; }, 2000);
    });
  }

  // ---------- 設定モーダル ----------

  function openSettings() {
    const existing = document.getElementById('ai-settings-overlay');
    if (existing) existing.remove();

    const settings = LXStore.getAiSettings();
    const profile = LXStore.getProfile();
    const overlay = document.createElement('div');
    overlay.id = 'ai-settings-overlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="card modal-card" role="dialog" aria-label="設定">
        <h3>⚙️ 設定</h3>

        <p class="settings-section">🎯 学習の目標</p>
        <label class="settings-label">目標(任意)
          <input type="text" id="profile-goal" class="settings-input" placeholder="例: 司法書士試験に合格する">
        </label>
        <label class="settings-label">試験日・締め切り(任意)
          <input type="date" id="profile-exam-date" class="settings-input">
        </label>
        <p class="muted settings-note">設定するとAIアドバイスが目標・残り日数を考慮したプランを提案します。</p>

        <p class="settings-section">🤖 AIアドバイス</p>
        <label class="settings-label">Anthropic APIキー
          <input type="password" id="ai-api-key" class="settings-input" placeholder="sk-ant-..." autocomplete="off">
        </label>
        <label class="settings-label">モデル
          <select id="ai-model" class="settings-input">
            ${MODELS.map(m => `<option value="${m.id}">${m.label}</option>`).join('')}
          </select>
        </label>
        <p class="muted settings-note">キーはこのブラウザの localStorage にのみ保存され、Anthropic API 以外には送信されません。共用PCでは保存しないでください。
        キーは <a href="https://platform.claude.com/" target="_blank" rel="noopener">Claude Platform</a> で発行できます(API利用は従量課金)。</p>

        <div class="modal-actions">
          <button class="btn" id="ai-settings-clear">キーを削除</button>
          <span class="modal-spacer"></span>
          <button class="btn" id="ai-settings-cancel">キャンセル</button>
          <button class="btn btn-primary" id="ai-settings-save">保存</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const keyInput = overlay.querySelector('#ai-api-key');
    const modelSelect = overlay.querySelector('#ai-model');
    const goalInput = overlay.querySelector('#profile-goal');
    const examInput = overlay.querySelector('#profile-exam-date');
    keyInput.value = settings.apiKey || '';
    modelSelect.value = settings.model || DEFAULT_MODEL;
    goalInput.value = profile.goal || '';
    examInput.value = profile.examDate || '';

    const close = () => overlay.remove();
    overlay.addEventListener('click', ev => { if (ev.target === overlay) close(); });
    overlay.querySelector('#ai-settings-cancel').addEventListener('click', close);
    overlay.querySelector('#ai-settings-clear').addEventListener('click', () => {
      LXStore.setAiSettings({ model: modelSelect.value });
      keyInput.value = '';
    });
    overlay.querySelector('#ai-settings-save').addEventListener('click', () => {
      LXStore.setAiSettings({ apiKey: keyInput.value.trim(), model: modelSelect.value });
      LXStore.setProfile({ goal: goalInput.value.trim(), examDate: examInput.value });
      close();
      // 目標の変更をホーム画面に反映
      document.dispatchEvent(new CustomEvent('lx:settings-changed'));
    });
    keyInput.focus();
  }

  window.LXAdvice = { renderPanel, openSettings, buildSummary, computeMastery, studyStreak };
})();
